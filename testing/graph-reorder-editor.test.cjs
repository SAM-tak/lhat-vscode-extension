const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const entry = path.resolve(__dirname, '../src/graphReorderEditor.ts');
const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
    external: ['vscode'], write: false }).outputFiles[0].text;

function fixture(options = {}) {
    const source = 'one()\ntwo()\nthree()';
    const n = (kind, text, from = 0) => {
        const start = source.indexOf(text, from); assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1 };
    };
    const one = n('call-stmt', 'one()'), two = n('call-stmt', 'two()'), three = n('call-stmt', 'three()');
    const tree = { source, root: { ...n('block', source), fields: { items: [one, two, three] } } };
    const document = { uri: 'file:reorder', version: 7, getText: () => source,
        positionAt: offset => ({ line: 0, character: offset }) };
    const applied = [];
    const vscode = {
        l10n: { t: text => text },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { applied.push(edit); return options.apply !== false; } },
    };
    const mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(js, entry);
    const message = { type: 'reorder', id: '1', version: 7,
        sourceStart: one.start, sourceEnd: one.end,
        targetStart: three.start, targetEnd: three.end, before: false };
    return { source, one, two, three, document, applied, message,
        run: (patch = {}, active = () => options.active !== false) =>
            mod.exports.reorderFromGraph(document, tree, { ...message, ...patch }, active) };
}

test('one graph drop applies exactly one source replacement for its sibling list', async () => {
    const f = fixture();
    await f.run();
    assert.equal(f.applied.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.applied[0].changes[0])), {
        uri: 'file:reorder',
        range: { start: { line: 0, character: f.one.start }, end: { line: 0, character: f.three.end } },
        text: 'two()\nthree()\none()',
    });
});

test('stale, closed, invalid, and refused reorders never write source', async () => {
    for (const patch of [{ version: 6 }, { targetStart: 999, targetEnd: 1000 },
        { targetStart: 0, targetEnd: 5 }]) {
        const f = fixture(); await assert.rejects(f.run(patch)); assert.equal(f.applied.length, 0);
    }
    const closed = fixture({ active: false }); await assert.rejects(closed.run()); assert.equal(closed.applied.length, 0);
    const refused = fixture({ apply: false }); await assert.rejects(refused.run()); assert.equal(refused.applied.length, 1);
});
