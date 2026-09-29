const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
const { interpolation, nestedInterpolation } = require('./interpolation-fixture.cjs');
function load(file, vscode) {
    const name = path.resolve(__dirname, '../src', file), mod = new Module(name);
    if (vscode) mod.require = id => id === 'vscode' ? vscode : require(id);
    mod._compile(buildSync({ entryPoints: [name], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] }).outputFiles[0].text, name);
    return mod.exports;
}
const api = load('graphInterpolation.ts'), { toElk } = load('webview/map.ts');
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);

test('nested operand wires originate on visible output rows, including inside interpolation', () => {
    const reply = nestedInterpolation();
    for (const root of [reply.root, reply.root.fields.items[0].fields.value]) {
        const nodes = flatten(toElk({ ...reply, root }));
        const links = nodes.flatMap(n => n.lhat?.operandLinks ?? []);
        assert.equal(links.length, root.kind === 'interp' ? 4 : 1);
        for (const link of links) {
            const source = nodes.find(n => n.id === link.source);
            assert(!source.lhat.layoutOnly, 'definition lines originate on a visible value');
            assert.equal(typeof source.lhat.operandOutputY, 'number', 'edge source owns its output handle');
            assert(nodes.find(n => n.id === link.target).lhat.operandInput);
        }
    }
});

test('interpolation fragments, types, formats and expressions form an ordered editable graph', async () => {
    const reply = interpolation();
    const graph = await new ELK().layout(toElk(reply));
    const format = flatten(graph).find(n => n.lhat?.kind === 'interp');
    assert.equal(format.labels[0].text, 'Format');
    const row = flatten(format).find(n => n.lhat?.operatorExpression && n.lhat.kind === 'interp');
    assert(row, 'interpolation uses the common expression row');
    assert.deepEqual(row.children.map(n => n.lhat.kind), ['interp-text', 'operand-slot', 'interp-text', 'ident', 'interpolation-add']);
    assert.equal(flatten(format).filter(n => n.lhat?.interpolationFormat).length, 2);
    assert.equal(flatten(format).filter(n => n.lhat?.kind === 'operand-slot').length, 1);
    assert(flatten(format).some(n => n.lhat?.operatorExpression), 'compound expression keeps its graph');
    const inline = row.children[3];
    assert.equal(inline.lhat.kind, 'ident');
    assert.equal(inline.lhat.interpolation, undefined);
    assert(inline.lhat.labelParts.some(part => part.text === 'v2'));
    for (let i = 1; i < row.children.length; i++) assert(row.children[i].x > row.children[i - 1].x);
    assert(row.children.slice(0, 4).every(cell => cell.height === row.children[0].height));
    assert.equal(row.children[0].lhat.literal.kind, 'string');
    assert.equal(flatten(format).flatMap(n => n.lhat?.operandLinks ?? []).length, 1);
});

test('a simple interpolation reference uses the ordinary inline typed value without a hole or definition wire', () => {
    const source = '$"fixed time loop {ii}"';
    const value = { kind: 'ident', start: 19, end: 21, line: 1, column: 20, inferredType: 'number^' };
    const root = { kind: 'interp', start: 0, end: source.length, line: 1, column: 1,
        fields: { items: [{ kind: 'interp-hole', start: 18, end: 22, line: 1, column: 19, fields: { value } }] } };
    const nodes = flatten(toElk({ source, root }));
    const inline = nodes.find(n => n.lhat?.kind === 'ident');
    const ordinary = flatten(toElk({ source, root: value })).find(n => n.lhat?.kind === 'ident');
    assert.deepEqual(inline.lhat.labelParts, ordinary.lhat.labelParts);
    assert.equal(nodes.filter(n => n.lhat?.operandInput).length, 0);
    assert.equal(nodes.flatMap(n => n.lhat?.operandLinks ?? []).length, 0);
});

test('text edits escape braces, quotes, backslashes and controls without changing holes', () => {
    const reply = interpolation(), field = api.interpolationFields(reply.root, reply.source)[0];
    const value = '日本語 {x} "quoted" \\ line\n\0\x01';
    const edit = api.editInterpolation(reply, field.site, value);
    assert.equal(api.interpolationText(edit.text), value);
    assert(apply(reply.source, edit).endsWith('{v1 + 2}text2{v2}"'));
    assert.equal(api.interpolationText('a{{b}}c}'), 'a{b}c}');
    assert.equal(api.interpolationText('\\xff'), undefined, 'binary bytes cannot be edited as Unicode text');
});

test('format insertion, replacement/removal and appending use only parser-owned locations', () => {
    const reply = interpolation(), fields = api.interpolationFields(reply.root, reply.source);
    const format = fields.find(f => f.site.field === 'format');
    assert.equal(apply(reply.source, api.editInterpolation(reply, format.site, '%04d')), '$"text1{v1 + 2:%04d}text2{v2}"');
    assert.equal(api.editInterpolation(reply, format.site, '}oops'), undefined);
    const expression = fields.find(f => f.site.field === 'expression');
    assert.equal(apply(reply.source, api.editInterpolation(reply, expression.site, '(v1 * 3)')), '$"text1{(v1 * 3)}text2{v2}"');
    assert.equal(api.editInterpolation(reply, expression.site, '  '), undefined);
    assert.equal(api.editInterpolation(reply, { ...expression.site, part: { start: 0, end: 5 } }, 'wrong'), undefined);
    const append = fields.at(-1).site;
    assert.equal(apply(reply.source, api.editInterpolation(reply, append, 'expression')), '$"text1{v1 + 2}text2{v2}{nil^}"');
    assert.equal(apply(reply.source, api.editInterpolation(reply, append, 'text')), '$"text1{v1 + 2}text2{v2}text"');
    const source = '$"{v:%04d}"';
    const root = { kind: 'interp', start: 0, end: source.length, fields: { items: [{ kind: 'interp-hole', start: 2, end: 10,
        fields: { value: { kind: 'ident', start: 3, end: 4 }, format: { kind: 'interp-text', start: 4, end: 9 } } }] } };
    const site = api.interpolationFields(root, source).find(f => f.site.field === 'format').site;
    assert.equal(apply(source, api.editInterpolation({ source, root }, site, '')), '$"{v}"');
    assert.equal(apply(source, api.editInterpolation({ source, root }, site, '%.2f')), '$"{v:%.2f}"');
    assert.equal(api.editInterpolation({ source: reply.source, root: { kind: 'disabled', fields: { items: [reply.root] } } }, append, 'text'), undefined);
});

test('interpolation source edits use one workspace edit and reject stale snapshots', async () => {
    const tree = interpolation(), edits = [];
    const vscode = { l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { replace(uri, range, text) { this.change = { uri, range, text }; } },
        workspace: { applyEdit: async edit => { edits.push(edit); return true; } } };
    const { editStatementFromGraph } = load('graphStatementEditor.ts', vscode);
    const document = { uri: 'file:interpolation', version: 1, getText: () => tree.source, positionAt: character => ({ line: 0, character }) };
    const site = api.interpolationFields(tree.root, tree.source)[0].site;
    const message = { type: 'editInterpolation', id: 'test', version: 1, site, value: 'edited' };
    await editStatementFromGraph(document, tree, message, undefined, () => true);
    assert.equal(edits.length, 1); assert.equal(edits[0].change.text, 'edited');
    document.version++;
    await assert.rejects(editStatementFromGraph(document, tree, message, undefined, () => true), /source changed/);
    assert.equal(edits.length, 1);
});
