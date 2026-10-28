const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve(__dirname, '../src/graphReorder.ts');
const mod = new Module(entry);
mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { reorderEdit, reorderSites } = mod.exports;
const mapEntry = path.resolve(__dirname, '../src/webview/map.ts');
const map = new Module(mapEntry);
map._compile(buildSync({ entryPoints: [mapEntry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, mapEntry);
const { toElk } = map.exports;
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];

function node(source, kind, text, fields, from = 0) {
    const start = source.indexOf(text, from); assert(start >= 0, text);
    return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
}

function apply(source, edit) {
    return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

test('block statements share one reorder marker and rewrite only their sibling range', () => {
    const source = 'first()\nsecond()\nthird()';
    const first = node(source, 'call-stmt', 'first()');
    const second = node(source, 'call-stmt', 'second()');
    const third = node(source, 'call-stmt', 'third()');
    const tree = { source, root: node(source, 'block', source, { items: [first, second, third] }) };
    const sites = reorderSites(tree);
    assert.deepEqual(sites.map(site => [site.kind, site.start, site.end]), [
        ['statement', first.start, first.end], ['statement', second.start, second.end], ['statement', third.start, third.end],
    ]);
    const edit = reorderEdit(tree, { sourceStart: first.start, sourceEnd: first.end,
        targetStart: third.start, targetEnd: third.end, before: false });
    assert(edit);
    assert.equal(apply(source, edit), 'second()\nthird()\nfirst()');
});

test('table entries use the same list edit while retaining the list separators', () => {
    const source = '{ first = 1, second = 2, third = 3 }';
    const first = node(source, 'table-entry', 'first = 1');
    const second = node(source, 'table-entry', 'second = 2');
    const third = node(source, 'table-entry', 'third = 3');
    const tree = { source, root: node(source, 'table', source, { items: [first, second, third] }) };
    const sites = reorderSites(tree);
    assert(sites.every(site => site.kind === 'element' && site.list === sites[0].list));
    const edit = reorderEdit(tree, { sourceStart: third.start, sourceEnd: third.end,
        targetStart: first.start, targetEnd: first.end, before: true });
    assert(edit);
    assert.equal(apply(source, edit), '{ third = 3, first = 1, second = 2 }');
});

test('member lists use their AST field name but the same element reorder protocol', () => {
    const source = 'enum^Mode { Idle, Walk, Dash }';
    const idle = node(source, 'enum-member', 'Idle');
    const walk = node(source, 'enum-member', 'Walk');
    const dash = node(source, 'enum-member', 'Dash');
    const tree = { source, root: node(source, 'enumdef', source, { members: [idle, walk, dash] }) };
    const sites = reorderSites(tree);
    assert(sites.every(site => site.kind === 'element' && site.list === sites[0].list));
    const edit = reorderEdit(tree, { sourceStart: dash.start, sourceEnd: dash.end,
        targetStart: idle.start, targetEnd: idle.end, before: true });
    assert(edit);
    assert.equal(apply(source, edit), 'enum^Mode { Dash, Idle, Walk }');
});

test('renderer receives only direct reorder markers, so every marked box uses the shared control', () => {
    const source = 'first()\nsecond()';
    const first = node(source, 'call-stmt', 'first()');
    const second = node(source, 'call-stmt', 'second()');
    const root = node(source, 'block', source, { items: [first, second] });
    const marked = flatten(toElk({ source, root }))
        .filter(item => item.lhat?.reorder)
        .map(item => [item.lhat.kind, item.lhat.reorder.start, item.lhat.reorder.end]);
    assert.deepEqual(marked, [
        ['call-stmt', first.start, first.end], ['call-stmt', second.start, second.end],
    ]);
});

test('different lists, identical items and malformed ranges never produce a source edit', () => {
    const source = 'a()\nb()';
    const a = node(source, 'call-stmt', 'a()'), b = node(source, 'call-stmt', 'b()');
    const tree = { source, root: node(source, 'block', source, { items: [a, b] }) };
    assert.equal(reorderEdit(tree, { sourceStart: a.start, sourceEnd: a.end,
        targetStart: a.start, targetEnd: a.end, before: true }), undefined);
    assert.equal(reorderEdit(tree, { sourceStart: a.start, sourceEnd: a.end,
        targetStart: 99, targetEnd: 100, before: true }), undefined);
});
