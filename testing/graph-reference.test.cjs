const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function bundle(file) {
    return buildSync({ entryPoints: [path.resolve(__dirname, '../src', file)], bundle: true,
        platform: 'node', format: 'cjs', external: ['vscode'], write: false }).outputFiles[0].text;
}
const host = bundle('graphReference.ts');
function load(js, vscode) {
    const mod = new Module(__filename);
    mod.require = name => name === 'vscode' ? vscode : require(name);
    mod._compile(js, __filename);
    return mod.exports;
}
const { createLabeler, labelText } = load(bundle('webview/labels.ts'));
const { referencePath } = load(bundle('webview/reference.ts'));

function fixture(source) {
    const n = (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
    const ident = (text, from = 0) => n('ident', text, undefined, from);
    const member = (text, from = 0) => {
        const parts = text.split('.');
        if (parts.length === 1) return ident(text, from);
        const prefix = parts.slice(0, -1).join('.');
        return n('member', text, { target: member(prefix, from), argument: ident(parts.at(-1), source.indexOf(text, from) + prefix.length + 1) }, from);
    };
    const uri = { toString: () => 'file:///example.lh' };
    const document = { uri, version: 1, getText: () => source,
        positionAt: character => ({ line: 0, character }), offsetAt: position => position.character };
    const location = (offset, targetUri = uri) => ({ uri: targetUri, range: {
        start: document.positionAt(offset), end: document.positionAt(offset + 1),
    } });
    const definitions = new Map(), calls = [];
    const options = { active: true, beforeReply: undefined };
    const { referenceFromGraph } = load(host, { commands: { executeCommand: async (command, targetUri, position) => {
        assert.equal(command, 'vscode.executeDefinitionProvider', 'lookup is read-only');
        assert.equal(targetUri, uri);
        calls.push(position.character);
        await options.beforeReply?.();
        return definitions.get(position.character);
    } } });
    let root;
    return { n, ident, member, document, definitions, calls, location, options,
        root: items => root = n('block', source, { items }),
        run: (node, patch = {}) => referenceFromGraph(document, { source, root }, { type: 'reference', id: '1',
            start: node.start, end: node.end, text: source.slice(node.start, node.end), version: 1, ...patch }, () => options.active),
    };
}
const span = node => ({ start: node.start, end: node.end });
const box = node => ({ ...span(node), box: true });

test('parameter references use language-server binding, including shadowed and Unicode names', async () => {
    const source = 'let^outer = p^商品 { let^inner = f^商品:商品; 商品 }';
    const f = fixture(source), outer = f.ident('商品'), inner = f.ident('商品', outer.end);
    const innerUse = f.ident('商品', inner.end), outerUse = f.ident('商品', innerUse.end);
    const innerFunc = f.n('func', 'f^商品:商品;', { params: [f.n('param', '商品', { name: inner }, inner.start)], body: innerUse });
    f.root([f.n('func', source, { params: [f.n('param', '商品', { name: outer })], body: [innerFunc, outerUse] })]);
    f.definitions.set(innerUse.start, [f.location(inner.start)]);
    f.definitions.set(outerUse.start, [f.location(outer.start)]);
    assert.deepEqual(await f.run(innerUse), span(inner));
    assert.deepEqual(await f.run(outerUse), span(outer));
    f.definitions.set(outerUse.start, [f.location(inner.start), f.location(outer.start)]);
    assert.equal(await f.run(outerUse), undefined, 'ambiguous provider answers are not guessed');
});

test('explicit import and require aliases point at the loading expression, not the alias or external file', async () => {
    for (const [kind, valueText] of [['import', 'pkg.util'], ['require', '"util.lh"']]) {
        const source = `let^util = ${kind}^${valueText}\nutil.work`;
        const f = fixture(source), name = f.ident('util');
        const value = f.n(kind, `${kind}^${valueText}`, { value: kind === 'import' ? f.member(valueText) : f.n('string', valueText) });
        const use = f.member('util.work');
        f.root([f.n('define', source.split('\n')[0], { targets: [name], values: [value] }), use]);
        f.definitions.set(use.fields.target.start, [f.location(name.start)]);
        f.definitions.set(use.fields.argument.start, [f.location(10, { toString: () => 'file:///util.lh' })]);
        assert.deepEqual(await f.run(use.fields.target), box(value));
        assert.deepEqual(await f.run(use.fields.argument), box(value));
    }
});

test('shared namespace imports choose the matching import, not the first root declaration', async () => {
    const source = 'import^pkg.io\nimport^pkg.net\npkg.net.open';
    const f = fixture(source), io = f.n('import-stmt', 'import^pkg.io', { value: f.member('pkg.io') });
    const net = f.n('import-stmt', 'import^pkg.net', { value: f.member('pkg.net') });
    const use = f.member('pkg.net.open');
    f.root([io, net, use]);
    f.definitions.set(use.fields.target.fields.target.start, [f.location(io.start)]);
    assert.deepEqual(await f.run(use.fields.argument), box(net), 'hosted exports may have no external source location');
    // An unrelated local binding must win over an import with the same spelling.
    f.definitions.set(use.fields.argument.start, [f.location(net.fields.value.fields.argument.start)]);
    // This offset is inside the import, so it is still the import endpoint.
    assert.deepEqual(await f.run(use.fields.argument), box(net));
});

test('multiple requires use resolved unit URIs, including LocationLink results', async () => {
    const source = 'require^"a.lh"\nrequire^"b.lh"\npkg.b.work';
    const f = fixture(source);
    const a = f.n('require-stmt', 'require^"a.lh"', { value: f.n('string', '"a.lh"') });
    const b = f.n('require-stmt', 'require^"b.lh"', { value: f.n('string', '"b.lh"') });
    const use = f.member('pkg.b.work');
    const uriA = { toString: () => 'file:///lib/a.lh' }, uriB = { toString: () => 'file:///lib/b.lh' };
    f.root([a, b, use]);
    f.definitions.set(use.fields.target.fields.target.start, [f.location(a.start)]);
    f.definitions.set(a.fields.value.start, [f.location(0, uriA)]);
    f.definitions.set(b.fields.value.start, [f.location(0, uriB)]);
    const range = f.location(10).range;
    f.definitions.set(use.fields.argument.start, [{ targetUri: uriB, targetRange: range, targetSelectionRange: range }]);
    assert.deepEqual(await f.run(use.fields.argument), box(b));
    f.definitions.set(use.fields.argument.start, undefined);
    assert.equal(await f.run(use.fields.argument), undefined, 'unresolved shared namespaces do not select an arbitrary require');
});

test('a shadowing local declaration prevents import provenance inference', async () => {
    const source = 'import^pkg.io\nlet^pkg = {}\npkg.io';
    const f = fixture(source), imported = f.n('import-stmt', 'import^pkg.io', { value: f.member('pkg.io') });
    const name = f.ident('pkg', imported.end), use = f.member('pkg.io', source.lastIndexOf('pkg'));
    f.root([imported, f.n('define', 'let^pkg = {}', { targets: [name], values: [f.n('table', '{}')] }), use]);
    f.definitions.set(use.fields.target.start, [f.location(name.start)]);
    assert.deepEqual(await f.run(use.fields.target), span(name));
    assert.equal(await f.run(use.fields.argument), undefined);
});

test('stale, invalid, disabled and unresolved references never produce a target', async () => {
    const source = 'let^x = 1\nx';
    const f = fixture(source), name = f.ident('x'), use = f.ident('x', name.end);
    f.root([f.n('define', 'let^x = 1', { targets: [name], values: [f.n('int', '1')] }), use]);
    f.definitions.set(use.start, [f.location(name.start)]);
    for (const patch of [{ version: 0 }, { start: -1 }, { start: 0.5 }, { text: 'wrong' }, { end: 1e9 }]) {
        assert.equal(await f.run(use, patch), undefined);
    }
    assert.equal(f.calls.length, 0);
    f.options.beforeReply = () => f.document.version++;
    assert.equal(await f.run(use), undefined);
    f.document.version = 1; f.options.beforeReply = () => { f.options.active = false; };
    assert.equal(await f.run(use), undefined);
    f.options.active = true; f.options.beforeReply = undefined;
    f.root([f.n('disabled', source, { statement: use })]);
    const before = f.calls.length;
    assert.equal(await f.run(use), undefined);
    assert.equal(f.calls.length, before);
});

test('label anchors preserve exact UTF-16 names without making literal/comment text into references', () => {
    const source = 'let^work = p^商品:string^ { # 商品\nreturn^商品 + "商品" }';
    const f = fixture(source), declaration = f.ident('work'), name = f.ident('商品');
    const use = f.ident('商品', source.indexOf('return^'));
    const body = f.n('block', '{ # 商品\nreturn^商品 + "商品" }', { items: [use, f.n('string', '"商品"')] });
    const func = f.n('func', 'p^商品:string^ { # 商品\nreturn^商品 + "商品" }', {
        params: [f.n('param', '商品:string^', { name, type: f.n('type-name', 'string^') })], body,
    });
    const root = f.root([f.n('define', source, { targets: [declaration], values: [func] })]);
    const label = createLabeler(source, root);
    const header = label(func, [body]);
    assert.deepEqual(header.parts.filter(p => p.symbol).map(p => p.symbol), [span(name)]);
    assert.equal(labelText(header), 'Procedure 商品:Text …');
    assert.deepEqual(label(body, [], 200).parts.filter(p => p.symbol).map(p => p.symbol), [span(use)]);
    assert.deepEqual(label(use, []).parts[0].symbol, span(use));
    assert.deepEqual(label(root.fields.items[0], [func]).parts.find(p => p.name).symbol, span(declaration));
});

test('reference curves end at box edges, smoothly, in all directions without graph layout', () => {
    const a = { left: 100, top: 100, right: 160, bottom: 130 };
    const above = { left: 20, top: 10, right: 80, bottom: 40 };
    const right = { left: 220, top: 100, right: 280, bottom: 130 };
    assert.equal(referencePath(a, above), 'M 130 100 C 130 70, 50 70, 50 40');
    assert.equal(referencePath(above, a), 'M 50 40 C 50 70, 130 70, 130 100');
    assert.equal(referencePath(a, right), 'M 160 115 C 190 115, 190 115, 220 115');
    assert.equal(referencePath(right, a), 'M 220 115 C 190 115, 190 115, 160 115');
});
