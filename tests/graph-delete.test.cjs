const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const entry = path.resolve(__dirname, '../src/graphDelete.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { deleteSites, deleteFromGraph } = mod.exports;
const apply = (tree, site) => {
    const edit = deleteFromGraph(tree, site);
    return tree.source.slice(0, edit.start) + edit.text + tree.source.slice(edit.end);
};
const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: start + 1, fields });

test('list deletion preserves neighbour comments, braces and trailing commas', () => {
    for (const source of ['{ 1, 2, 3 }', '{ 1, #[keep]# 2, 3, }']) {
        const items = ['1', '2', '3'].map(text => n('int', source.indexOf(text), source.indexOf(text) + 1));
        const tree = { source, root: n('table', 0, source.length, { items }) };
        for (const site of deleteSites(tree)) {
            const result = apply(tree, site);
            assert(!result.includes(source.slice(site.start, site.end)));
            for (const item of items.filter(item => item.start !== site.start)) assert(result.includes(source.slice(item.start, item.end)));
            assert.equal((result.match(/,/g) ?? []).length, source.endsWith(', }') ? 2 : 1);
            if (source.includes('#[')) assert(result.includes('#[keep]#'));
            assert(result.startsWith('{') && result.endsWith('}'));
        }
    }
    const tree = { source: '{ 1 }', root: n('table', 0, 5, { items: [n('int', 2, 3)] }) };
    assert.equal(apply(tree, deleteSites(tree)[0]), '{  }');
    assert.equal(deleteFromGraph(tree, { category: 'element', start: 0, end: 5 }), undefined);
});

test('statement deletion removes an entire source-backed statement but leaves adjacent code', () => {
    const source = 'first();\r\nsecond()';
    const tree = { source, root: n('block', 0, source.length, { items: [n('call-stmt', 0, 7), n('call-stmt', 10, 18)] }) };
    assert.equal(apply(tree, deleteSites(tree)[0]), '\r\nsecond()');
    assert.equal(apply(tree, deleteSites(tree)[1]), 'first();\r\n');
    assert.equal(deleteFromGraph(tree, { category: 'statement', start: 1, end: 7 }), undefined);
});

test('list deletion includes grouping omitted from AST spans and keeps adjacent comments', () => {
    const source = '{((1)),# first\n(2),#[last]#(3)}';
    const items = ['1', '2', '3'].map(text => n('int', source.indexOf(text), source.indexOf(text) + 1));
    const tree = { source, root: n('table', 0, source.length, { items }) };
    const expected = ['{# first\n(2),#[last]#(3)}', '{((1)),# first\n#[last]#(3)}', '{((1)),# first\n(2)#[last]#}'];
    deleteSites(tree).forEach((site, index) => assert.equal(apply(tree, site), expected[index]));
});
