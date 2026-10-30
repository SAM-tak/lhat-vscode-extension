const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { withLhatServer } = require('./lhat-server.cjs');
const entry = path.resolve(__dirname, '../src/graphStructure.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { structureSites, structureTemplates, editStructure } = mod.exports;
const nodes = node => [node, ...Object.values(node.fields ?? {}).flat().flatMap(nodes)];

test('finally statement menus forbid returning from cleanup but reset the restriction at a nested callable', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), statements = load('graphStatements.ts');
    const tree = await parse('do^{finally^: do^{} let^nested=p^{}}');
    const sites = statements.statementInsertions(tree).filter(site => site.before === undefined);
    const final = nodes(tree.root).find(node => node.kind === 'loop-clause');
    const nested = nodes(tree.root).find(node => node.kind === 'func');
    for (const site of sites.filter(site => site.start >= final.start && site.end <= final.end && site.start < nested.start)) {
        assert(!statements.statementTemplates(tree, site).some(c => c.id === 'return'));
        assert.equal(statements.insertStatementEdit(tree, site, 'return'), undefined);
    }
    const body = nested.fields.body, inside = sites.find(site => site.start === body.start && site.end === body.end);
    assert(statements.statementTemplates(tree, inside).some(c => c.id === 'return'));
}));

test('catch and finally structures preserve main code and enforce the final catch-all across braced scopes', { timeout: 60000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), deletion = load('graphDelete.ts');
    for (const source of ['do^{print(1)}', 'if^true^{print(1)}', 'let^f=f^{print(1)}', 'with^x=nil^{print(1)}',
        'repeat^2{pre^:print(0) main^:print(1) last^:print(2)}']) {
        let tree = await parse(source);
        const owner = () => source.startsWith('let^') ? tree.root.fields.items[0].fields.values[0] : tree.root.fields.items[0];
        const scope = () => ['func','repeat'].includes(owner().kind) ? owner().fields.body : owner().kind === 'with' ? owner().fields.extra[0] : owner();
        const edit = async (site, action) => {
            const change = editStructure(tree, site, action); assert(change, action);
            tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
            assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
            assert(tree.source.includes('print(1)'), tree.source);
        };
        await edit(owner(), 'catch:all');
        await edit(owner(), 'catch:add');
        await edit(scope().fields.arms[0], 'catch:filter:E.First | E.Second');
        assert.equal(scope().fields.arms[0].fields.condition.kind, 'type-union');
        assert(!structureTemplates(tree, owner()).some(c => c.id === 'catch:all'));
        assert.equal(editStructure(tree, scope().fields.arms[0], 'catch:unfiltered'), undefined);
        for (const value of ['number^','E;print(9)','E|','E..First','f^'])
            assert.equal(editStructure(tree, scope().fields.arms[0], `catch:filter:${value}`), undefined, value);
        await edit(owner(), owner().kind === 'repeat' ? 'section:finally^' : 'finally:add');
        const bare = scope().fields.arms[1];
        const change = deletion.deleteFromGraph(tree, { ...bare, category: 'element' });
        assert(change);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
        assert.equal(scope().fields.arms.length, 1);
        assert(tree.source.includes('finally^:'));
        await edit(scope().fields.arms[0], 'catch:unfiltered');
        assert(!scope().fields.arms[0].fields.condition);
        await edit(owner(), 'remove-catch:0');
        assert.equal(scope().fields.arms?.length ?? 0, 0);
        assert(tree.source.includes('finally^:'));
        if (source.startsWith('repeat^')) assert(tree.source.includes('last^:print(2)'));
    }
}));

test('handler deletion and loop section changes preserve empty boundaries and adjacent comments', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), deletion = load('graphDelete.ts');
    let tree = await parse('repeat^2{pre^:print(0) main^:print(1) catch^ #[keep]# E.First: catch^: last^:print(2) finally^:print(3)}');
    const loop = () => tree.root.fields.items[0];
    const edit = async action => {
        const change = editStructure(tree, loop(), action); assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    };
    const arm = loop().fields.body.fields.arms[0];
    const filtered = editStructure(tree, arm, 'catch:filter:E.Other');
    tree = await parse(tree.source.slice(0, filtered.start) + filtered.text + tree.source.slice(filtered.end));
    assert(tree.source.includes('#[keep]# E.Other:'), tree.source);
    await edit('remove-section:main^');
    assert.equal(loop().fields.body.fields.arms.length, 2);
    await edit('remove-section:pre^');
    await edit('section:first^');
    assert.equal(loop().fields.body.fields.arms.length, 2);
    assert(tree.source.includes('last^:print(2)') && tree.source.includes('finally^:print(3)'));
    tree = await parse('repeat^2{}');
    assert(!structureTemplates(tree, tree.root.fields.items[0].fields.body).some(c => c.id === 'finally:add'));
    tree = await parse('if^true^{do^{} el^:print(2)}');
    const branchBody = tree.root.fields.items[0].fields.items[0].fields.body;
    assert(!structureTemplates(tree, branchBody).some(c => c.id.startsWith('catch:')));
    tree = await parse('do^{print(1) catch^: finally^:print(3)}');
    const block = tree.root.fields.items[0], final = block.fields.extra[0];
    const change = deletion.deleteFromGraph(tree, { ...final, category: 'element' });
    assert(change);
    tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
    assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    assert.equal(tree.root.fields.items[0].fields.arms.length, 1);
}));

test('real parser preserves branch bodies when adding and removing conditional and else arms', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['if^true^ { print(1) }', 'let^x = if^true^: 1 el^: 2;']) {
        let tree = await parse(source);
        const edit = async action => {
            const site = structureSites(tree).find(s => ['if-stmt', 'if-expr'].includes(s.kind)), change = editStructure(tree, site, action);
            assert(change, action);
            tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
            assert(!nodes(tree.root).some(n => n.kind === 'error'));
            return nodes(tree.root).find(n => n.kind === site.kind).fields.items;
        };
        const before = nodes(tree.root).find(n => n.kind.startsWith('if-')).fields.items.length;
        assert.equal((await edit('branch')).length, before + 1);
        assert.equal((await edit('remove-branch:1')).length, before);
        if (before === 1) assert.equal((await edit('else')).length, 2);
        assert(tree.source.includes(source.startsWith('let^') ? '1' : 'print(1)'));
    }
}));

test('real parser keeps implicit loop main statements while adding earlier and later sections', { timeout: 30000 }, async () => withLhatServer(async parse => {
    let tree = await parse('repeat^3 { print(1) }');
    for (const action of ['section:pre^', 'section:first^', 'section:last^', 'section:epilog^', 'section:finally^', 'remove-section:first^']) {
        const change = editStructure(tree, structureSites(tree)[0], action);
        assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        const loop = tree.root.fields.items[0], body = loop.fields.body;
        assert.equal(body.fields.items.length, 1, tree.source);
        assert.equal(body.fields.items[0].kind, 'call-stmt');
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    assert(!tree.source.includes('first^:'));
    assert(tree.source.includes('pre^:') && tree.source.includes('epilog^:'));
}));


test('loop mode changes retain the complete body and all sections through real reanalysis', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const body = '{ pre^: print("pre") main^: print("main") last^: print("last") epilog^: print("end") }';
    let tree = await parse('repeat^3 ' + body);
    for (const action of ['mode:while', 'mode:until', 'mode:count', 'mode:forever', 'mode:range', 'mode:while', 'mode:until', 'mode:range']) {
        const change = editStructure(tree, structureSites(tree)[0], action);
        assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        const loop = tree.root.fields.items[0];
        assert.equal(tree.source.slice(loop.fields.body.start, loop.fields.body.end), body);
        assert(!nodes(tree.root).some(n => n.kind === 'error'));
        if (action === 'mode:range') assert.equal(loop.kind, 'for');
        if (action === 'mode:while') assert(tree.source.includes('while^'));
        if (action === 'mode:until') assert(tree.source.includes('until^'));
    }
}));


test('every offered loop mode preserves all body sections across counted, conditional, range and iterator forms', { timeout: 60000 }, async () => withLhatServer(async parse => {
    const body = '{ pre^:print("pre") main^:print("body") last^:print("last") epilog^:print("end") finally^:print("cleanup") }';
    const offered = new Set();
    for (const header of ['repeat^3', 'repeat^', 'repeat^while^true^', 'repeat^until^false^',
        'for^i from^0 downto^3 step^2', 'for^var^i=0 while^i<3 next^i+=1',
        'for^var^i=0 until^i>=3 next^i+=1', 'for^i in^{1,2}', 'for^key,value in^{1,2}']) {
        const tree = await parse(header + ' ' + body), site = structureSites(tree)[0];
        const choices = structureTemplates(tree, site).filter(choice => choice.id.startsWith('mode:'));
        assert(choices.length, header);
        for (const choice of choices) {
            offered.add(choice.id);
            const edit = editStructure(tree, site, choice.id);
            const changed = await parse(tree.source.slice(0, edit.start) + edit.text + tree.source.slice(edit.end));
            const loop = changed.root.fields.items[0];
            assert(['for', 'repeat'].includes(loop.kind), `${header}: ${choice.id}`);
            assert.equal(changed.source.slice(loop.fields.body.start, loop.fields.body.end), body, `${header}: ${choice.id}`);
            assert(!nodes(changed.root).some(n => n.kind === 'error'), `${header}: ${choice.id}`);
            if (choice.id === 'mode:iterator') assert(changed.source.includes('in^'));
            if (choice.id === 'mode:range') assert(changed.source.includes('from^') && changed.source.includes('to^'));
        }
    }
    assert.deepEqual([...offered].sort(), ['mode:count', 'mode:forever', 'mode:iterator', 'mode:range', 'mode:until', 'mode:while']);
}));

test('removing the first branch promotes the next arm without losing its body', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['if^true^ { print(1) el^false^: print(2) el^: print(3) }',
        'if^true^ { print(1) el^: print(2) }', 'if^true^ { print(1) }',
        'let^v = if^true^: 1 el^false^: 2 el^: 3;', 'let^v = if^true^: 1 el^: 2;']) {
        const tree = await parse(source), site = structureSites(tree).find(s => ['if-stmt', 'if-expr'].includes(s.kind));
        const change = editStructure(tree, site, 'remove-branch:0');
        assert(change);
        const updated = await parse(source.slice(0, change.start) + change.text + source.slice(change.end));
        assert(!nodes(updated.root).some(n => n.kind === 'error'), updated.source);
        assert(!nodes(updated.root).some(n => n.kind === 'int' && updated.source.slice(n.start, n.end) === '1'));
        if (source.includes('2')) assert(nodes(updated.root).some(n => n.kind === 'int' && updated.source.slice(n.start, n.end) === '2'));
    }
}));


test('real pattern match branches and pattern shapes can be created and removed', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['for^1 { when^0: print(1) other^: print(2) }', 'let^x = for^1: when^0: 1 other^: 2;']) {
        let tree = await parse(source);
        for (const action of ['match-branch', 'pattern:0:range', 'pattern:0:choices', 'pattern:0:type', 'pattern:0:string', 'remove-match:0']) {
            const site = structureSites(tree).find(s => s.kind === 'for');
            const change = editStructure(tree, site, action);
            assert(change, action);
            tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
            assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
            const match = nodes(tree.root).find(n => n.kind === 'for');
            assert.equal(match.fields.body.fields.items.length, action === 'remove-match:0' ? 2 : 3);
        }
    }
}));

test('loop focus and advance controls preserve grouped initializers, conditions and complete bodies', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const body = '{ pre^: print("pre") main^: print(i) epilog^: print("end") }';
    for (const initial of ['0', '(1 + 2)']) {
        let tree = await parse(`var^i=5\nfor^var^i = ${initial} while^i<5 next^i+=1 ${body}`);
        for (const action of ['focus:existing', 'next:remove', 'next:add', 'focus:mutable']) {
            const site = structureSites(tree).find(s => s.kind === 'for');
            const change = editStructure(tree, site, action); assert(change, action);
            tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
            const loop = tree.root.fields.items[1];
            assert.equal(loop.fields.focus[0].kind, action === 'focus:mutable' ? 'define' : 'reassign');
            assert.equal(loop.fields.advance?.length ?? 0, action === 'next:remove' ? 0 : 1);
            assert.equal(tree.source.slice(loop.fields.body.start, loop.fields.body.end), body);
            assert(tree.source.includes(initial)); assert(tree.source.includes('while^i<5'));
            assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
        }
    }
}));

test('range direction and step controls retain bounds and all body sections', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const body = '{ first^: print(i) main^: print(i) last^: print(i) }';
    let tree = await parse(`for^i from^10 to^20 ${body}`);
    for (const action of ['direction', 'step:add', 'direction', 'step:remove']) {
        const site = structureSites(tree).find(s => s.kind === 'for');
        const change = editStructure(tree, site, action); assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        const loop = tree.root.fields.items[0];
        assert.equal(tree.source.slice(loop.fields.body.start, loop.fields.body.end), body);
        assert.equal(tree.source.slice(loop.fields.bound.start, loop.fields.bound.end), '20');
        assert.equal(tree.source.slice(loop.fields.focus[0].fields.values[0].start, loop.fields.focus[0].fields.values[0].end), '10');
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    assert(!tree.source.includes('step^'));
}));

test('while and until switching preserves the written header including grouping and comments', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const source of ['repeat^while^(1+2)*3>4{}', 'for^var^i=(1+2)*3 while^(i+1)>0 #[condition]# next^i+=1{}']) {
        const tree = await parse(source), site = structureSites(tree).find(s => ['repeat', 'for'].includes(s.kind));
        const change = editStructure(tree, site, 'mode:until'); assert(change);
        const updated = source.slice(0, change.start) + change.text + source.slice(change.end);
        assert.equal(updated, source.replace('while^', 'until^'));
        assert(!nodes((await parse(updated)).root).some(n => n.kind === 'error'), updated);
    }
    for (const [source, action] of [['for^i from^0 to^5{}', 'step:add'], ['for^var^i=0 while^i<5{}', 'next:add']]) {
        const tree = await parse(source), site = structureSites(tree).find(s => s.kind === 'for');
        const change = editStructure(tree, site, action); assert(change);
        const updated = source.slice(0, change.start) + change.text + source.slice(change.end);
        assert(!nodes((await parse(updated)).root).some(n => n.kind === 'error'), updated);
    }
}));

test('loop body comments attach to the body and empty explicit main sections accept new statements', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), statements = load('graphStatements.ts');
    let tree = await parse('repeat^3{pre^:main^:last^:epilog^:}');
    let loop = tree.root.fields.items[0];
    const comment = editStructure(tree, loop, 'body:comment'); assert(comment);
    tree = await parse(tree.source.slice(0, comment.start) + comment.text + tree.source.slice(comment.end));
    loop = tree.root.fields.items[0];
    assert.equal(loop.fields.body.comments.length, 1);
    const body = loop.fields.body;
    const site = statements.statementInsertions(tree).find(s => s.kind === 'block' && s.start === body.start && s.before === undefined);
    assert(site);
    const change = statements.insertStatementEdit(tree, site, 'call');
    tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
    const updated = tree.root.fields.items[0].fields.body;
    assert.equal(updated.fields.items[0].kind, 'call-stmt');
    assert.equal(updated.fields.extra.length, 3);
    assert(!updated.fields.extra.some(c => c.fields?.body?.length));
    assert.equal(updated.comments.length, 1);
}));

test('assignment structure controls change the written operator and keep paired RHS expressions', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), assignments = load('graphAssignments.ts'), lists = load('graphLists.ts');
    let tree = await parse('var^a=1\nvar^b=2\na,b := (1+2),3');
    for (const action of ['assignment:+=', 'assignment:nil-check', 'assignment:*=', 'assignment:nil-check', 'assignment::=']) {
        const node = tree.root.fields.items[2], change = editStructure(tree, node, action); assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        const updated = tree.root.fields.items[2];
        assert.equal(updated.fields.targets.length, 2);
        assert.deepEqual(assignments.assignmentValues(updated, tree.source).map(n => tree.source.slice(n.start, n.end)), ['1+2', '3']);
        assert.equal(lists.groupedOperatorSites(tree).length, 1, tree.source);
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    assert.equal(assignments.assignmentOperator(tree.root.fields.items[2], tree.source).text, ':=');
}));

test('type construction uses scoped definitions and builds nullable and sequence annotations', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), types = load('graphTypes.ts'), structure = load('graphStructure.ts');
    let tree = await parse('let^Item=def^{self^{name=""}}\nlet^f=f^items:any^{}');
    const name = () => tree.root.fields.items[1].fields.values[0].fields.params[0].fields.name;
    const site = () => {
        const annotation = types.typeSites(tree).find(s => s.start === name().start).annotation;
        return structureSites(tree).filter(s => s.kind.startsWith('type-') && s.start >= annotation.start && s.end <= annotation.end)
            .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    };
    for (const action of ['type:name:Item', 'type:sequence', 'type:nullable']) {
        const change = editStructure(tree, site(), action); assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
    }
    assert(tree.source.includes('t^{(Item)[]}'));
    assert(tree.source.includes('|nil^'));
    tree = await parse('let^Item=def^{}\nlet^f=f^Item:number^,x:any^{}');
    const candidates = structure.structureTemplates(tree, structureSites(tree).find(s => s.kind === 'type-name' && tree.source.slice(s.start, s.end) === 'any^'));
    assert(!candidates.some(c => c.id === 'type:name:Item'));
    assert.equal(editStructure(tree, site(), 'type:name:Injected; print(1)'), undefined);
}));

test('iterator mode and key controls preserve the body and expose written iterator names once', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs'), loops = load('graphLoops.ts'), lists = load('graphLists.ts'), expressions = load('graphExpressions.ts');
    let tree = await parse('for^i from^0 to^3{print(i)}');
    for (const action of ['mode:iterator', 'iterator:key:add', 'iterator:key:remove', 'mode:while', 'mode:range', 'mode:iterator']) {
        const node = tree.root.fields.items[0], change = editStructure(tree, node, action); assert(change, action);
        tree = await parse(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end));
        const updated = tree.root.fields.items[0], names = loops.iteratorNames(updated, tree.source);
        assert(tree.source.includes('print(i)'));
        assert(!nodes(tree.root).some(n => n.kind === 'error'), tree.source);
        if (action.startsWith('iterator:') || action === 'mode:iterator') {
            assert.equal(names.length, action === 'iterator:key:add' ? 2 : 1);
            assert(!lists.listInsertions(tree).some(s => s.kind === 'for' && s.field === 'focus'));
            assert(!names.some(name => expressions.expressionSites(tree).some(s => s.start === name.start && s.end === name.end)));
        }
    }
    const graph = load('webview/map.ts').toElk(tree), name = loops.iteratorNames(tree.root.fields.items[0], tree.source)[0];
    const all = node => [node, ...(node.children ?? []).flatMap(all)];
    assert.equal(all(graph).filter(n => n.lhat?.labelParts?.some(part => part.name?.start === name.start)).length, 1);
    const typed = await parse('let^items={1}\nfor^key:number^,value:number^ in^items{print(value)}');
    const typedGraph = load('webview/map.ts').toElk(typed);
    for (const name of loops.iteratorNames(typed.root.fields.items[1], typed.source))
        assert.equal(all(typedGraph).filter(n => n.lhat?.labelParts?.some(part => part.name?.start === name.start)).length, 1);
}));

test('focused conditions draw one predicate and exhaustive arms stop the enclosing sequence', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const { load } = require('./graph-browser-host.cjs');
    const tree = await parse('let^f=p^{for^let^d=1 if^d>0{return^1 el^:return^2} print(3)}');
    const graph = load('webview/map.ts').toElk(tree, { collapse: false });
    const all = n => [n, ...(n.children ?? []).flatMap(all)];
    const boxes = all(graph), focused = boxes.find(n => n.lhat?.kind === 'for');
    assert.equal(boxes.filter(n => n.lhat?.kind === 'condition').length, 1);
    assert.equal(boxes.filter(n => n.lhat?.operatorExpression).length, 1);
    assert.equal(focused.lhat.executionTerminal, true);
    const after = boxes.find(n => n.lhat?.start === tree.source.indexOf('print'));
    assert.equal(after.lhat.unreachable, true);
}));
