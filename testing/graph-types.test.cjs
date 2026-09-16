const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
function load(file, vscode) {
    const entry = path.resolve(__dirname, '../src', file);
    const mod = new Module(entry);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { typeSites, typeEdits } = load('graphTypes.ts');
const { toElk } = load('webview/map.ts');
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
function fixture(source) {
    const n = (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from); assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    return n;
}

test('qualified abstract types are captions, never initializer boxes, with both old and new servers', async () => {
    const source = 'self^{ abstract^gdobj : godot.Area2D, abstract^screenSize : godot.Vector2.Box^, speed = 400 }';
    const n = fixture(source);
    for (const metadata of [{}, { declared: true }]) {
        const root = n('self-table', source, { items: [
            n('table-entry', 'abstract^gdobj : godot.Area2D', { key: n('ident', 'gdobj'), value: n('member', 'godot.Area2D') }, 0, metadata),
            n('table-entry', 'abstract^screenSize : godot.Vector2.Box^', { key: n('ident', 'screenSize'), value: n('member', 'godot.Vector2.Box^') }, 0, metadata),
            n('table-entry', 'speed = 400', { key: n('ident', 'speed'), value: n('int', '400') }),
        ] });
        const reply = { source, root }, before = JSON.stringify(reply);
        const graph = await new ELK().layout(toElk(reply, { root, collapse: true }));
        const nodes = flatten(graph);
        assert.equal(nodes.filter(node => node.lhat?.definitionRole === 'row').length, 1);
        const parts = nodes.flatMap(node => node.lhat?.labelParts ?? []).filter(part => part.typeSite);
        assert.deepEqual(parts.map(part => [part.text, part.typeSite.typeText, part.typeSite.explicit]), [
            ['gdobj', 'godot.Area2D', true], ['screenSize', 'godot.Vector2.Box^', true], ['speed', 'number^', false],
        ]);
        assert(!nodes.some(node => node.lhat?.kind === 'member'));
        assert.equal(JSON.stringify(reply), before);
    }
});

test('multiple variables have distinct explicit/inferred type captions and reserve their widths', () => {
    const source = 'var^a:number^, 長い名前 = 1, factory()';
    const n = fixture(source);
    const root = n('define', source, { targets: [
        n('param', 'a:number^', { name: n('ident', 'a', undefined, 4), type: n('type-name', 'number^') }),
        n('ident', '長い名前', undefined, 0, { inferredType: 'godot.AnimatedSprite2D' }),
    ], values: [n('int', '1'), n('call', 'factory()')] });
    for (const scale of [1, 2]) {
        const node = flatten(toElk({ source, root }, { scale })).find(node => node.lhat?.definitionRole === 'declaration');
        const parts = node.lhat.labelParts.filter(part => part.typeSite);
        assert.deepEqual(parts.map(part => part.typeSite.explicit), [true, false]);
        assert.deepEqual(parts.map(part => part.typeLabel), ['Number', 'godot.AnimatedSprite2D']);
        assert.equal(node.height, Math.round(44 * scale));
        assert(node.width > 21 * 6 * scale, 'type names need room even when binding names are short');
    }
});

test('annotation insertion, replacement and removal preserve Unicode names, comments and computed key delimiters', () => {
    const source = 'let^日本語 #[ : ignored #[ nested ]# ]# : #[keep]# number^ = 42';
    const n = fixture(source);
    const reply = { source, root: n('define', source, {
        targets: [n('param', source.slice(4, source.indexOf(' =')), { name: n('ident', '日本語'), type: n('type-name', 'number^') })],
        values: [n('int', '42')],
    }) };
    const site = typeSites(reply)[0];
    const apply = edits => edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), source);
    assert.equal(apply(typeEdits(site, 'any^')), source.replace('number^', 'any^'));
    assert.equal(apply(typeEdits(site)), 'let^日本語 #[ : ignored #[ nested ]# ]#  #[keep]#  = 42');
    const computed = '{ [(key)] = 1 }', c = fixture(computed);
    const entry = c('table-entry', '[(key)] = 1', { key: c('ident', 'key'), value: c('int', '1') }, 0, { computed: true });
    assert.equal(typeSites({ source: computed, root: entry })[0].insert, computed.indexOf(']') + 1);
    assert.throws(() => typeEdits({ ...site, required: true }), /requires a type/);
    const grouped = 'let^x: #[keep]# ((number^)) = 1', g = fixture(grouped);
    const groupedSite = typeSites({ source: grouped, root: g('define', grouped, {
        targets: [g('param', 'x: #[keep]# ((number^))', { name: g('ident', 'x'), type: g('type-name', 'number^') })],
        values: [g('int', '1')],
    }) })[0];
    assert.equal(grouped.slice(groupedSite.annotation.start, groupedSite.annotation.end), '((number^))');
    assert.equal(typeEdits(groupedSite, 'any^')[0].text, 'any^');
});

function host(options = {}) {
    const source = 'let^値 = 42', n = fixture(source);
    const tree = { source, root: n('define', source, { targets: [n('ident', '値')], values: [n('int', '42')] }) };
    const document = { uri: 'file:types', version: 1, getText: () => source, positionAt: offset => ({ line: 0, character: offset }) };
    const edits = [], menus = [];
    const vscode = {
        l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { edits.push(edit); return true; } },
        window: { showQuickPick: async items => { menus.push(items); options.pick?.(document); return options.cancel ? undefined : items[0]; } },
    };
    const client = { sendRequest: async method => {
        assert.equal(method, 'lhat/typeOptions'); options.request?.(document);
        return { source: options.oldSource ? '' : source, candidates: ['number^', 'any^'] };
    } };
    const run = (patch = {}) => load('graphTypeEditor.ts', vscode).chooseTypeFromGraph(document, tree,
        { type: 'chooseType', id: '1', version: 1, start: 4, end: 5, ...patch }, client, () => true);
    return { run, edits, menus };
}
test('type picker presents only server candidates and applies a source WorkspaceEdit', async () => {
    const f = host(); await f.run();
    assert.deepEqual(f.menus[0].map(item => item.typeText), ['number^', 'any^']);
    assert.equal(f.edits.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.edits[0].changes[0])), { uri: 'file:types', range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, text: ': number^' });
});
test('cancelled menus and source changes during either await never apply stale annotations', async () => {
    const cancelled = host({ cancel: true }); await cancelled.run(); assert.equal(cancelled.edits.length, 0);
    for (const options of [{ request: doc => doc.version++ }, { pick: doc => doc.version++ }, { oldSource: true }]) {
        const f = host(options); await assert.rejects(f.run(), /source changed/); assert.equal(f.edits.length, 0);
    }
    const f = host(); await assert.rejects(f.run({ start: -1 })); assert.equal(f.edits.length, 0);
});
