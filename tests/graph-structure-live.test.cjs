const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { withLhatServer } = require('./lhat-server.cjs');
const entry = path.resolve(__dirname, '../src/graphStructure.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { structureSites, editStructure } = mod.exports;
const nodes = node => [node, ...Object.values(node.fields ?? {}).flat().flatMap(nodes)];

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
    for (const action of ['section:pre^', 'section:first^', 'section:last^', 'section:epilog^', 'remove-section:first^']) {
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
