const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { graphTreeForDocument } = load('graphSource.ts');
const { statementInsertions, insertStatementEdit } = load('graphStatements.ts');
const { listInsertions, insertListEdit } = load('graphLists.ts');
const source = '# 日本語😀\nlet^ 値 = 1\n#[ 複数行\n 注釈 ]#\nprint(値)\n';
function fixture() {
    const node = (kind, text, fields) => ({ kind, start: source.indexOf(text), end: source.indexOf(text) + text.length,
        line: source.slice(0, source.indexOf(text)).split('\n').length, column: 1, fields });
    const definition = node('define', 'let^ 値 = 1', { targets: [node('ident', '値')], values: [node('int', '1')] });
    const call = node('call-stmt', 'print(値)');
    call.comments = [{ start: source.indexOf('#['), end: source.indexOf(']#') + 2, block: true }];
    return { source, root: node('block', source, { items: [definition, call] }) };
}
const flatten = node => [node, ...(node.comments ?? []), ...Object.values(node.fields ?? {}).flatMap(child =>
    (Array.isArray(child) ? child : [child]).flatMap(flatten))];

test('normalized AST offsets map to the original CRLF, CR and BOM text including Unicode and comments', () => {
    const tree = fixture(), original = JSON.stringify(tree);
    assert.equal(graphTreeForDocument(tree, source), tree);
    for (const document of [source.replace(/\n/g, '\r\n'), source.replace(/\n/g, '\r'), '\uFEFF' + source.replace(/\n/g, '\r\n')]) {
        const mapped = graphTreeForDocument(tree, document);
        assert.equal(mapped.source, document);
        const old = flatten(tree.root), converted = flatten(mapped.root);
        old.forEach((span, i) => {
            const expectedStart = (document.startsWith('\uFEFF') ? 1 : 0) + span.start +
                (document.includes('\r\n') ? (source.slice(0, span.start).match(/\n/g) ?? []).length : 0);
            assert.equal(converted[i].start, expectedStart);
            assert.equal(document.slice(converted[i].start, converted[i].end).replace(/\r\n?/g, '\n'), source.slice(span.start, span.end));
        });
    }
    assert.equal(JSON.stringify(tree), original, 'the cached server snapshot is unchanged');
});

test('normalization never accepts a stale snapshot with changed code, comments or whitespace', () => {
    for (const changed of [source.replace('1', '2'), source.replace('日本語', '変更'), source.replace('let^ ', 'let^  ')]) {
        assert.equal(graphTreeForDocument(fixture(), changed.replace(/\n/g, '\r\n')), undefined);
    }
});

test('statement and variable additions use remapped positions and preserve existing CRLF text', () => {
    const document = source.replace(/\n/g, '\r\n'), tree = graphTreeForDocument(fixture(), document);
    const apply = edit => document.slice(0, edit.start) + edit.text + document.slice(edit.end);
    const beforeCall = statementInsertions(tree).find(site => site.before === document.indexOf('print'));
    assert.equal(apply(insertStatementEdit(tree, beforeCall, 'let')), document.replace('print(値)', 'let^ value = 0\r\nprint(値)'));
    const appendBinding = listInsertions(tree).find(site => site.field === 'targets' && site.before === undefined);
    assert.equal(apply(insertListEdit(tree, appendBinding, 'binding')), document.replace('let^ 値 = 1', 'let^ 値, _^ = 1, nil^'));
});
