const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
function load(file, vscode) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { annotationOwners, editAnnotation, validAnnotation } = load('graphAnnotations.ts');
const { placeComments } = load('webview/comments.ts');
const fixture = require('./annotation-fixture.cjs');
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);
test('annotation recovery keeps unit and declaration ownership, Unicode spans and quoted commas', () => {
    const tree = fixture(), before = JSON.stringify(tree), owners = annotationOwners(tree);
    assert.equal(owners.length, 2);
    assert.deepEqual(owners.map(o => o.annotations.map(a => a.text)), [['@unit'], ['@range(0, 100, "a,b")', '@label("日本語😀")']]);
    assert(owners.every(o => o.annotations.every(a => tree.source.slice(a.start, a.end) === a.text)));
    assert.equal(JSON.stringify(tree), before);
});
test('annotation replacement and removal touch only the selected annotation', () => {
    const tree = fixture(), site = annotationOwners(tree)[1].annotations[0];
    const change = editAnnotation(tree, { ...site, value: '@renamed(-1, true^, HOST_NAME)' });
    assert.equal(apply(tree.source, change), tree.source.replace(site.text, '@renamed(-1, true^, HOST_NAME)'));
    assert.equal(apply(tree.source, editAnnotation(tree, { ...site, value: '' })), tree.source.replace(site.text, ''));
    assert.equal(editAnnotation(tree, { ...site, ownerStart: 999, value: '@bad' }), undefined);
    assert.equal(editAnnotation(tree, { ...site, end: site.end - 1, value: '@bad' }), undefined);
    assert.equal(editAnnotation(tree, { ...site, value: '@bad() let^ injected = 1' }), undefined);
});
test('adding annotations preserves indentation, BOM and CRLF', () => {
    const tree = fixture(), owner = annotationOwners(tree)[1];
    const request = { start: 0, end: 0, ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, add: true, value: '@new(2)' };
    assert(apply(tree.source, editAnnotation(tree, request)).includes('@new(2)\n@range'));
    const nestedSource = '\uFEFFmodule^"demo"\r\n{\r\n  let^ n = 1\r\n}';
    const node = { kind: 'define', start: nestedSource.indexOf('let^'), end: nestedSource.indexOf('1') + 1, line: 3, column: 3 };
    const nested = { source: nestedSource, root: { kind: 'block', start: 1, end: nestedSource.length, line: 1, column: 1, fields: { items: [node] } } };
    const edit = editAnnotation(nested, { ...request, ownerStart: node.start, ownerEnd: node.end });
    assert(apply(nestedSource, edit).includes('  @new(2)\r\n  let^ n'));
    const unit = editAnnotation(nested, { ...request, ownerStart: 1, ownerEnd: nestedSource.length, ownerKind: "block" });
    assert(apply(nestedSource, unit).startsWith('\uFEFF@new(2)\r\nmodule^'));
});
test('annotations at the unit head cannot silently be added to the first declaration', () => {
    const source = 'let^ x = 1', node = { kind: 'define', start: 0, end: source.length };
    const tree = { source, root: { kind: 'block', start: 0, end: source.length, fields: { items: [node] } } };
    assert.equal(annotationOwners(tree)[1].canAdd, false);
});
test('only literal and name arguments pass annotation validation', () => {
    for (const text of ['@name', '@名前(-2, 1.5, 1e-2, 0xff, HOST, true^, "a,)b")', '@a()', '@a(1,)']) assert(validAnnotation(text), text);
    for (const text of ['@', '@ a', '@a.b', '@a(x + 1)', '@a(foo())', '@a(1)\nlet^ x = 2', '@a("unterminated)', '@a\n(1)']) assert(!validAnnotation(text), text);
});
test('annotation layout reserves space, folds independently and restores hidden notes', () => {
    const tree = fixture(), node = tree.root.fields.items[1], sites = annotationOwners(tree)[1].annotations;
    const make = () => ({ id: 'root', width: 120, height: 90, children: [{ id: 'owner', x: 10, y: 10, width: 100, height: 30, lhat: { ...node } }] });
    const graph = placeComments(make(), tree), notes = graph.children.filter(c => c.lhat?.annotation);
    assert.equal(notes.length, 3);
    const owner = graph.children.find(c => c.id === 'owner');
    for (const note of notes.filter(n => n.lhat.commentAnchor)) {
        assert(note.y + note.height < owner.y);
        assert.equal(note.lhat.commentAnchor.id, owner.id);
    }
    const key = `${sites[0].start}:${sites[0].end}`;
    const hidden = placeComments(make(), tree, { hiddenAnnotations: { [key]: true } });
    assert.equal(hidden.children.filter(c => c.lhat?.annotation).length, 2);
    assert.equal(placeComments(make(), tree).children.filter(c => c.lhat?.annotation).length, 3);
    assert(placeComments(make(), tree, { collapseAll: true }).children.filter(c => c.lhat?.annotation).every(c => c.lhat.collapsed));
    const foldedOwner = make(); foldedOwner.children[0].lhat.collapsed = true;
    assert.equal(placeComments(foldedOwner, tree).children.filter(c => c.lhat?.annotation).length, 3);
    const drilled = { id: 'view', width: 120, height: 30, children: [] };
    assert.equal(placeComments(drilled, tree, { root: node }).children.filter(c => c.lhat?.annotation).length, 2);
});

test('recovery ignores annotation-like text in multiline strings and disabled code', () => {
    const source = 'module^"demo"\nlet^ text = """\n@fake\ntext\nlet^ x = 1';
    const start = source.indexOf('"""'), end = source.indexOf('let^ x');
    const tree = { source, root: { kind: 'block', start: 0, end: source.length, fields: { items: [
        { kind: 'string', start, end }, { kind: 'define', start: end, end: source.length },
    ] } } };
    assert(annotationOwners(tree).every(o => !o.annotations.length));
});

test('annotation host edits validate snapshot and apply exactly one undoable replacement', async () => {
    const tree = fixture(), site = annotationOwners(tree)[1].annotations[0], edits = [];
    const document = { uri: 'file:annotation', version: 7, getText: () => tree.source, positionAt: character => ({ line: 0, character }) };
    const mock = { l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { edits.push(edit); return true; } } };
    const { editStatementFromGraph } = load('graphStatementEditor.ts', mock);
    const message = { type: 'editAnnotation', id: 'edit', version: 7, ...site, value: '@updated(5)' };
    await editStatementFromGraph(document, tree, message, undefined, () => true);
    assert.equal(edits.length, 1); assert.equal(edits[0].changes.length, 1);
    assert.equal(edits[0].changes[0].range.start.character, site.start);
    assert.equal(edits[0].changes[0].text, '@updated(5)');
    for (const version of [6, 8]) await assert.rejects(editStatementFromGraph(document, tree, { ...message, version }, undefined, () => true));
    await assert.rejects(editStatementFromGraph(document, tree, message, undefined, () => false));
    document.getText = () => tree.source + ' ';
    await assert.rejects(editStatementFromGraph(document, tree, message, undefined, () => true));
    assert.equal(edits.length, 1);
});

test('unfinished annotation input does not crash the graph while typing', () => {
    for (const source of ['@', '@valid @', '@valid(1,', '@valid @(']) {
        const tree = { source, root: { kind: 'block', start: 0, end: source.length } };
        assert.doesNotThrow(() => annotationOwners(tree));
    }
});
