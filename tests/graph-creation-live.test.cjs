const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { withLhatServer } = require('./lhat-server.cjs');
function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const api = load('graphStatements.ts'), expressions = load('graphExpressions.ts');
const flat = n => [n, ...Object.values(n.fields ?? {}).flat().flatMap(flat)];
const apply = (source, change) => source.slice(0, change.start) + change.text + source.slice(change.end);

test('yield and await expressions edit received results inside procedures and phantom yield keeps its complete marker', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    for (const [source, allowed] of [
        ['let^run=p^{let^value=0}', true], ['let^value=0', false],
        ['let^run=p^{let^inner=f^{return^0}}', false], ['let^run=f^{let^inner=p^{let^value=0}}', true],
        ['let^run=p^value:number^=0{}', false],
    ]) {
        const tree = await parse(source), value = flat(tree.root).findLast(n => n.kind === 'int'); assert(value, source);
        const choices = expressions.expressionTemplates(tree, value);
        for (const id of ['yield','await']) assert.equal(choices.some(c => c.id === id), allowed, source);
    }
    for (const id of ['yield','await']) {
        let tree = await parse('let^run=p^{let^value=0}');
        const binding = () => tree.root.fields.items[0].fields.values[0].fields.body.fields.items[0];
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, binding().fields.values[0], id)));
        let value = binding().fields.values[0]; assert.equal(value.kind, id);
        assert(expressions.expressionSites(tree).some(s => s.kind === id));
        if (id === 'yield') {
            tree = await parse(apply(tree.source, structures.editStructure(tree, value, 'yield:phantom')));
            value = binding().fields.values[0];
            assert(tree.source.includes('_yield^'));
            const graph = load('webview/map.ts').toElk(tree), flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
            assert(flatten(graph).some(n => n.lhat?.labelParts?.some(p => p.source === '_yield^' && p.text === 'Suspend')));
        }
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value, 'unwrap')));
        assert.equal(binding().fields.values[0].kind, 'int');
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    const tree = await parse('let^run=p^{yield^0 await^nil^}');
    assert(!expressions.expressionSites(tree).some(s => ['yield','await'].includes(s.kind)), 'standalone transfers retain their statement shape');
}));

test('mutable declarations edit member paths and introduction mode while immutable targets retain their grammar', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts'), input = { kind:'declarationPath', value:'value' };
    for (const path of ['value','`a b`','_^','table.member','table.`a.b`','L^.value','$table.member','$^table.member']) {
        assert(structure.validStructureInput(input, path), path);
        const tree = await parse('var^value:number^=0'), node = tree.root.fields.items[0];
        const change = structure.editStructure(tree, node, `binding:target:0:${path}`); assert(change, path);
        const updated = await parse(apply(tree.source, change));
        assert(!flat(updated.root).some(n => n.kind === 'error'), updated.source);
        assert.equal(updated.source, `var^${path}:number^=0`);
    }
    for (const path of ['table[0]','table?.member','self^.value','true^','L^','table.0','value;print(1)','value\nlet^x=0'])
        assert(!structure.validStructureInput(input, path), path);
    for (const source of ['var^value=0','var^table.member:number^=0','var^a,table.`b.c`=0,1']) {
        let tree = await parse(source), node = tree.root.fields.items[0];
        let change = structure.editStructure(tree, node, 'binding:existing'); assert(change);
        tree = await parse(apply(tree.source, change));
        assert(tree.source.includes(':='));
        change = structure.editStructure(tree, tree.root.fields.items[0], 'binding:existing'); assert(change);
        assert.equal(apply(tree.source, change), source);
    }
    for (const source of ['var^value:=0','var^value:number^ # keep\n:=0']) {
        const tree = await parse(source), change = structure.editStructure(tree, tree.root.fields.items[0], 'mutability'); assert(change);
        const updated = await parse(apply(source, change));
        assert(!flat(updated.root).some(n => n.kind === 'error'), updated.source);
        assert.equal(updated.source, source.replace('var^', 'let^').replace(':=', '='));
    }
    for (const source of ['var^table.member=0','var^table.member:number^=0','let^value=0']) {
        const tree = await parse(source), choices = structure.structureTemplates(tree, tree.root.fields.items[0]);
        if (source.startsWith('var^')) assert(!choices.some(c => c.id === 'mutability'));
        else assert(!choices.some(c => c.id.startsWith('binding:')));
    }
}));

test('loop transfers choose an enclosing loop without crossing callable or focus boundaries', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    for (const spelling of ['break^', 'next^^', 'skip^[2]', 'continue^^']) {
        const source = `repeat^2 {for^i from^0 to^2 {do^{${spelling} # keep\n}}}`;
        const tree = await parse(source), jump = flat(tree.root).find(n => ['break', 'next'].includes(n.kind));
        assert(structure.structureSites(tree).some(s => s.start === jump.start && s.end === jump.end));
        const choices = structure.structureTemplates(tree, jump);
        assert.deepEqual(choices.map(c => c.id), ['jump:break:1','jump:next:1','jump:break:2','jump:next:2']);
        assert.equal(structure.editStructure(tree, jump, 'jump:break:3'), undefined);
        for (const choice of choices) {
            const change = structure.editStructure(tree, jump, choice.id); assert(change);
            const updated = await parse(apply(source, change));
            assert(!flat(updated.root).some(n => n.kind === 'error'), updated.source);
            assert(updated.source.includes('# keep'));
            const target = flat(updated.root).find(n => ['break', 'next'].includes(n.kind));
            assert.equal(updated.source.slice(target.start, target.end), choice.text);
        }
    }
    for (const [source, count] of [
        ['repeat^2 {for^let^v=0 for^i from^0 to^2 {break^}}', 4],
        ['repeat^2 {for^let^v=0 if^true^{next^}}', 2],
        ['repeat^2 {let^p=p^{repeat^2 {next^}}}', 2],
        ['repeat^2 {let^p=p^{break^}}', 0],
    ]) {
        const tree = await parse(source), jump = flat(tree.root).find(n => ['break', 'next'].includes(n.kind));
        assert(jump, source);
        assert.equal(structure.structureTemplates(tree, jump).length, count, source);
    }
}));

test('quoted references, type names, type member keys and catch filters preserve their complete syntax', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts'), texts = load('graphTextFields.ts');
    for (const name of ['`a b`','`a``b`','`a.b`.`c|d`','obj.`a,b`','self^.`a b`']) {
        let tree = await parse('let^value=nil^');
        const site = expressions.expressionSites(tree).find(s => s.kind === 'hat-ident');
        const change = expressions.replaceExpression(tree, site, `reference:${name}`); assert(change, name);
        tree = await parse(apply(tree.source, change));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        assert(tree.source.includes(name));
    }
    let tree = await parse('let^read=f^x:t^{value:number^}{0}');
    const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    tree = await parse(apply(tree.source, structure.editStructure(tree, type(), 'type:rename:0:`a.b`')));
    assert(tree.source.includes('`a.b`:number^'));
    tree = await parse(apply(tree.source, structure.editStructure(tree, type(), 'type:reference:`module name`.`a.b`')));
    assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    tree = await parse('do^{catch^error^:}');
    const arm = tree.root.fields.items[0].fields.arms[0];
    tree = await parse(apply(tree.source, structure.editStructure(tree, arm, 'catch:filter:`problem|name`.`bad state` | Other')));
    assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    assert.equal(tree.root.fields.items[0].fields.arms[0].fields.condition.kind, 'type-union');
    for (const source of ['module^old.name','import^old.name','let^name=id^old']) {
        tree = await parse(source); const field = texts.textFields(tree).find(f => f.site.field !== 'comment');
        const change = texts.editTextField(tree, field.site, '`a.b`'); assert(change);
        tree = await parse(apply(tree.source, change));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    tree = await parse('let^value={["a`b"]=1}');
    const entry = tree.root.fields.items[0].fields.values[0].fields.items[0];
    tree = await parse(apply(tree.source, structure.editStructure(tree, entry, 'key:identifier')));
    assert(tree.source.includes('`a``b`=1'));
    assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    const namedEntry = tree.root.fields.items[0].fields.values[0].fields.items[0];
    tree = await parse(apply(tree.source, structure.editStructure(tree, namedEntry, 'key:string')));
    const stringKey = tree.root.fields.items[0].fields.values[0].fields.items[0].fields.key;
    assert.equal(load('webview/literals.ts').literalOf(stringKey, tree.source).value, 'a`b');

    tree = await parse('let^`option name`=1 for^1{when^`option name`:print(0)}');
    const pattern = load('graphPatterns.ts').patternLists(tree)[0].items[0];
    assert.equal(tree.source.slice(pattern.start, pattern.end), '`option name`');
    const replacement = expressions.replaceExpression(tree, pattern, 'reference:`other name`'); assert(replacement);
    tree = await parse(apply(tree.source, replacement));
    assert(tree.source.includes('when^`other name`:print(0)'), tree.source);

}));

test('source-backed quoted declarations rename through the real server and keep all references', { timeout: 30000 }, async () => withLhatServer(async (parse, server) => {
    const { graphHost, load } = require('./graph-browser-host.cjs'), { toElk } = load('webview/map.ts');
    const host = await graphHost(parse, server, 'let^value=1 print(value)');
    for (const name of ['`display name`','`日本 語`','`a``b`','normal']) {
        const target = host.tree.root.fields.items[0].fields.targets[0];
        await host.edit({ type:'rename', id:'quoted', start:target.start, end:target.end,
            oldName:host.tree.source.slice(target.start,target.end), newName:name, version:host.version });
        assert.equal(host.tree.source, `let^${name}=1 print(${name})`);
        const boxes = node => [node, ...(node.children ?? []).flatMap(boxes)];
        assert(boxes(toElk(host.tree)).flatMap(n => n.lhat?.labelParts ?? []).some(part => part.name?.value === name), 'the declaration remains an editable name');
    }
    const discard = await graphHost(parse, server, 'let^_^=1');
    const target = discard.tree.root.fields.items[0].fields.targets[0];
    await discard.edit({ type:'rename', id:'materialize', start:target.start, end:target.end,
        oldName:'_^', newName:'`replacement name`', version:discard.version });
    assert.equal(discard.tree.source, 'let^`replacement name`=1');
}));

test('quoted cross-unit rename keeps the actual declaration width when a use has another spelling', { timeout: 30000 }, async () => withLhatServer(async (parse, server) => {
    const fs = require('node:fs'), { fileURLToPath, pathToFileURL } = require('node:url');
    const library = path.join(path.dirname(fileURLToPath(server.uri)), 'quoted-library.lh');
    const librarySource = 'public^let^value=1'; fs.writeFileSync(library, librarySource);
    const source = 'let^lib=require^"quoted-library.lh"\nprint(lib.`value`)';
    const tree = await parse(source);
    assert(!flat(tree.root).some(n => n.kind === 'error'), source);
    const edit = await server.request('textDocument/rename', { textDocument:{ uri:server.uri }, position:{ line:1, character:10 }, newName:'`new name`' });
    const files = new Map([[server.uri, source], [pathToFileURL(library).href, librarySource]]);
    assert.equal(Object.keys(edit.changes).length, 2);
    for (const [uri, changes] of Object.entries(edit.changes)) {
        const text = [...files].find(([key]) => key.toLowerCase() === uri.toLowerCase())[1];
        const offset = pos => text.split('\n').slice(0,pos.line).reduce((n,line)=>n+line.length+1,0)+pos.character;
        const expected = text === source ? '`value`' : 'value';
        assert.equal(changes.length, 1);
        assert.equal(text.slice(offset(changes[0].range.start), offset(changes[0].range.end)), expected);
        assert.equal(changes[0].newText, '`new name`');
    }
    assert.equal(fs.readFileSync(library, 'utf8'), librarySource);
}));

test('fresh graph names and type shadowing compare quoted and ordinary spellings by identity', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), structure = load('graphStructure.ts');
    let tree = await parse('let^`value`=0');
    const choice = api.statementTemplates(tree, api.statementInsertions(tree).find(s => s.before === undefined)).find(c => c.id === 'let');
    assert(choice.text.includes('value2'), choice.text);
    tree = await parse('let^items={`value`=0}');
    const member = lists.listTemplates(tree, lists.listInsertions(tree).find(s => s.kind === 'table' && s.before === undefined)).find(c => c.id === 'member');
    assert(member.text.includes('value2'), member.text);
    tree = await parse('let^`local`=7 let^value=`local`');
    const value = tree.root.fields.items[1].fields.values[0];
    const edit = expressions.replaceExpression(tree, value, 'local'); assert(edit);
    assert(edit.text.includes('let^local2'), edit.text);
    for (const source of ['let^Item=def^{} let^f=f^`Item`:number^,x:any^{}', 'let^`Item`=def^{} let^f=f^Item:number^,x:any^{}']) {
        tree = await parse(source);
        const type = tree.root.fields.items[1].fields.values[0].fields.params[1].fields.type;
        assert(!structure.structureTemplates(tree, type).some(c => c.id === 'type:name:Item' || c.id === 'type:name:`Item`'), source);
    }
    tree = await parse('let^`i`=7 repeat^2{print(`i`)}');
    const loop = tree.root.fields.items[1], change = structure.editStructure(tree, loop, 'mode:range');
    assert(change.text.startsWith('for^i2 '), change.text);
}));

test('qualified type references replace the whole type and never expose value access controls', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    const type = tree => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const initial = await parse('let^read=f^x:godot.Node2D{0}');
    assert.equal(type(initial).kind, 'member');
    assert(!structures.structureTemplates(initial, type(initial)).some(c => c.id === 'access:nil-check'));
    for (const reference of ['godot.Node2D', 'module.Item^', 'Self^', 'Self^^', '日本語.型']) {
        const edit = structures.editStructure(initial, type(initial), `type:reference:${reference}`);
        assert(edit, reference);
        const tree = await parse(apply(initial.source, edit));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        assert.equal(tree.source.slice(type(tree).start, type(tree).end), reference);
    }
    for (const reference of ['f^', 'p^', 'Item^^', 'godot..Node', 'godot.0', 'Item;print(1)', 't^{}'])
        assert.equal(structures.editStructure(initial, type(initial), `type:reference:${reference}`), undefined, reference);
    const edit = structures.editStructure(initial, type(initial), 'type:name:string^');
    assert.equal(apply(initial.source, edit), 'let^read=f^x:string^{0}');
}));

test('positional type counts and tails preserve their type and comments while rejecting invalid limits', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    const type = tree => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const base = await parse('let^read=f^x:t^{number^,name:string^}{0}');
    for (const count of ['1','256','0x10','0b10','0o10','1_0']) {
        const edit = structures.editStructure(base, type(base), `type:position:0:count:${count}`);
        assert(edit, count);
        const changed = await parse(apply(base.source, edit));
        assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
        assert(changed.source.includes(`[${count}]`));
    }
    for (const count of ['0','257','-1','+1','1.5','1e0','1;print(1)'])
        assert.equal(structures.editStructure(base, type(base), `type:position:0:count:${count}`), undefined, count);
    let tree = await parse('let^read=f^x:t^{(number^)[#[keep]#2],name:string^}{0}');
    for (const action of ['type:position:0:count:4','type:position:0:tail','type:position:0:single']) {
        tree = await parse(apply(tree.source, structures.editStructure(tree, type(tree), action)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        assert(tree.source.includes('#[keep]#') && tree.source.includes('name:string^'), tree.source);
    }
    assert(tree.source.includes('(number^)#[keep]#,name:string^'), tree.source);
}));

test('typed instance sections create positions, counts and one indexer without offering nested instance sections', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    let tree = await parse('let^read=f^x:t^{self^{}}{0}');
    const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const inner = () => type().fields.items[0].fields.value;
    const edit = async (suffix, value = '') => {
        const choice = structures.structureTemplates(tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith(suffix));
        assert(choice, suffix);
        tree = await parse(apply(tree.source, structures.editStructure(tree, type(), choice.id + value)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    };
    await edit('type:append:items:number');
    await edit('type:position:0:count', ':3');
    assert.match(tree.source, /self\^\{number\^\[3\]/);
    await edit('type:position:0:tail');
    assert.match(tree.source, /number\^\[\]/);
    await edit('type:position:0:single');
    await edit('type:append:items:typeIndexer');
    assert(inner().fields.items[1].computed);
    const choices = load('graphLists.ts').listTemplates(tree, { category:'list', kind:'self-table', start:inner().start, end:inner().end, field:'items' });
    assert(choices.some(c => c.id === 'number'));
    assert(!choices.some(c => c.id === 'typeIndexer' || c.id === 'typeSelf'));
    await edit('type:remove:items:1');
    await edit('type:remove:items:0');
    assert.equal(inner().fields?.items?.length ?? 0, 0);
}));

test('typed indexers and instance sections add once and use declaration syntax for their own fields', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    let tree = await parse('let^read=f^x:t^{}{0}');
    const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const edit = async action => {
        tree = await parse(apply(tree.source, structures.editStructure(tree, type(), action)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    };
    await edit('type:append:items:typeIndexer');
    assert(type().fields.items[0].computed);
    assert(!structures.structureTemplates(tree, type()).some(c => c.id === 'type:rename:0' || c.id === 'type:append:items:typeIndexer'));
    await edit('type:append:items:typeSelf');
    const append = structures.structureTemplates(tree, type()).find(c => c.id.startsWith('type:part:') && c.id.endsWith('type:append:items'));
    assert(append);
    await edit(append.id);
    const rename = structures.structureTemplates(tree, type()).find(c => c.id.startsWith('type:part:') && c.id.includes('type:rename:0'));
    await edit(`${rename.id}:field^`);
    const field = type().fields.items[1].fields.value.fields.items[0];
    assert.equal(tree.source.slice(field.fields.key.start, field.fields.key.end), 'field^');
    assert.equal(tree.source.slice(field.fields.value.start, field.fields.value.end), 'number^');
    assert(!structures.structureTemplates(tree, type()).some(c => c.id === 'type:append:items:typeSelf'));
}));

test('contextual and enclosing-body references are editable without admitting structural keywords', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const reference of ['this^','this^^','self^^','it^^','def^','def^^','super^','L^','t^','$^it^','$$self^']) {
        const tree = await parse('let^value=nil^'), value = tree.root.fields.items[0].fields.values[0];
        assert(expressions.validReference(reference), reference);
        const changed = await parse(apply(tree.source, expressions.replaceExpression(tree, value, `reference:${reference}`)));
        assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
        assert.equal(changed.source.slice(changed.root.fields.items[0].fields.values[0].start, changed.root.fields.items[0].fields.values[0].end), reference);
    }
    for (const reference of ['if^','for^','f^','foo^^','super^^','this^;print(1)']) assert(!expressions.validReference(reference), reference);
}));

test('callable templates toggle and remain whole expressions when replaced, deleted or reordered', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts'), deletion = load('graphDelete.ts'), reorder = load('graphReorder.ts');
    for (const source of ['let^fn=f^{0}', 'let^fn=p^{}']) {
        let tree = await parse(source), fn = () => tree.root.fields.items[0].fields.values[0];
        tree = await parse(apply(tree.source, structures.editStructure(tree, fn(), 'function:template')));
        assert(tree.source.includes('template^'));
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, fn(), 'nil')));
        assert(!tree.source.includes('template^'), tree.source);
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    let tree = await parse('let^items=print(template^f^{0},1)');
    const args = () => tree.root.fields.items[0].fields.values[0].fields.argument;
    const fn = args()[0], number = args()[1];
    const changed = reorder.reorderEdit(tree, { sourceStart: fn.start, sourceEnd: fn.end, targetStart: number.start, targetEnd: number.end, before: false });
    assert(changed);
    tree = await parse(apply(tree.source, changed));
    assert.equal(args()[0].kind, 'int', tree.source);
    const moved = args()[1];
    const site = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === moved.start && s.end === moved.end);
    assert(site);
    tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, site)));
    assert(!tree.source.includes('template^'), tree.source);
    assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
}));

test('fresh result and mutable receiver modifiers preserve callable bodies and prohibit tuple promises', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts'), lists = load('graphLists.ts'), types = load('graphTypes.ts');
    let tree = await parse('let^Item=def^{method=f^self^{return^{}}}');
    const fn = () => tree.root.fields.items[0].fields.values[0].fields.items[0].fields.value;
    tree = await parse(apply(tree.source, structures.editStructure(tree, fn().fields.params[0], 'receiver:mutable')));
    assert(tree.source.includes('mutable^self^'));
    tree = await parse(apply(tree.source, structures.editStructure(tree, fn(), 'function:fresh')));
    assert(tree.source.includes('fresh^'));
    assert(!lists.listInsertions(tree).some(s => s.kind === 'func' && s.field === 'return_type' && s.start === fn().start));
    const result = fn().fields.return_type;
    assert(!structures.structureTemplates(tree, result).some(choice => choice.id === 'type:tuple'));
    tree = await parse(apply(tree.source, structures.editStructure(tree, fn(), 'function:fresh')));
    assert(!tree.source.includes('fresh^'));
    assert(tree.source.includes('return^{}'));
    const nested = await parse('let^f=f^callback:(f^number^ -> string^;) -> fresh^number^{return^0}');
    const owner = nested.root.fields.items[0].fields.values[0], site = types.typeSites(nested).find(site => site.name === 'return value');
    assert.equal(nested.source.slice(site.operator.start, site.operator.end), '->');
    assert(site.operator.start > owner.fields.params[0].end);
    const tuple = await parse('let^pair=f^{return^1,2}'), pair = tuple.root.fields.items[0].fields.values[0];
    assert(!structures.structureTemplates(tuple, pair).some(choice => choice.id === 'function:fresh'));
}));

test('every offered operator reparses while retaining its written operands, including type RHS and unary removal', { timeout: 60000 }, async () => withLhatServer(async parse => {
    const operators = load('graphLists.ts');
    for (const expression of ['a + b', 'a = b', 'a bitand^ b', 'a dot^ b', 'a ?? b', 'a and^ b', 'a fits^ number^', '-a']) {
        const initial = await parse(`let^a=1 let^b=2 let^value=${expression}`);
        const value = tree => tree.root.fields.items[2].fields.values[0];
        const site = operators.operatorSites(initial).find(s => s.owner.start === value(initial).start && s.owner.end === value(initial).end);
        assert(site, expression);
        assert(!site.choices.includes("=="));
        for (const operator of site.choices) {
            const changed = await parse(apply(initial.source, operators.replaceOperatorEdit(initial, site, operator)));
            assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
            assert(operators.operatorSites(changed).some(s => s.text === operator), changed.source);
            const left = value(changed).fields.left ?? value(changed).fields.operand ?? value(changed).fields.value;
            assert.equal(changed.source.slice(left.start, left.end), 'a', changed.source);
            const right = value(changed).fields.right ?? value(changed).fields.type;
            if (right) assert.equal(changed.source.slice(right.start, right.end), expression.includes('fits^') ? 'number^' : 'b', changed.source);
        }
    }
    for (const expression of ['!a', 'bitnot^a', '-a', '(a)?']) {
        const initial = await parse(`let^a=1 let^value=${expression}`), value = initial.root.fields.items[1].fields.values[0];
        const changed = await parse(apply(initial.source, expressions.replaceExpression(initial, value, 'unwrap')));
        assert.equal(changed.root.fields.items[1].fields.values[0].kind, 'ident', changed.source);
    }
}));

test('nil-checked access toggles its own punctuation while preserving grouped targets and arguments', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    for (const expression of ['obj.value', 'obj?.value', 'obj[0]', 'obj?[0]', 'fn(0)', 'fn?(0)', '((fn()))(0)', '((fn()))[0]', '((obj)).value']) {
        const source = `let^value=${expression}`, initial = await parse(source);
        const value = tree => tree.root.fields.items[0].fields.values[0];
        const first = structure.editStructure(initial, value(initial), 'access:nil-check');
        assert(first, expression);
        const changed = await parse(apply(source, first));
        assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
        const originalTarget = value(initial).fields.target, changedTarget = value(changed).fields.target;
        assert.equal(changed.source.slice(changedTarget.start, changedTarget.end), source.slice(originalTarget.start, originalTarget.end));
        const restored = await parse(apply(changed.source, structure.editStructure(changed, value(changed), 'access:nil-check')));
        assert.equal(restored.source, source);
    }
    const delegate = await parse('let^Item=def^{delegate^self^.base}');
    const target = delegate.root.fields.items[0].fields.values[0].fields.items[0].fields.value;
    assert.equal(structure.editStructure(delegate, target, 'access:nil-check'), undefined);
}));

test('comparison chains create, extend, shrink and replace without exposing synthetic operator expressions', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    for (const source of ['let^value=(1<2<3)', 'let^value=((1)<(2)<(3))', 'let^value=(1<2 #[keep]# <3)']) {
        let tree = await parse(source);
        const value = () => tree.root.fields.items[0].fields.values[0];
        const operators = value().fields.operators;
        assert(!expressions.expressionSites(tree).some(s => operators.some(op => s.start === op.start && s.end === op.end)));
        tree = await parse(apply(tree.source, structure.editStructure(tree, value(), 'chain:append')));
        assert.equal(value().fields.operands.length, 4, tree.source);
        tree = await parse(apply(tree.source, structure.editStructure(tree, value(), 'chain:remove-last')));
        assert.equal(value().fields.operands.length, 3, tree.source);
        tree = await parse(apply(tree.source, structure.editStructure(tree, value(), 'chain:remove-last')));
        assert.equal(value().kind, 'binary');
        if (source.includes('#[keep]#')) assert(tree.source.includes('#[keep]#'));
        tree = await parse(apply(tree.source, structure.editStructure(tree, value(), 'chain:append')));
        assert.equal(value().kind, 'compare-chain');
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'nil')));
        assert.equal(value().kind, 'hat-ident');
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    const tree = await parse('let^value=0'), value = tree.root.fields.items[0].fields.values[0];
    const constructed = await parse(apply(tree.source, expressions.replaceExpression(tree, value, 'chain')));
    assert.equal(constructed.root.fields.items[0].fields.values[0].kind, 'compare-chain');
}));

test('module import values create and edit the module path while keeping the path outside value replacement', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const fields = load('graphTextFields.ts');
    let tree = await parse('let^value=0');
    const value = () => tree.root.fields.items[0].fields.values[0];
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'import')));
    assert.equal(value().kind, 'import');
    assert(!expressions.expressionSites(tree).some(s => s.start === value().fields.value.start));
    const site = fields.textFields(tree).find(field => field.site.field === 'import').site;
    tree = await parse(apply(tree.source, fields.editTextField(tree, site, 'std.math')));
    assert.equal(tree.source.slice(value().fields.value.start, value().fields.value.end), 'std.math');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'nil')));
    assert.equal(value().kind, 'hat-ident');
}));

test('procedure signatures keep their parameter and result lists while adding and removing a trailing variadic type', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    let tree = await parse('let^read=f^x:number^{0}');
    const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const edit = async id => {
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), id)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    };
    await edit('type:procedure');
    assert.equal(type().kind, 'type-func');
    await edit('type:append:variadic');
    assert.equal(type().fields.params.length, 2);
    assert(!structure.structureTemplates(tree, type()).some(c => c.id === 'type:append:params' || c.id === 'type:append:variadic'));
    await edit('function:kind:function');
    assert.equal(type().fields.params.length, 2);
    assert(type().fields.return_type);
    await edit('type:remove:params:1');
    assert(structure.structureTemplates(tree, type()).some(c => c.id === 'type:append:params'));
}));

test('AST comparison ignores coroutine type layout but retains kind and slot markers', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const original = normalizedAst(await parse('let^f=f^x:c^{p^* -> -> -}{0}'));
    assert.deepEqual(normalizedAst(await parse('let^f=f^x:c^{ p^ * ->  -> - }{0}')), original);
    for (const type of ['c^{f^* -> -> -}', 'c^{p^* -> -> *}', 'c^{p^* -> -}'])
        assert.notDeepEqual(normalizedAst(await parse(`let^f=f^x:${type}{0}`)), original);
}));

test('coroutine type modes preserve slot boundaries across omitted, wildcard and nested signature forms', { timeout: 60000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    for (const spelling of ['c^{f^number^ -> string^ -> bool^}', 'c^{p^* -> * -> -}', 'c^{}', 'c^{p^number^}',
        'c^{number^ -> string^}', 'c^{f^(f^number^ -> string^;) -> (number^,string^) -> type^<number^>}',
        'c^{p^number^ #[receive]# -> string^ #[yield]# -> bool^ #[end]#}']) {
        const source = `let^read=f^x:${spelling}{0}`, initial = await parse(source);
        const type = tree => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
        assert(!flat(initial.root).some(n => n.kind === 'error'), source);
        const choices = structure.structureTemplates(initial, type(initial)).filter(c => c.id.startsWith('coroutine:'));
        for (const choice of choices) {
            const tree = await parse(apply(initial.source, structure.editStructure(initial, type(initial), choice.id)));
            assert(!flat(tree.root).some(n => n.kind === 'error'), `${choice.id}: ${tree.source}`);
            assert.equal(type(tree).kind, 'type-coro', tree.source);
            const content = (tree, field) => {
                const part = type(tree).fields?.[field];
                return part && tree.source.slice(part.start, part.end);
            };
            for (const field of ['receive', 'produce', 'result']) if (field !== choice.id.split(':')[1])
                assert.equal(content(tree, field), content(initial, field), `${choice.id}: ${field}`);
            if (source.includes('#[')) for (const comment of ['#[receive]#', '#[yield]#', '#[end]#']) assert(tree.source.includes(comment), tree.source);
            assert(tree.source.endsWith('{0}'));
        }
    }
}));

test('annotated table and function types add, rename and remove their actual list elements', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    let tree = await parse('let^read=f^x:t^{}{0}');
    const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
    const edit = async id => {
        const change = structure.editStructure(tree, type(), id);
        assert(change, id);
        tree = await parse(apply(tree.source, change));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    };
    await edit('type:append:items');
    assert.equal(type().fields.items.length, 1);
    assert.equal(structure.editStructure(tree, type(), 'type:rename:0:bad.name'), undefined);
    await edit('type:rename:0:日本語');
    const key = type().fields.items[0].fields.key;
    assert.equal(tree.source.slice(key.start, key.end), '日本語');
    await edit('type:append:items');
    await edit('type:remove:items:0');
    await edit('type:remove:items:0');
    assert.equal(type().fields?.items?.length ?? 0, 0);
    await edit('type:function');
    await edit('type:append:params');
    assert.equal(type().fields.params.length, 2);
    await edit('type:remove:params:1');
    await edit('type:remove:params:0');
    assert.equal(type().fields?.params?.length ?? 0, 0);
    await edit('type:append:return_type');
    assert.equal(type().fields.return_type.kind, 'type-tuple');
    await edit('type:remove:return_type:1');
    await edit('type:remove:return_type:0');
    assert.equal(type().fields?.return_type, undefined);
    await edit('type:append:return_type');
    assert.equal(type().fields.return_type.kind, 'type-name');
}));

test('type constructors and nested variants edit grouped components and preserve list comments', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts'), deletion = load('graphDelete.ts');
    for (const [id, kind] of [['tuple', 'type-tuple'], ['intersection', 'type-intersect'], ['function', 'type-func'], ['coroutine', 'type-coro'], ['apply', 'type-apply']]) {
        let tree = await parse('let^read=f^x:number^{0}');
        const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), `type:${id}`)));
        assert.equal(type().kind, kind, tree.source);
        const variant = structure.structureTemplates(tree, type()).find(c => c.id.endsWith('type:name:string^') && c.id.startsWith('type:part:') && c.text.includes('string^'));
        assert(variant, id);
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), variant.id)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        assert(tree.source.includes('string^'), tree.source);
    }
    for (const source of ['let^f=f^x:(number^,#[keep]#string^){0}', 'let^f=f^x:((number^)|nil^,string^){0}']) {
        let tree = await parse(source);
        const type = () => tree.root.fields.items[0].fields.values[0].fields.params[0].fields.type;
        const replaced = structure.structureTemplates(tree, type()).find(c => c.id.startsWith('type:part:1:') && c.id.endsWith('type:name:bool^'));
        assert(replaced);
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), replaced.id)));
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), 'type:append')));
        assert.equal(type().fields.items.length, 3, tree.source);
        const second = type().fields.items[1];
        tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, { ...second, category: 'element' })));
        assert.equal(type().fields.items.length, 2, tree.source);
        if (source.includes('#[keep]#')) assert(tree.source.includes('#[keep]#'));
        tree = await parse(apply(tree.source, structure.editStructure(tree, type(), 'type:remove:0')));
        assert.equal(type().kind, 'type-name', tree.source);
        assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
    }
}));

test('delegate entries allow one plain or self member target and preserve neighboring definitions', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), deletion = load('graphDelete.ts');
    let tree = await parse('let^Item=def^{base={}}');
    const def = () => tree.root.fields.items[0].fields.values[0];
    const insertion = () => lists.listInsertions(tree).find(s => s.kind === 'def' && s.before === undefined);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, insertion(), 'delegate')));
    assert(!lists.listTemplates(tree, insertion()).some(c => c.id === 'delegate'));
    const entry = () => def().fields.items[1], target = () => entry().fields.value;
    assert.equal(tree.source.slice(target().start, target().end), 'base');
    assert(expressions.expressionTemplates(tree, target()).every(c => c.id.startsWith('reference:')));
    for (const invalid of ['number', 'call', 'reference:self^', 'reference:other.child', 'reference:self^.child.more', 'reference:$base'])
        assert.equal(expressions.replaceExpression(tree, target(), invalid), undefined);
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, target(), 'reference:self^.base')));
    assert.equal(target().kind, 'member');
    tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, { ...entry(), category: 'element' })));
    assert.equal(def().fields.items.length, 1);
    assert(lists.listTemplates(tree, insertion()).some(c => c.id === 'delegate'));
    tree = await parse('let^Item=def^{op^+ = f^self^,rhs:Self^{0}}');
    assert.equal(lists.listTemplates(tree, insertion()).find(c => c.id === 'delegate').text, 'delegate^value');
}));

test('typeof, boxes and type values retain editable roots and operands through real parsing', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts');
    for (const template of ['typeof', 'box', 'constbox']) {
        let tree = await parse('let^a=1 let^b=2 let^value=((a)+b)');
        const value = () => tree.root.fields.items[2].fields.values[0];
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), template)));
        assert.equal(value().kind, template === 'typeof' ? 'typeof' : 'box');
        assert.equal(value().fields.value.kind, 'binary');
        if (template !== 'typeof') {
            tree = await parse(apply(tree.source, structure.editStructure(tree, value(), 'box:toggle')));
            assert(tree.source.includes(template === 'box' ? 'constbox^' : 'box^'));
        }
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'unwrap')));
        assert.equal(value().kind, 'binary');
        assert(!flat(tree.root).some(n => n.kind === 'error'));
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'typeValue')));
        assert.equal(value().kind, 'type');
        tree = await parse(apply(tree.source, structure.editStructure(tree, value().fields.value, 'type:name:string^')));
        assert.equal(tree.source.slice(value().start, value().end), 'string^');
    }
}));

test('scoped references and name values edit without changing unrelated bindings', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structure = load('graphStructure.ts'), text = load('graphTextFields.ts');
    let tree = await parse('let^original=1 let^value=original');
    const value = () => tree.root.fields.items[1].fields.values[0];
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'scope:file')));
    assert.equal(value().kind, 'scope');
    for (const action of ['scope:more', 'scope:less', 'scope:outer', 'scope:more', 'scope:less', 'scope:file']) {
        tree = await parse(apply(tree.source, structure.editStructure(tree, value(), action)));
        assert.equal(tree.source.slice(value().fields.name.start, value().fields.name.end), 'original');
    }
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'reference:$^original')));
    assert.equal(value().kind, 'scope');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'name')));
    const field = text.textFields(tree).find(f => f.site.field === 'name');
    assert(field);
    for (const invalid of ['bad.name', 'x^^', 'x;print(1)']) assert.equal(text.editTextField(tree, field.site, invalid), undefined);
    tree = await parse(apply(tree.source, text.editTextField(tree, field.site, '日本語^')));
    assert.equal(value().kind, 'name');
    assert(tree.source.endsWith('id^日本語^'));
    assert(tree.source.startsWith('let^original=1'));
}));

test('argument expansion is offered only at the end and prevents insertion after the expanded value', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('print(0,(1,2))');
    const call = () => tree.root.fields.items[0].fields.value;
    const args = () => call().fields.argument;
    assert(!expressions.expressionTemplates(tree, args()[0]).some(c => c.id === 'spread'));
    assert(expressions.expressionTemplates(tree, args()[1]).some(c => c.id === 'spread'));
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, args()[1], 'spread')));
    assert.equal(args()[1].kind, 'spread');
    assert(!lists.listInsertions(tree).some(s => s.kind === 'call' && s.start === call().start && s.before === undefined));
    const before = lists.listInsertions(tree).find(s => s.kind === 'call' && s.before === args()[1].start);
    assert(before);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, before, 'default')));
    assert.equal(args().length, 3);
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, args()[2], 'unwrap')));
    assert.equal(args()[2].kind, 'tuple');
    assert(lists.listInsertions(tree).some(s => s.kind === 'call' && s.start === call().start && s.before === undefined));
}));

test('type patterns retain their real type nodes for structure and list editing without value-expression controls', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const patterns = load('graphPatterns.ts'), lists = load('graphLists.ts'), structure = load('graphStructure.ts');
    let tree = await parse('for^nil^{when^fits^number^:print(1) other^:print(2)}');
    const pattern = () => patterns.patternLists(tree)[0].items[0], type = () => pattern().fields.type;
    tree = await parse(apply(tree.source, structure.editStructure(tree, type(), 'type:name:t^{}')));
    assert.equal(type().kind, 'type-table');
    const insertion = lists.listInsertions(tree).find(s => s.start === type().start && s.kind === 'type-table');
    assert(insertion);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, insertion, 'typeMember')));
    assert.equal(type().fields.items.length, 1);
    assert(!expressions.expressionSites(tree).some(s => s.start >= type().start && s.end <= type().end));
    assert.equal(lists.operatorSites(tree).length, 0);
    assert(tree.source.includes('print(1)') && tree.source.includes('print(2)'));
}));

test('local expression scopes and shared for drivers preserve their inner source and avoid name capture', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const loops = load('graphLoops.ts'), structure = load('graphStructure.ts');
    let tree = await parse('let^local=7 let^answer=local');
    const answer = () => tree.root.fields.items[1].fields.values[0];
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, answer(), 'local')));
    assert(loops.forExpression(answer(), tree.source));
    assert(tree.source.includes('let^local2 = 0'));
    assert.equal(tree.source.slice(answer().fields.body.start, answer().fields.body.end), 'local');
    assert(expressions.expressionSites(tree).some(s => s.kind === 'for' && s.start === answer().start));
    for (const source of ['for^i from^0 to^3 {print(i)}', 'let^answer=(for^let^x=1 do^:(x+2);)',
        'let^answer=(for^let^x=1 if^true^:x el^:0;)']) {
        tree = await parse(source);
        const root = () => source.startsWith('let^') ? tree.root.fields.items[0].fields.values[0] : tree.root.fields.items[0];
        const before = tree.source.slice(root().start, root().end);
        tree = await parse(apply(tree.source, structure.editStructure(tree, root(), 'focus:wrap')));
        assert.equal(tree.source.slice(root().fields.body.start, root().fields.body.end), before);
        assert.equal(loops.forExpression(root(), tree.source), source.startsWith('let^'));
        tree = await parse(apply(tree.source, structure.editStructure(tree, root(), 'focus:unwrap')));
        assert.equal(tree.source, source);
    }
}));

test('type tests and casts retain editable values, type syntax and operator conversions', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), structure = load('graphStructure.ts');
    for (const template of ['fits', 'cast']) {
        let tree = await parse('let^value=1');
        const value = () => tree.root.fields.items[0].fields.values[0];
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), template)));
        assert.equal(value().kind, template === 'fits' ? 'binary' : 'as');
        const annotation = () => value().fields.type ?? value().fields.right;
        assert(!expressions.expressionSites(tree).some(s => s.start === annotation().start && s.end === annotation().end));
        tree = await parse(apply(tree.source, structure.editStructure(tree, annotation(), 'type:name:string^')));
        assert.equal(tree.source.slice(annotation().start, annotation().end), 'string^');
        const site = lists.groupedOperatorSites(tree).find(s => s.owner.start === value().start && s.owner.end === value().end);
        tree = await parse(apply(tree.source, lists.replaceOperatorEdit(tree, site, template === 'fits' ? 'as^' : 'fits^')));
        assert.equal(value().kind, template === 'fits' ? 'as' : 'binary');
        tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value(), 'nil')));
        assert.equal(value().kind, 'hat-ident');
        assert.equal(tree.source.slice(value().start, value().end), 'nil^');
    }
}));

test('required index and focus lists retain their final element, while the last advance removes next too', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts');
    const indexed = await parse('let^items={1} let^value=items[0]'), argument = indexed.root.fields.items[1].fields.values[0].fields.argument[0];
    assert.equal(deletion.deleteFromGraph(indexed, { ...argument, category: 'element' }), undefined);
    const tree = await parse('for^var^i=0 while^i<2 next^i+=1 {print(i)}'), loop = tree.root.fields.items[0];
    assert.equal(deletion.deleteFromGraph(tree, { ...loop.fields.focus[0], category: 'element' }), undefined);
    const result = await parse(apply(tree.source, deletion.deleteFromGraph(tree, { ...loop.fields.advance[0], category: 'element' })));
    assert(!result.source.includes('next^'));
    assert(!result.root.fields.items[0].fields.advance);
    assert.equal(result.root.fields.items[0].fields.focus.length, 1);
    assert.equal(result.root.fields.items[0].fields.body.fields.items.length, 1);
}));

test('deleting call-result bindings keeps each output position and the single initializer evaluation', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts');
    const prefix = 'let^pair=f^{(10,"two",30)}\n';
    for (const declaration of ['let^a,b,c=pair()', 'var^a:number^,b:string^,c:number^=pair()',
        'var^a=0 var^b="" var^c=0 a,b,c:=pair()']) {
        let tree = await parse(prefix + declaration);
        const statement = () => tree.root.fields.items.at(-1), original = tree.source;
        const values = statement().fields.values.map(n => tree.source.slice(n.start, n.end));
        for (const i of [1, 0, 2]) {
            const target = statement().fields.targets[i];
            const site = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === target.start && s.end === target.end);
            assert(site, original);
            tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, site)));
            assert.equal(statement().fields.targets.length, 3);
            assert.equal(tree.source.slice(statement().fields.targets[i].start, statement().fields.targets[i].end), '_^');
            assert.deepEqual(statement().fields.values.map(n => tree.source.slice(n.start, n.end)), values);
            assert.equal((tree.source.match(/pair\(/g) ?? []).length, 1);
            assert.equal(deletion.deleteFromGraph(tree, site), undefined);
        }
    }
}));

test('compound assignment deletion removes the paired RHS even when it calls a function', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts');
    for (const operator of ['+=', '?+=', '*=']) {
        const tree = await parse(`let^read=f^{1}\nvar^a,b=0,0\na,b ${operator} read(),2`), assignment = tree.root.fields.items.at(-1);
        const target = assignment.fields.targets[0];
        const result = await parse(apply(tree.source, deletion.deleteFromGraph(tree, { ...target, category: 'element' })));
        assert(result.source.endsWith(`b ${operator} 2`), result.source);
        assert.equal(result.root.fields.items.at(-1).fields.targets.length, 1);
    }
}));

test('computed table keys expose full expression editing and grouped-key conversion preserves neighbors', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    let tree = await parse('let^base=4 let^mapping={[0]=10,other=20}');
    const entry = () => tree.root.fields.items[1].fields.values[0].fields.items[0];
    const key = () => entry().fields.key;
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, { ...key() }, 'reference:base')));
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, { ...key() }, 'add')));
    assert.equal(key().kind, 'binary');
    assert.equal(tree.source.slice(entry().fields.value.start, entry().fields.value.end), '10');
    const grouped = await parse('let^mapping={[("field")]=10,other=20}'), member = grouped.root.fields.items[0].fields.values[0].fields.items[0];
    const converted = await parse(apply(grouped.source, structures.editStructure(grouped, member, 'key:identifier')));
    assert(converted.source.includes('field=10,other=20'), converted.source);
    assert.equal(converted.root.fields.items[0].fields.values[0].fields.items.length, 2);
    const named = await parse('let^mapping={field=10}');
    const namedKey = named.root.fields.items[0].fields.values[0].fields.items[0].fields.key;
    assert(!expressions.expressionSites(named).some(s => s.start === namedKey.start && s.end === namedKey.end));
}));

test('branch and loop-section deletion reuses structural edits and preserves the remaining source structure', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { structuralDeletions, deleteFromGraph, deleteSites } = load('graphDelete.ts');
    const { normalizedAst } = require('./graph-browser-host.cjs');
    for (const [source, action, expected] of [
        ['if^true^{print(1) el^false^:print(2) el^:print(3)}', 'remove-branch:0', 'if^false^{print(2) el^:print(3)}'],
        ['if^true^{print(1) el^false^:print(2) el^:print(3)}', 'remove-branch:1', 'if^true^{print(1) el^:print(3)}'],
        ['let^x=(if^true^:1 el^false^:2 el^:3;)', 'remove-branch:1', 'let^x=(if^true^:1 el^:3;)'],
        ['for^n{when^0:print(1) when^1:print(2) other^:print(3)}', 'remove-match:0', 'for^n{when^1:print(2) other^:print(3)}'],
        ['for^let^d=1 if^d>0{print(d)}', 'remove-branch:0', ''],
        ['repeat^2{pre^:print(1) main^:print(2) epilog^:print(3)}', 'remove-section:pre^', 'repeat^2{main^:print(2) epilog^:print(3)}'],
        ['repeat^2{pre^:print(1) main^:print(2) epilog^:print(3)}', 'remove-section:main^', 'repeat^2{pre^:print(1) epilog^:print(3)}'],
        ['repeat^2{main^:print(2)}', 'remove-section:main^', 'repeat^2{main^:}'],
        ['for^var^i=0 while^i<2 next^i+=1 {print(i)}', 'next:remove', 'for^var^i=0 while^i<2 {print(i)}'],
    ]) {
        const tree = await parse(source), before = JSON.stringify(tree);
        const deletion = structuralDeletions(tree).find(entry => entry.action === action);
        assert(deletion, `${action}: ${source}`);
        assert(deleteSites(tree).some(site => site.category === 'element' && site.start === deletion.site.start && site.end === deletion.site.end));
        const result = await parse(apply(source, deleteFromGraph(tree, deletion.site)));
        assert.deepEqual(normalizedAst(result), normalizedAst(await parse(expected)), result.source);
        assert.equal(JSON.stringify(tree), before);
    }
    const expression = await parse('let^x=(if^true^:1 el^:2;)');
    assert(!structuralDeletions(expression).some(entry => entry.action === 'remove-branch:1'));
}));

test('grouped expressions inside interpolations remain replaceable without touching surrounding text', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const value of ['(items)[0]', '(items[0]) + 1']) {
        const tree = await parse(`let^items={1} let^text=$"before{${value}}after"`);
        const interpolation = tree.root.fields.items[1].fields.values[0], hole = interpolation.fields.items.find(n => n.kind === 'interp-hole');
        const site = expressions.expressionSites(tree).find(s => s.kind === hole.fields.value.kind && s.start === hole.fields.value.start && s.end === hole.fields.value.end);
        const edit = expressions.replaceExpression(tree, site, 'fallback');
        assert(edit);
        const changed = await parse(apply(tree.source, edit)), result = changed.root.fields.items[1].fields.values[0];
        assert.equal(result.kind, 'interp');
        assert.equal(result.fields.items.filter(n => n.kind === 'interp-hole').length, 1);
        assert(changed.source.includes('$"before{'));
        assert(changed.source.endsWith('}after"'));
        assert.equal(result.fields.items.find(n => n.kind === 'interp-hole').fields.value.kind, 'binary');
    }
}));

test('AST comparison preserves interpolation operators and text while ignoring expression layout', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const original = normalizedAst(await parse('let^x=$"start{(1 + 2)}:{(3 + 4)}"'));
    assert.deepEqual(normalizedAst(await parse('let^x=$"start{((1)+ 2)}:{((3)+4)}"')), original);
    assert.notDeepEqual(normalizedAst(await parse('let^x=$"start{(1 - 2)}:{(3 + 4)}"')), original);
    assert.notDeepEqual(normalizedAst(await parse('let^x=$"changed{(1 + 2)}:{(3 + 4)}"')), original);
}));

test('AST comparison treats else keyword aliases equally while preserving body and literal differences', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const original = normalizedAst(await parse('if^true^{print(1) else^:print("else^")}'));
    assert.deepEqual(normalizedAst(await parse('if^true^{print(1) el^:print("else^")}')), original);
    assert.notDeepEqual(normalizedAst(await parse('if^true^{print(2) el^:print("else^")}')), original);
    assert.notDeepEqual(normalizedAst(await parse('if^true^{print(1) el^:print("el^")}')), original);
}));

test('computed member rows retain optional access punctuation and their single receiver', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { expressionCells } = load('webview/operatorExpression.ts');
    for (const optional of ['', '?']) {
        const tree = await parse(`let^x=(read())${optional}.value`), member = tree.root.fields.items[0].fields.values[0];
        const cells = expressionCells(member, tree.source);
        assert.equal(cells.filter(cell => cell.operand?.kind === 'call').length, 1);
        assert.equal(cells.find(cell => cell.delimiter).token.text, `${optional}.`);
        assert.equal(cells.at(-1).operand, member.fields.argument[0]);
    }
}));

test('overloaded calls can grow to another declared arity without permitting extra fixed inputs', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('let^values={1,2,3}\nlet^part=values.slice^(0)');
    const call = () => tree.root.fields.items[1].fields.values[0];
    assert.equal(call().callable.inputs.length, 1);
    const site = lists.listInsertions(tree).find(s => s.kind === 'call');
    assert(site);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'default')));
    assert.equal(call().fields.argument.length, 2);
    assert.equal(call().callable.inputs.length, 2);
    assert(!lists.listInsertions(tree).some(s => s.kind === 'call'));
}));

test('explicit return types delete individually and the last deletion restores inference', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts');
    for (const source of ['let^f=f^ -> number^, string^{return^1,"s"}', 'let^f=f^ -> (number^), #[keep]# string^{return^1,"s"}',
        'let^f=f^ -> (number^,string^){return^1,"s"}', 'let^f=f^ -> ((number^,string^)){return^1,"s"}']) {
        let tree = await parse(source);
        const fn = () => tree.root.fields.items[0].fields.values[0];
        const first = fn().fields.return_type.fields.items[0];
        const site = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === first.start && s.end === first.end);
        assert(site, source);
        tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, site)));
        assert.equal(fn().fields.return_type.kind, 'type-name');
        const { normalizedAst } = require('./graph-browser-host.cjs');
        const normalized = normalizedAst(tree);
        const expected = normalizedAst(await parse('let^f=f^ -> string^{return^1,"s"}'));
        if (source.includes('#[keep]#')) {
            const stripComments = node => { if (node && typeof node === 'object') { delete node.comments; Object.values(node).forEach(stripComments); } };
            stripComments(normalized);
        }
        assert.deepEqual(normalized, expected, tree.source);
        const remaining = fn().fields.return_type;
        tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, { ...remaining, category: 'element' })));
        assert(!fn().fields.return_type);
        assert(!tree.source.includes('->'));
        assert.equal(fn().fields.body.fields.items[0].fields.value.length, 2);
        if (source.includes('#[keep]#')) assert(tree.source.includes('#[keep]#'));
    }
}));

test('variadic parameters can be appended once and their values remain referenceable and indexable', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('let^first=f^head:number^{return^0}');
    const site = lists.listInsertions(tree).find(s => s.kind === 'func' && s.field === 'params' && s.before === undefined);
    assert(lists.listTemplates(tree, site).some(t => t.id === 'variadic'));
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'variadic')));
    const fn = tree.root.fields.items[0].fields.values[0];
    assert.equal(fn.fields.params.length, 2);
    assert.equal(tree.source.slice(fn.fields.params[1].start, fn.fields.params[1].end), '...: any^');
    assert(!lists.listInsertions(tree).some(s => s.kind === 'func' && s.field === 'params' && s.before === undefined));
    assert.equal(lists.insertListEdit(tree, { ...site, end: fn.end }, 'parameter'), undefined);
    const value = expressions.expressionSites(tree).find(s => s.kind === 'int');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value, 'reference:...')));
    const spread = expressions.expressionSites(tree).find(s => s.kind === 'hat-ident');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, spread, 'index')));
    assert(flat(tree.root).some(n => n.kind === 'index'));
    assert(!flat(tree.root).some(n => n.kind === 'error'));
}));

test('postfix nil checks retain their written operator and editable operand after reanalysis', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { expressionCells } = load('webview/operatorExpression.ts');
    for (const value of ['nil^', '1', 'value', 'items[0]', 'read()']) {
        const initial = await parse(`let^result=${value}`), site = expressions.expressionSites(initial).find(s => s.start === initial.root.fields.items[0].fields.values[0].start);
        const tree = await parse(apply(initial.source, expressions.replaceExpression(initial, site, 'present')));
        const check = tree.root.fields.items[0].fields.values[0];
        assert.equal(check.kind, 'unary');
        assert.equal(check.inferredType, 'bool^');
        const cells = expressionCells(check, tree.source);
        assert.equal(cells.at(-1).token.text, '?');
        assert.equal(cells.filter(c => c.token?.text === '?').length, 1);
        const operand = check.fields.operand;
        const operandSite = expressions.expressionSites(tree).find(s => s.start === operand.start && s.end === operand.end);
        assert(operandSite);
        const changed = await parse(apply(tree.source, expressions.replaceExpression(tree, operandSite, 'string')));
        assert.equal(changed.root.fields.items[0].fields.values[0].fields.operand.kind, 'string');
    }
}));

test('error construction edits its qualified kind and payload without allowing value syntax in the kind', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('errordef^E { Failure { value:number^ } }\nlet^e = 0');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, expressions.expressionSites(tree).find(s => s.kind === 'int'), 'error')));
    const site = expressions.expressionSites(tree).find(s => s.errorName);
    assert(site);
    for (const invalid of ['number', 'call', 'reference:self^.Failure', 'reference:E.0', 'reference:E{}'])
        assert.equal(expressions.replaceExpression(tree, { ...site, errorName: false }, invalid), undefined, invalid);
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, site, 'reference:E.Failure')));
    const insertion = lists.listInsertions(tree).find(s => s.kind === 'error-new');
    assert(insertion);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, insertion, 'member')));
    const error = flat(tree.root).find(n => n.kind === 'error-new');
    assert.equal(tree.source.slice(error.fields.name.start, error.fields.name.end), 'E.Failure');
    assert.equal(error.fields.members.length, 1);
    const value = expressions.expressionSites(tree).find(s => s.kind === 'int');
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, value, 'string')));
    assert(flat(tree.root).some(n => n.kind === 'string'));
}));

test('expression constructors retain editable roots and children after real reanalysis', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const initial = await parse('let^value = 17');
    const site = expressions.expressionSites(initial).find(s => s.kind === 'int');
    for (const [id, kind] of Object.entries({ definition: 'def', selfTable: 'self-table', conditional: 'if-expr', interpolation: 'interp', try: 'try', pack: 'pack', require: 'require', compare:'binary', logical:'binary', fallback:'binary', bitwise:'binary', product:'binary' })) {
        const tree = await parse(apply(initial.source, expressions.replaceExpression(initial, site, id)));
        const value = tree.root.fields.items[0].fields.values[0];
        assert.equal(value.kind, kind, id);
        const root = expressions.expressionSites(tree).find(s => s.kind === kind && s.start === value.start && s.end === value.end);
        assert(root, `${id}: replacement remains available`);
        const restored = await parse(apply(tree.source, expressions.replaceExpression(tree, root, 'number')));
        assert.equal(restored.root.fields.items[0].fields.values[0].kind, 'int');
        if (['try', 'pack', 'conditional', 'interpolation', 'compare', 'logical', 'fallback', 'bitwise', 'product'].includes(id)) {
            const child = expressions.expressionSites(tree).find(s => s.kind === 'int');
            assert(child, `${id}: editable child`);
            const edited = await parse(apply(tree.source, expressions.replaceExpression(tree, child, 'reference:other')));
            assert.equal(edited.root.fields.items[0].fields.values[0].kind, kind);
            assert(flat(edited.root).some(n => n.kind === 'ident' && edited.source.slice(n.start, n.end) === 'other'));
        }
    }
}));

test('new statement templates produce their intended real AST node kinds', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const empty = await parse(''), site = api.statementInsertions(empty)[0];
    const expected = { call: 'call-stmt', assign: 'reassign', with: 'with', handled: 'block', type: 'define',
        tableDefinition: 'define', enumeration: 'enumdef', error: 'errordef', module: 'module', import: 'import-stmt', require: 'require-stmt' };
    for (const [id, kind] of Object.entries(expected)) {
        const tree = await parse(apply('', api.insertStatementEdit(empty, site, id)));
        assert.equal(tree.root.fields.items.length, 1, id);
        assert.equal(tree.root.fields.items[0].kind, kind, id);
        assert(!flat(tree.root).some(n => n.kind === 'error'), id);
        if (id === 'handled') assert(tree.root.fields.items[0].fields.arms?.length, 'catch arm is present');
        if (id === 'module') assert(!api.statementTemplates(tree, api.statementInsertions(tree).slice(-1)[0]).some(c => c.id === 'module'));
    }
}));

test('procedure bodies create yield and await while ordinary functions do not offer them', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const keyword of ['p^', 'f^']) {
        const tree = await parse(`let^ task = ${keyword}{}`), body = flat(tree.root).find(n => n.kind === 'func').fields.body;
        const site = api.statementInsertions(tree).find(s => s.start === body.start && s.end === body.end);
        const choices = api.statementTemplates(tree, site);
        assert.equal(choices.some(c => c.id === 'yield'), keyword === 'p^');
        if (keyword === 'p^') for (const id of ['yield', 'await']) {
            const updated = await parse(apply(tree.source, api.insertStatementEdit(tree, site, id)));
            assert(flat(updated.root).some(n => n.kind === id), id);
        }
    }
}));

test('assignment target replacement cannot replace a writable name with a literal', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const tree = await parse('var^a = 0\nvar^b = 1\na := 2');
    const site = expressions.expressionSites(tree).find(s => s.assignmentTarget);
    assert(site);
    assert.equal(expressions.replaceExpression(tree, { ...site, assignmentTarget: false }, 'number'), undefined);
    const change = expressions.replaceExpression(tree, site, 'reference:b');
    const updated = await parse(apply(tree.source, change));
    assert.equal(updated.source, 'var^a = 0\nvar^b = 1\nb := 2');
    assert.equal(updated.root.fields.items[2].kind, 'reassign');
}));


test('module, import, require and comment fields update real unsaved documents', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const api = load('graphTextFields.ts');
    let tree = await parse('# old\nmodule^example.old\nimport^std.io\nlet^m = require^"./old.lh"');
    for (const [kind, value] of [['module', 'example.changed'], ['import', 'std.thread'], ['require', './日本語.lh'], ['comment', 'new comment']]) {
        const field = api.textFields(tree).find(f => f.site.field === kind);
        assert(field, kind);
        const change = api.editTextField(tree, field.site, value);
        tree = await parse(apply(tree.source, change));
        assert.equal(api.textFields(tree).find(f => f.site.field === kind).value, value);
        assert.equal(tree.root.fields.items.length, 3);
    }
}));


test('operator edits use actual Lhat unary, equality, bitwise, fallback and vector tokens', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const api = load('graphLists.ts');
    for (const [source, before, after, expected] of [
        ['let^x = !true^', '!', 'bitnot^', 'let^x = bitnot^true^'],
        ['let^x = 1 = 2', '=', '!=', 'let^x = 1 != 2'],
        ['let^x = 1 <=> 2', '<=>', '+', 'let^x = 1 + 2'],
        ['let^x = 1 bitand^ 2', 'bitand^', 'bitxor^', 'let^x = 1 bitxor^ 2'],
        ['let^x = nil^ ?? 2', '??', 'catch^', 'let^x = nil^ catch^ 2'],
        ['let^x = a cross^ b', 'cross^', 'dot^', 'let^x = a dot^ b'],
    ]) {
        const tree = await parse(source), site = api.operatorSites(tree).find(s => s.text === before);
        assert(site, source); assert(site.choices.includes(after));
        const edit = api.replaceOperatorEdit(tree, site, after);
        assert.equal(apply(source, edit), expected);
        const updated = await parse(expected);
        assert(!flat(updated.root).some(n => n.kind === 'error'));
        assert(api.operatorSites(updated).some(s => s.text === after));
    }
    const tree = await parse('let^x = true^'), site = expressions.expressionSites(tree).find(s => s.kind === 'hat-ident');
    const change = expressions.replaceExpression(tree, site, 'not');
    const updated = await parse(apply(tree.source, change));
    assert(flat(updated.root).some(n => n.kind === 'unary'));
}));


test('qualified references, self members and computed receivers are constructed as real member ASTs', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const tree = await parse('let^value = 0');
    const site = expressions.expressionSites(tree).find(s => s.kind === 'int');
    for (const reference of ['Item.new', 'self^.count', 'items.length^', 'values.0', '日本語.値']) {
        const change = expressions.replaceExpression(tree, site, `reference:${reference}`);
        assert(change, reference);
        const updated = await parse(apply(tree.source, change));
        assert.equal(updated.root.fields.items[0].fields.values[0].kind, 'member', reference);
    }
    for (const reference of ['a(); evil()', 'a\nb', 'a..b', 'if^', 'a[0]'])
        assert.equal(expressions.replaceExpression(tree, site, `reference:${reference}`), undefined);
    let updated = await parse('let^value = make()');
    const receiver = expressions.expressionSites(updated).find(s => s.kind === 'call');
    updated = await parse(apply(updated.source, expressions.replaceExpression(updated, receiver, 'member')));
    assert.equal(updated.source, 'let^value = (make()).value');
    const key = expressions.expressionSites(updated).find(s => s.memberKey);
    assert(key);
    const change = expressions.replaceExpression(updated, key, 'reference:count');
    updated = await parse(apply(updated.source, change));
    assert.equal(updated.source, 'let^value = (make()).count');
}));

test('definition member templates and modifiers preserve their source-owned values', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), structures = load('graphStructure.ts');
    for (const id of ['member', 'typeMember', 'abstract', 'operator', 'self']) {
        let tree = await parse('let^T = def^{}');
        const site = lists.listInsertions(tree).find(s => s.kind === 'def');
        tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, id)));
        const def = flat(tree.root).find(n => n.kind === 'def');
        assert.equal(def.fields.items.length, 1, id);
        const member = def.fields.items[0];
        if (id === 'self') {
            assert.equal(member.fields.value.kind, 'self-table');
            assert(!lists.listTemplates(tree, lists.listInsertions(tree).find(s => s.kind === 'def')).some(c => c.id === 'self'));
            continue;
        }
        const fieldValue = member.fields.value ?? member.fields.type;
        const value = tree.source.slice(fieldValue.start, fieldValue.end);
        for (const action of id === 'abstract' ? ['modifier:plain', 'modifier:abstract^'] : id === 'typeMember' ? ['modifier:abstract^', 'modifier:plain'] : ['modifier:override^', 'modifier:overload^', 'modifier:plain']) {
            const current = flat(tree.root).find(n => n.kind === 'def').fields.items[0];
            const edit = structures.editStructure(tree, current, action);
            assert(edit, `${id}: ${action}`);
            tree = await parse(apply(tree.source, edit));
            const updated = flat(tree.root).find(n => n.kind === 'def').fields.items[0];
            const fieldValue = updated.fields.value ?? updated.fields.type;
            assert.equal(tree.source.slice(fieldValue.start, fieldValue.end), value);
        }
        if (id === 'operator') for (const operator of ['=', 'cross^', 'dot^', '<=>']) {
            const current = flat(tree.root).find(n => n.kind === 'def').fields.items[0];
            tree = await parse(apply(tree.source, structures.editStructure(tree, current, `operator:${operator}`)));
            assert(tree.source.includes(`op^${operator}`));
            assert.equal(flat(tree.root).find(n => n.kind === 'def').fields.items[0].fields.value.kind, 'func');
        }
    }
}));

test('grouped expressions remain balanced through repeated wrapping and root replacement', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['let^x = ((a) + 1)', 'let^x = ((a + 1) * (b + 2))', 'let^x = (factory())(1)', 'let^x = ((a #[ ) ]#) + 1)']) {
        let tree = await parse(source);
        const value = () => tree.root.fields.items[0].fields.values[0];
        for (const template of ['add', 'negative', 'call', 'number']) {
            const node = value();
            const site = expressions.expressionSites(tree).find(s => s.kind === node.kind && s.start === node.start && s.end === node.end);
            const edit = expressions.replaceExpression(tree, site, template);
            assert(edit, `${source}: ${template}`);
            tree = await parse(apply(tree.source, edit));
            assert.equal(tree.root.fields.items.length, 1, tree.source);
            assert.equal(value().kind, { add:'binary', negative:'unary', call:'call', number:'int' }[template], tree.source);
        }
        assert.equal(tree.source.replace(/[()\s]/g, ''), 'let^x=0');
    }
}));

test('sample comparison ignores layout syntax but detects values, names, operators and modifiers', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const baseline = normalizedAst(await parse('let^a = 1 + 2'));
    assert.deepEqual(normalizedAst(await parse('let^ a = ((1) + (2))\n')), baseline);
    for (const source of ['let^b = 1 + 2', 'let^a = 1 + 3', 'let^a = 1 - 2', 'public^let^a = 1 + 2', 'var^a = 1 + 2'])
        assert.notDeepEqual(normalizedAst(await parse(source)), baseline, source);
    assert.deepEqual(normalizedAst(await parse('let^a = { 1, 2, }')), normalizedAst(await parse('let^a = {1,2}')));
    assert.notDeepEqual(normalizedAst(await parse('# old\nlet^a=0')), normalizedAst(await parse('# new\nlet^a=0')));
}));

test('last function results can switch between explicit and implicit return without changing their value', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts');
    for (const source of ['let^f = f^{ return^1 + 2 }', 'let^f = f^{ (1 + 2) }']) {
        let tree = await parse(source);
        for (const action of source.includes('return^') ? ['return:implicit', 'return:explicit'] : ['return:explicit', 'return:implicit']) {
            const returned = flat(tree.root).find(n => n.kind === 'return');
            const edit = structures.editStructure(tree, returned, action);
            assert(edit, `${source}: ${action}`);
            tree = await parse(apply(tree.source, edit));
            assert.equal(flat(tree.root).find(n => n.kind === 'return').fields.value[0].kind, 'binary');
            assert.equal(tree.source.includes('return^'), action === 'return:explicit');
        }
    }
    for (const source of ['let^f = p^{ return^1 }', 'let^f = f^{ return^1 return^2 }', 'let^f = f^{ let^x = 1 return^x }', 'let^f = f^{ if^true^ { return^1 } return^2 }']) {
        const tree = await parse(source), first = flat(tree.root).find(n => n.kind === 'return');
        assert.equal(structures.editStructure(tree, first, 'return:implicit'), undefined);
    }
}));

test('default value and raw string actions reparse without changing neighboring fields or decoded text', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const structures = load('graphStructure.ts'), literals = load('webview/literals.ts');
    for (const source of ['let^f = f^arg:string^ {}', 'errordef^E { Failure { arg:number^ } }']) {
        let tree = await parse(source);
        let param = flat(tree.root).find(n => n.kind === 'param');
        tree = await parse(apply(tree.source, structures.editStructure(tree, param, 'default:add')));
        param = flat(tree.root).find(n => n.kind === 'param');
        assert(param.fields.fallback);
        assert.equal(param.fields.fallback.kind, source.startsWith('let^') ? 'string' : 'int');
        tree = await parse(apply(tree.source, structures.editStructure(tree, param, 'default:remove')));
        assert(!flat(tree.root).find(n => n.kind === 'param').fields.fallback);
    }
    let tree = await parse('let^path = "C:\\\\temp\\\\file.txt"');
    for (const action of ['string:raw', 'string:quoted']) {
        const value = flat(tree.root).find(n => n.kind === 'string');
        const before = literals.literalOf(value, tree.source).value;
        tree = await parse(apply(tree.source, structures.editStructure(tree, value, action)));
        assert.equal(literals.literalOf(flat(tree.root).find(n => n.kind === 'string'), tree.source).value, before);
    }
    const multiline = await parse('let^text="a\\nb"');
    assert.equal(structures.editStructure(multiline, flat(multiline.root).find(n => n.kind === 'string'), 'string:raw'), undefined);
    const receiver = await parse('let^T=def^{read=f^self^ {0}}');
    const self = flat(receiver.root).find(n => n.kind === 'param');
    assert.equal(structures.editStructure(receiver, self, 'default:add'), undefined);
}));

test('receiver and constructor templates respect definition scope and preserve receiver-first ordering', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('let^T=def^{read=f^value:any^ {0}}');
    let def = flat(tree.root).find(n => n.kind === 'def');
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, lists.listInsertions(tree).find(s => s.kind === 'def'), 'constructor')));
    assert(flat(tree.root).some(n => n.kind === 'table-entry' && tree.source.slice(n.fields.key?.start, n.fields.key?.end) === 'new'));
    assert(!lists.listTemplates(tree, lists.listInsertions(tree).find(s => s.kind === 'def')).some(c => c.id === 'constructor'));
    const fn = flat(tree.root).find(n => n.kind === 'func');
    const site = lists.listInsertions(tree).find(s => s.kind === 'func' && s.start === fn.start && s.field === 'params');
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'receiver')));
    const params = flat(tree.root).find(n => n.kind === 'func').fields.params;
    assert.equal(tree.source.slice(params[0].fields.name.start, params[0].fields.name.end), 'self^');
    assert.equal(tree.source.slice(params[1].fields.name.start, params[1].fields.name.end), 'value');
    const current = flat(tree.root).find(n => n.kind === 'func');
    assert(!lists.listTemplates(tree, lists.listInsertions(tree).find(s => s.kind === 'func' && s.start === current.start && s.field === 'params')).some(c => c.id === 'receiver'));
    const outside = await parse('let^read=f^{}');
    assert(!lists.listTemplates(outside, lists.listInsertions(outside).find(s => s.kind === 'func' && s.field === 'params')).some(c => c.id === 'receiver'));
}));

test('comments on grouped positional elements stay attached to their editable expression row', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const tree = await parse('let^values = { 0,\n# comparison\n(1 = 1), 42 }');
    const entry = flat(tree.root).find(n => n.kind === 'table-entry' && n.comments?.length);
    assert(entry);
    const graph = await new (require('elkjs/lib/elk.bundled.js'))().layout(load('webview/map.ts').toElk(tree));
    const mapped = node => [node, ...(node.children ?? []).flatMap(mapped)];
    const expression = mapped(graph).find(n => n.lhat?.operatorExpression);
    assert.deepEqual(expression.lhat.elementOwner, { start: entry.start, end: entry.end });
    const laid = load('webview/comments.ts').placeComments(graph, tree);
    const comment = mapped(laid).find(n => n.lhat?.kind === 'comment');
    assert.equal(comment.lhat.commentAnchor.id, expression.id);
}));

test('parallel initializers can become one call and call construction honors the resolved signature', { timeout: 30000 }, async () => withLhatServer(async parse => {
    let tree = await parse('let^f=f^{(1,2,3)}\nlet^a,b,c=0,0,0');
    const site = expressions.expressionSites(tree).find(s => s.kind === 'initializers');
    assert(site);
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, site, 'reference:f')));
    const binding = tree.root.fields.items[1];
    const value = binding.fields.values[0];
    const ref = expressions.expressionSites(tree).find(s => s.start === value.start && s.end === value.end);
    tree = await parse(apply(tree.source, expressions.replaceExpression(tree, { ...ref, callArguments: ['evil()'] }, 'call')));
    const updated = tree.root.fields.items[1], call = updated.fields.values[0];
    assert.equal(updated.fields.targets.length, 3);
    assert.equal(updated.fields.values.length, 1);
    assert.equal(call.kind, 'call');
    assert.equal(call.fields.argument?.length ?? 0, 0);
    assert.equal(call.callable.outputs.length, 3);
    assert(!tree.source.includes('evil'));
    const typed = await parse('let^f=f^n:number^,text:string^,enabled:bool^ {n}\nlet^v=f');
    const target = typed.root.fields.items[1].fields.values[0];
    const selected = expressions.expressionSites(typed).find(s => s.start === target.start && s.end === target.end);
    const called = await parse(apply(typed.source, expressions.replaceExpression(typed, selected, 'call')));
    assert.deepEqual(called.root.fields.items[1].fields.values[0].fields.argument.map(n => n.kind), ['int', 'string', 'hat-ident']);
}));

test('paired reassignment insertion preserves written RHS expressions and blocks call-result expansion', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), assignments = load('graphAssignments.ts');
    for (const operator of [':=', '+=', '*=', '?+=']) {
        let tree = await parse(`var^a=1\na ${operator} 2`);
        const node = tree.root.fields.items[1];
        const site = lists.listInsertions(tree).find(s => s.kind === 'reassign');
        assert(site, operator);
        assert.equal(site.field, 'targets');
        tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'binding')));
        const updated = tree.root.fields.items[1];
        assert.equal(updated.fields.targets.length, 2);
        assert.equal(assignments.assignmentOperator(updated, tree.source).text, operator);
        const values = assignments.assignmentValues(updated, tree.source);
        assert.deepEqual(values.map(n => tree.source.slice(n.start, n.end)), ['2', 'nil^']);
        if (operator !== ':=') assert(!expressions.expressionSites(tree).some(s => s.kind === 'binary' && s.start === updated.start && s.end === updated.end));
    }
    const call = await parse('var^a=0\na:=f()');
    assert(!lists.listInsertions(call).some(s => s.kind === 'reassign'));
    const tuple = await parse('var^a=0\nvar^b=0\na,b:=(1,2)');
    assert(!lists.listInsertions(tuple).some(s => s.kind === 'tuple'));
    const site = lists.listInsertions(tuple).find(s => s.kind === 'reassign');
    const changed = await parse(apply(tuple.source, lists.insertListEdit(tuple, site, 'binding')));
    assert.equal(changed.root.fields.items[2].fields.targets.length, 3);
    assert.equal(changed.root.fields.items[2].fields.values[0].fields.items.length, 3);
}));

test('implicit and parenthesized return lists grow inside a single result group', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts'), structures = load('graphStructure.ts');
    for (const source of ['let^f=f^{0}', 'let^f=f^{(0,1)}', 'let^f=f^{return^(0,1)}']) {
        let tree = await parse(source);
        for (let count = 0; count < 2; count++) {
            const node = flat(tree.root).find(n => n.kind === 'return');
            const before = node.fields.value.length;
            const site = lists.listInsertions(tree).find(s => s.kind === 'return' && s.before === undefined);
            tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'number')));
            assert.equal(flat(tree.root).find(n => n.kind === 'return').fields.value.length, before + 1, tree.source);
            assert(!flat(tree.root).some(n => n.kind === 'error'), tree.source);
        }
        const node = flat(tree.root).find(n => n.kind === 'return');
        if (tree.source.includes('return^')) tree = await parse(apply(tree.source, structures.editStructure(tree, node, 'return:implicit')));
        const implicit = flat(tree.root).find(n => n.kind === 'return');
        const values = implicit.fields.value.length;
        tree = await parse(apply(tree.source, structures.editStructure(tree, implicit, 'return:explicit')));
        assert.equal(flat(tree.root).find(n => n.kind === 'return').fields.value.length, values);
    }
}));

test('new empty error kinds omit payload braces and materialize them for the first field', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const lists = load('graphLists.ts');
    let tree = await parse('');
    tree = await parse(apply(tree.source, api.insertStatementEdit(tree, api.statementInsertions(tree)[0], 'error')));
    let definition = tree.root.fields.items[0];
    assert.equal(tree.source.slice(definition.fields.members[0].start, definition.fields.members[0].end), 'Failure');
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, lists.listInsertions(tree).find(s => s.kind === 'errordef'), 'error')));
    definition = tree.root.fields.items[0];
    const kind = definition.fields.members[1];
    assert(!tree.source.slice(kind.start, kind.end).includes('{'));
    const site = lists.listInsertions(tree).find(s => s.kind === 'error-kind' && s.start === kind.start);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'parameter')));
    assert.equal(tree.root.fields.items[0].fields.members[1].fields.members.length, 1);
    assert(!flat(tree.root).some(n => n.kind === 'error'));
}));

test('parallel binding deletion removes the matching target and written value together', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts'), assignments = load('graphAssignments.ts'), calls = load('graphCalls.ts');
    for (const source of ['let^a,b,c=1,2,3', 'let^a,b,c=(1,2,3)',
        'var^a=0\nvar^b=0\nvar^c=0\na,b,c:=1,2,3', 'var^a=0\nvar^b=0\nvar^c=0\na,b,c+=(1+2),3,4']) {
        for (let index = 0; index < 3; index++) for (const side of ['target', 'value']) {
            const tree = await parse(source), node = tree.root.fields.items.at(-1);
            const selected = side === 'target' ? node.fields.targets[index] : calls.bindingValues(node, tree.source)[index];
            const site = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === selected.start && s.end === selected.end);
            assert(site, source);
            const changed = await parse(apply(tree.source, deletion.deleteFromGraph(tree, site))), updated = changed.root.fields.items.at(-1);
            assert.equal(updated.fields.targets.length, 2, changed.source);
            assert.equal(calls.bindingValues(updated, changed.source).length, 2, changed.source);
            assert.deepEqual(updated.fields.targets.map(n => changed.source.slice(n.start, n.end)), ['a', 'b', 'c'].filter((_, i) => i !== index));
            if (node.kind === 'reassign') assert.equal(assignments.assignmentOperator(updated, changed.source).text, assignments.assignmentOperator(node, tree.source).text);
            assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
        }
    }
    const call = await parse('let^f=f^{(1,2)}\nlet^a,b=f()');
    const target = call.root.fields.items[1].fields.targets[0];
    const discarded = await parse(apply(call.source, deletion.deleteFromGraph(call, { ...target, category: 'element' })));
    assert.equal(discarded.source, 'let^f=f^{(1,2)}\nlet^_^,b=f()');
}));

test('deleting grouped list items preserves neighboring written groups and comment text', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const deletion = load('graphDelete.ts'), lists = load('graphLists.ts');
    for (const source of ['let^t={a=(1),#[keep]#b=(2)}', 'let^t={(1),(2),(3)}', 'let^f=f^{return^((1),(2),(3))}']) {
        const tree = await parse(source);
        const list = lists.commaLists(tree).find(s => ['table', 'return'].includes(s.node.kind));
        assert(list?.items.length > 1, source);
        for (const selected of list.items) {
            const site = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === selected.start && s.end === selected.end);
            assert(site, source);
            const changed = await parse(apply(tree.source, deletion.deleteFromGraph(tree, site)));
            const updated = lists.commaLists(changed).find(s => s.node.kind === list.node.kind);
            assert.equal(updated.items.length, list.items.length - 1, changed.source);
            assert(!flat(changed.root).some(n => n.kind === 'error'), changed.source);
            if (source.includes('#[keep]#')) assert(changed.source.includes('#[keep]#'));
        }
    }
}));

test('written pattern lists edit real values and alternatives without exposing generated comparisons', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const patterns = load('graphPatterns.ts'), lists = load('graphLists.ts'), deletion = load('graphDelete.ts');
    let tree = await parse('for^n{when^1 to^3,5:print(1) when^"box","carton":print(2) other^:print(3)}');
    let written = patterns.patternLists(tree);
    assert.deepEqual(written.map(list => list.items.map(n => n.kind)), [['pattern-range', 'int'], ['string', 'string']]);
    assert.equal(lists.operatorSites(tree).length, 0);
    assert(!expressions.expressionSites(tree).some(s => s.kind === 'binary'));
    const site = lists.listInsertions(tree).find(s => s.kind === 'pattern-list' && s.start === written[0].node.start && s.before === undefined);
    tree = await parse(apply(tree.source, lists.insertListEdit(tree, site, 'string')));
    written = patterns.patternLists(tree);
    assert.deepEqual(written[0].items.map(n => n.kind), ['pattern-range', 'int', 'string']);
    const selected = written[0].items[0], remove = deletion.deleteSites(tree).find(s => s.category === 'element' && s.start === selected.start && s.end === selected.end);
    tree = await parse(apply(tree.source, deletion.deleteFromGraph(tree, remove)));
    assert.deepEqual(patterns.patternLists(tree)[0].items.map(n => n.kind), ['int', 'string']);
    assert(tree.source.includes('when^5, ""'));
    assert(!flat(tree.root).some(n => n.kind === 'error'));
}));

test('inserting before a declaration keeps its leading comments and annotations attached', { timeout: 30000 }, async () => withLhatServer(async parse => {
    let tree = await parse('module^sample\n# keep\n@mark\nlet^value=1');
    const before = tree.root.fields.items[1];
    const site = api.statementInsertions(tree).find(s => s.before === before.start);
    tree = await parse(apply(tree.source, api.insertStatementEdit(tree, site, 'call')));
    assert(tree.source.indexOf('print(nil^)') < tree.source.indexOf('# keep'));
    assert(tree.source.indexOf('print(nil^)') < tree.source.indexOf('@mark'));
    const declaration = tree.root.fields.items.at(-1);
    assert.equal(declaration.kind, 'define');
    assert(declaration.comments?.some(c => tree.source.slice(c.start, c.end) === '# keep'));
}));

test('AST comparison ignores comment delimiter padding while retaining comment content and style', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const original = normalizedAst(await parse('######\n# Mock\n######\nlet^x=1'));
    assert.deepEqual(normalizedAst(await parse('# #####\n#Mock \n# #####\nlet^x=1')), original);
    assert.notDeepEqual(normalizedAst(await parse('# #####\n# Other\n# #####\nlet^x=1')), original);
    assert.notDeepEqual(normalizedAst(await parse('#[#####]#\n# Mock\n######\nlet^x=1')), original);
}));

test('AST comparison ignores empty block whitespace and type grouping while retaining types and structure', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { normalizedAst } = require('./graph-browser-host.cjs');
    const original = normalizedAst(await parse('let^f=p^x:string^|nil^{}'));
    assert.deepEqual(normalizedAst(await parse('let^f=p^x:(string^)|nil^{\n}')), original);
    assert.notDeepEqual(normalizedAst(await parse('let^f=p^x:(number^)|nil^{\n}')), original);
    assert.notDeepEqual(normalizedAst(await parse('let^f=p^x:(string^)|nil^{print(x)}')), original);
}));

test('empty branch insertion uses the branch header rather than the parser span of its next token', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['if^true^{el^false^:el^:}', 'for^n{when^0:when^1:other^:}', 'if^true^{el^false^: # keep\nel^:}']) {
        for (let index = 0; index < 3; index++) {
            const tree = await parse(source), statement = tree.root.fields.items[0], conditional = statement.kind === 'for' ? statement.fields.body : statement;
            const body = conditional.fields.items[index].fields.body;
            const site = api.statementInsertions(tree).find(s => s.kind === 'block' && s.start === body.start && s.end === body.end && s.before === undefined);
            assert(site, source);
            const updated = await parse(apply(tree.source, api.insertStatementEdit(tree, site, 'call')));
            const result = updated.root.fields.items[0], branches = (result.kind === 'for' ? result.fields.body : result).fields.items;
            assert.equal(branches[index].fields.body.fields.items?.length, 1, updated.source);
            branches.filter((_, i) => i !== index).forEach(branch => assert.equal(branch.fields.body.fields?.items?.length ?? 0, 0, updated.source));
            assert(!flat(updated.root).some(n => n.kind === 'error'), updated.source);
        }
    }
}));
