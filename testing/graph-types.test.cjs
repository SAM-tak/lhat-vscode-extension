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
        const parts = flatten(node).flatMap(node => node.lhat?.labelParts ?? []).filter(part => part.typeSite);
        assert.deepEqual(parts.map(part => part.typeSite.explicit), [true, false]);
        assert.deepEqual(parts.map(part => part.typeLabel), ['Number', 'godot.AnimatedSprite2D']);
        assert(flatten(node).some(child => child.lhat?.appendInsertion), 'the target list ends in an add control');
        assert(node.width > 21 * 6 * scale, 'type names and their insertion gaps need room even when names are short');
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

test('function arguments and results use the same type sites and edit syntax', () => {
    const source = 'f^value:string^ -> number^ { return^ value.len }';
    const n = fixture(source);
    const body = n('block', '{ return^ value.len }');
    const root = n('func', source, {
        params: [n('param', 'value:string^', { name: n('ident', 'value'), type: n('type-name', 'string^') })],
        return_type: n('type-name', 'number^'), body,
    });
    const sites = typeSites({ source, root });
    assert.deepEqual(sites.map(site => [site.name, site.typeText, site.explicit]), [
        ['return value', 'number^', true], ['value', 'string^', true],
    ]);
    const result = sites[0];
    assert.deepEqual(result.anchor, { start: source.indexOf('->'), end: source.indexOf('->') + 2 });
    const apply = edits => edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), source);
    assert.equal(apply(typeEdits(result, 'string^')), source.replace('number^', 'string^'));
    assert.equal(apply(typeEdits(result)), 'f^value:string^  { return^ value.len }');

    const inferred = 'f^value { return^ value }', i = fixture(inferred);
    const inferredRoot = i('func', inferred, {
        params: [i('param', 'value', { name: i('ident', 'value') }, 2)],
        body: i('block', '{ return^ value }'),
    }, 0, { inferredReturnType: 'string^' });
    const inferredResult = typeSites({ source: inferred, root: inferredRoot }).find(site => site.name === 'return value');
    assert.equal(inferredResult.typeText, 'string^');
    const resultEdits = typeEdits(inferredResult, 'string^');
    assert.equal(resultEdits[0].text, ' -> string^');
    assert.equal(resultEdits[0].start, inferred.indexOf('{'));
});

function host(options = {}) {
    const source = options.annotated ? 'let^値: number^ = 42' : 'let^値 = 42', n = fixture(source);
    const target = options.annotated
        ? n('param', '値: number^', { name: n('ident', '値'), type: n('type-name', 'number^') }) : n('ident', '値');
    const tree = { source, root: n('define', source, { targets: [target], values: [n('int', '42')] }) };
    const document = { uri: 'file:types', version: 1, getText: () => source, positionAt: offset => ({ line: 0, character: offset }) };
    const edits = [], requests = [];
    const token = { isCancellationRequested: false };
    const vscode = {
        l10n: { t: text => text }, Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { edits.push(edit); return !options.refuse; } },
    };
    const client = { sendRequest: async (method, params, cancellation) => {
        assert.equal(method, 'lhat/typeOptions'); assert.equal(cancellation, token);
        requests.push(params); options.request?.(document, token);
        if (options.nulls && requests.length <= options.nulls) return null;
        return { source: options.oldSource ? '' : source, candidates: ['number^', 'any^', 'number^', ''] };
    } };
    const api = load('graphTypeEditor.ts', vscode);
    const run = (patch = {}) => api.typeOptionsFromGraph(document, tree,
        { type: 'chooseType', id: '1', version: 1, start: 4, end: 5, ...patch }, client, () => true, token);
    const apply = (selection, typeText) => api.applyTypeFromGraph(document, selection, typeText, () => true);
    const remove = (patch = {}) => api.removeTypeFromGraph(document, tree,
        { type: 'removeType', id: '1', version: 1, start: 4, end: 5, ...patch }, () => true);
    return { run, apply, remove, edits, requests, document, token };
}
test('type choices are returned without workbench UI, and selection applies a WorkspaceEdit', async () => {
    const f = host(), selection = await f.run();
    assert.deepEqual(selection.candidates, ['number^', 'any^']);
    assert.equal(f.edits.length, 0);
    await f.apply(selection, 'number^');
    assert.equal(f.edits.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.edits[0].changes[0])), { uri: 'file:types', range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, text: ': number^' });
});
test('cancelled requests and source changes never apply stale annotations', async () => {
    for (const options of [{ request: doc => doc.version++ }, { request: (_, token) => { token.isCancellationRequested = true; } }, { oldSource: true }]) {
        const f = host(options); await assert.rejects(f.run(), /source changed/); assert.equal(f.edits.length, 0);
    }
    const f = host(); await assert.rejects(f.run({ start: -1 })); assert.equal(f.edits.length, 0);
    const selection = await f.run(); f.document.version++;
    await assert.rejects(f.apply(selection, 'number^'), /source changed/);
    assert.equal(f.edits.length, 0);
});

test('transient null replies are retried, permanent failures are bounded, and cancellation stops retrying', async () => {
    const transient = host({ nulls: 1 });
    assert.deepEqual((await transient.run()).candidates, ['number^', 'any^']);
    assert.equal(transient.requests.length, 2);
    const unavailable = host({ nulls: 9 });
    await assert.rejects(unavailable.run(), /unavailable at this location/);
    assert.equal(unavailable.requests.length, 3);
    const cancelled = host({ nulls: 9, request: (_, token) => { token.isCancellationRequested = true; } });
    await assert.rejects(cancelled.run(), /source changed/);
    assert.equal(cancelled.requests.length, 1);
});

test('only offered types or a removable explicit annotation can be applied', async () => {
    const f = host(), selection = await f.run();
    await assert.rejects(f.apply(selection, 'string^'), /available types/);
    await assert.rejects(f.apply(selection, undefined), /available types/);
    await assert.rejects(f.apply({ ...selection, site: { ...selection.site, explicit: true, required: true } }, undefined), /available types/);
    assert.equal(f.edits.length, 0);
});

test('inference removes an optional annotation and failed workspace edits are reported', async () => {
    const f = host({ annotated: true }), selection = await f.run();
    await f.apply(selection, undefined);
    const source = f.edits[0].changes.sort((a, b) => b.range.start.character - a.range.start.character)
        .reduce((text, edit) => text.slice(0, edit.range.start.character) + edit.text + text.slice(edit.range.end.character), f.document.getText());
    assert.equal(source, 'let^値  = 42');
    const refused = host({ refuse: true });
    await assert.rejects(refused.apply(await refused.run(), 'number^'), /Could not apply/);
});

test('annotation removal needs no type lookup but still checks the document and type site', async () => {
    const f = host({ annotated: true });
    await f.remove();
    assert.equal(f.requests.length, 0);
    assert.equal(f.edits.length, 1);
    const stale = host({ annotated: true }); stale.document.version++;
    await assert.rejects(stale.remove(), /source changed/);
    assert.equal(stale.edits.length, 0);
    const inferred = host();
    await assert.rejects(inferred.remove(), /available types/);
    assert.equal(inferred.edits.length, 0);
});

test('abstract member declarations retain their required type while let/var definitions can use inference', () => {
    const declaredSource = 'abstract^value:number^', declared = fixture(declaredSource);
    const declaration = typeSites({ source: declaredSource, root: declared('table-entry', declaredSource, {
        key: declared('ident', 'value'), value: declared('type-name', 'number^'),
    }, 0, { declared: true }) })[0];
    assert.equal(declaration.required, true);
    assert.throws(() => typeEdits(declaration, undefined), /requires a type/);
    for (const keyword of ['let', 'var']) {
            const source = `${keyword}^value:number^ = 42`, n = fixture(source);
            const fields = { targets: [n('param', 'value:number^', { name: n('ident', 'value'), type: n('type-name', 'number^') })],
                values: [n('int', '42')] };
            const site = typeSites({ source, root: n('define', source, fields) })[0];
            assert.equal(site.required, false);
            assert(typeEdits(site, undefined).length > 0);
    }
});

async function editorHost(options = {}) {
    let source = options.source ?? 'let^value = 42', checked, receive, changed, closed;
    const messages = [], requests = [];
    const tree = () => {
        const n = fixture(source), annotation = /:\s*([^=]+?)\s*=/.exec(source)?.[1];
        const target = annotation ? n('param', `value: ${annotation}`, { name: n('ident', 'value'),
            type: n('type-name', annotation, undefined, source.indexOf(':')) }) : n('ident', 'value');
        return { source, root: n('define', source, { targets: [target], values: [n('int', '42')] }) };
    };
    checked = tree();
    const uri = { toString: () => 'file:graph-types' };
    const document = { uri, version: 1, getText: () => source, positionAt: character => ({ line: 0, character }) };
    const mock = {
        env: { language: 'en' }, l10n: { t: text => text },
        Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ range, text }); } },
        workspace: {
            getConfiguration: () => ({ get: () => 'en' }),
            onDidChangeTextDocument: callback => { changed = callback; return { dispose() {} }; },
            onDidChangeConfiguration: () => ({ dispose() {} }),
            applyEdit: async edit => {
                for (const e of edit.changes.sort((a, b) => b.range.start.character - a.range.start.character)) {
                    source = source.slice(0, e.range.start.character) + e.text + source.slice(e.range.end.character);
                }
                document.version++; changed({ document }); return true;
            },
        },
    };
    const panel = { onDidDispose: callback => { closed = callback; }, webview: {
        asWebviewUri: value => value, cspSource: 'test:',
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: callback => { receive = callback; },
    } };
    const client = { sendRequest: async (method, params, token) => {
        requests.push(method);
        if (method === 'lhat/typeOptions' && options.lookup) return options.lookup(token);
        return method === 'lhat/ast' ? checked : { source: checked.source, candidates: ['number^', 'any^'] };
    } };
    const Provider = load('graphEditor.ts', mock).LhatGraphEditorProvider;
    await new Provider({ extensionUri: 'test:extension' }, () => client).resolveCustomTextEditor(document, panel, {});
    receive({ type: 'ready' }); await new Promise(setImmediate);
    return { document, messages, requests, receive, close: () => closed(),
        completeCheck: () => { checked = tree(); },
        setUnavailable: () => { checked = null; },
    };
}
const waitFor = async condition => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 15));
    assert(condition(), 'the graph did not catch up after checking finished');
};

test('type edits catch up with the checked source and re-enable further selections without another edit', async () => {
    const h = await editorHost();
    try {
        for (const [id, typeText] of [['first', 'number^'], ['second', 'any^']]) {
            h.receive({ type: 'chooseType', id, version: h.document.version, start: 4, end: 9 });
            await waitFor(() => h.messages.some(m => m.type === 'typeOptions' && m.id === id && m.candidates));
            h.receive({ type: 'applyType', id, typeText }); await new Promise(setImmediate);
            assert.equal(h.messages.filter(m => m.type === 'tree').at(-1).version, undefined,
                'the first post-edit reply is deliberately from the previous checker snapshot');
            h.completeCheck();
            await waitFor(() => h.messages.some(m => m.type === 'tree' && m.version === h.document.version));
            assert.equal(h.messages.filter(m => m.type === 'tree').at(-1).reply.source, h.document.getText());
        }
    } finally { h.close(); }
});

test('pending AST refreshes stop when the graph closes', async () => {
    const h = await editorHost();
    h.setUnavailable(); h.receive({ type: 'refresh' }); await new Promise(setImmediate);
    assert(h.messages.some(m => m.type === 'pending'));
    h.close(); const count = h.requests.length;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(h.requests.length, count);
});

test('removal recovers after a failed or still pending candidate lookup', async () => {
    for (const pending of [false, true]) {
        let lookupToken;
        const h = await editorHost({ source: 'let^value: value = 42', lookup: token => {
            lookupToken = token;
            return pending ? new Promise(() => {}) : Promise.reject(new Error('lookup failed'));
        } });
        try {
            h.receive({ type: 'chooseType', id: 'recover', version: 1, start: 4, end: 9 });
            await new Promise(setImmediate);
            if (!pending) assert(h.messages.some(m => m.type === 'typeOptions' && m.error === 'lookup failed'));
            h.receive({ type: 'removeType', id: 'recover', version: 1, start: 4, end: 9 });
            await waitFor(() => h.messages.some(m => m.type === 'typeResult' && m.id === 'recover'));
            assert.equal(h.messages.find(m => m.type === 'typeResult').error, undefined);
            assert.equal(h.document.getText(), 'let^value  = 42');
            if (pending) assert(lookupToken.isCancellationRequested);
            h.completeCheck();
            await waitFor(() => h.messages.some(m => m.type === 'tree' && m.version === 2));
        } finally { h.close(); }
    }
});
