const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const entry = path.resolve(__dirname, '../src/graphTextFields.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { textFields, editTextField } = mod.exports;
const commentsEntry = path.resolve(__dirname, '../src/graphComments.ts'), commentsMod = new Module(commentsEntry);
commentsMod._compile(require('esbuild').buildSync({ entryPoints: [commentsEntry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, commentsEntry);
const { editComment, commentBlocks } = commentsMod.exports;
const n = (kind, start, end, fields) => ({ kind, start, end, line: 1, column: 1, fields });

test('comment controls preserve CRLF and indentation and reject partial block deletion', () => {
    const source = '\tlet^x=1\r\nprint(x)';
    const declaration = n('define', 1, 8);
    const tree = { source, root: n('block', 0, source.length, { items: [declaration] }) };
    const add = editComment(tree, declaration, 'add');
    assert.equal(source.slice(0, add.start) + add.text + source.slice(add.end), '\t# comment\r\n\tlet^x=1\r\nprint(x)');
    const commented = '\t# one\r\n\t# two\r\n' + source;
    const comments = [...commented.matchAll(/#[^\r\n]*/g)].map(m => ({ start: m.index, end: m.index + m[0].length, block: false }));
    const owner = { ...declaration, comments };
    const updated = { source: commented, root: n('block', 0, commented.length, { items: [owner] }) };
    const block = commentBlocks(commented, owner)[0], remove = editComment(updated, block, 'remove');
    assert.equal(commented.slice(0, remove.start) + remove.text + commented.slice(remove.end), source);
    assert.equal(editComment(updated, comments[0], 'remove'), undefined);
    assert.equal(editComment(tree, { start: 100, end: 110 }, 'add'), undefined);
});

test('consecutive comments edit as blocks while blank lines, inline notes and block delimiters stay separate', () => {
    const source = '\t# first\r\n\t# second\r\n\r\n\t# main\r\n\t# continuation\r\n\t@export speed = 400 # inline\r\n#[ block ]#\r\n# last';
    const comments = [...source.matchAll(/#\[.*?\]#|#[^\r\n]*/g)].map(m => ({ start: m.index, end: m.index + m[0].length, block: m[0].startsWith('#[') }));
    const tree = { source, root: { ...n('block', 0, source.length), comments } };
    const before = JSON.stringify(tree), fields = textFields(tree);
    assert.deepEqual(fields.map(f => f.value), ['first\nsecond', 'main\ncontinuation', 'inline', 'block', 'last']);
    const edit = editTextField(tree, fields[1].site, 'changed\n日本語\nthird');
    assert.equal(source.slice(0, edit.start) + edit.text + source.slice(edit.end), source.replace('# main\r\n\t# continuation', '# changed\r\n\t# 日本語\r\n\t# third'));
    assert.equal(JSON.stringify(tree), before);
});

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
