const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const entry = path.resolve(__dirname, '../src/graphTextFields.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { textFields, editTextField } = mod.exports;
const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: 1, fields });

test('module field edits validate names and derive the editable range again', () => {
    const source = 'module^example.name';
    const tree = { source, root: n('module', 0, source.length, { name: n('member', 7, source.length) }) };
    const field = textFields(tree)[0];
    assert.equal(field.value, 'example.name');
    assert.deepEqual(editTextField(tree, { ...field.site, part: { start: 0, end: 1 } }, 'new.name'), { start: 7, end: source.length, text: 'new.name' });
    for (const value of ['x\nprint(1)', '', 'x..y', 'x;']) assert.equal(editTextField(tree, field.site, value), undefined);
});

test('comment edits keep following code outside comments and reject unbalanced block delimiters', () => {
    for (const [raw, block] of [['# old', false], ['#[ old ]#', true]]) {
        const source = raw + '\r\nprint(1)', tree = { source, root: { ...n('block', 0, source.length), comments: [{ start: 0, end: raw.length, block }] } };
        const field = textFields(tree)[0];
        const edit = editTextField(tree, field.site, '日本語\nsecond');
        const result = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
        assert(result.endsWith('\r\nprint(1)'));
        assert(result.includes(block ? '#[ 日本語\nsecond ]#' : '# 日本語\r\n# second'));
        if (block) for (const value of [']# print(2)', '#[ unfinished', '~ disabled']) assert.equal(editTextField(tree, field.site, value), undefined);
    }
});
