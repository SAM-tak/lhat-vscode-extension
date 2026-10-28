const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const entry = path.resolve(__dirname, '../src/graphRename.ts');
const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;

function fixture(options = {}) {
    const source = options.source ?? 'let^route = 42\nroute';
    const document = { version: 1, uri: { toString: () => 'test:rename' }, getText: () => source,
        positionAt: offset => ({ line: 0, character: offset }), offsetAt: position => position.character };
    const other = { version: 1 };
    const calls = [], applied = [];
    const range = { start: document.positionAt(4), end: document.positionAt(9) };
    const edit = { size: 2, entries: () => [['test:rename', [{ newText: '経路' }]], ['test:other', [{ newText: '経路' }]]] };
    const vscode = { Range: class { constructor(start, end) { this.start = start; this.end = end; } },
        WorkspaceEdit: class { changes = []; replace(uri, range, newText) { this.changes.push({ uri, range, newText }); } },
        l10n: { t: text => text }, workspace: {
        textDocuments: [document, other], applyEdit: async value => { applied.push(value); return options.apply !== false; },
    }, commands: { executeCommand: async (command, ...args) => {
        calls.push([command, ...args]);
        await options.command?.(command, document, other);
        return command === 'vscode.prepareRename' ? (options.prepare === false ? undefined : { range })
            : options.edit === false ? undefined : edit;
    } } };
    const mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(js, entry);
    const message = { type: 'rename', id: '1', start: 4, end: 9, oldName: 'route', newName: '経路', version: 1 };
    return { document, other, calls, applied, edit, message,
        run: (patch = {}) => mod.exports.renameFromGraph(document, { ...message, ...patch }, () => options.active !== false, options.tree) };
}

test('one committed rename prepares the exact name and applies the entire provider workspace edit once', async () => {
    const f = fixture();
    await f.run();
    assert.deepEqual(f.calls.map(c => c[0]), ['vscode.prepareRename', 'vscode.executeDocumentRenameProvider']);
    assert.equal(f.calls[1][3], '経路');
    assert.deepEqual(f.applied, [f.edit], 'all references are kept, not only the declaration');
});

test('unchanged, empty, stale and mismatched spans never write source', async () => {
    const unchanged = fixture(); await unchanged.run({ newName: 'route' }); assert.equal(unchanged.calls.length, 0);
    for (const patch of [{ newName: '' }, { version: 0 }, { oldName: 'other' }, { start: -1 }]) {
        const f = fixture(); await assert.rejects(f.run(patch)); assert.equal(f.applied.length, 0);
    }
    const closed = fixture({ active: false }); await assert.rejects(closed.run()); assert.equal(closed.calls.length, 0);
});

test('edits during either provider await invalidate the rename, including reference documents', async () => {
    for (const stage of ['vscode.prepareRename', 'vscode.executeDocumentRenameProvider']) {
        const f = fixture({ command: (command, doc) => { if (command === stage) doc.version++; } });
        await assert.rejects(f.run(), /source changed/); assert.equal(f.applied.length, 0);
    }
    const f = fixture({ command: (command, doc, other) => { if (command.includes('executeDocument')) other.version++; } });
    await assert.rejects(f.run(), /source changed/); assert.equal(f.applied.length, 0);
});

test('provider refusal, missing edits, and failed apply propagate actionable errors', async () => {
    for (const options of [{ prepare: false }, { edit: false }, { apply: false }, { command: () => { throw Error('rename unavailable'); } }]) {
        const f = fixture(options); await assert.rejects(f.run());
        if (options.apply !== false) assert.equal(f.applied.length, 0);
    }
});

test('naming a discard edits only that fresh declaration, without renaming other discards', async () => {
    const source = 'let^ _^, _^ = nil^, nil^';
    const targets = [5, 9].map(start => ({ kind: 'hat-ident', start, end: start + 2 }));
    const tree = { source, root: { kind: 'define', start: 0, end: source.length, fields: { targets,
        values: [14, 20].map(start => ({ kind: 'hat-ident', start, end: start + 4 })) } } };
    const patch = { start: 9, end: 11, oldName: '_^', newName: '結果' };
    const f = fixture({ source, tree }); await f.run(patch);
    assert.equal(f.calls.length, 0); assert.equal(f.applied.length, 1);
    assert.deepEqual(f.applied[0].changes.map(change => [change.range.start.character, change.range.end.character, change.newText]), [[9, 11, '結果']]);
    for (const change of [{ version: 0 }, { newName: 'bad name' }, { newName: 'x = 1' }]) {
        const bad = fixture({ source, tree }); await assert.rejects(bad.run({ ...patch, ...change })); assert.equal(bad.applied.length, 0);
    }
});
