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
const api = load('graphStatements.ts');
const { toElk } = load('webview/map.ts');
const flat = node => [node, ...(node.children ?? []).flatMap(flat)];
const node = (kind, start, end, fields) => ({ kind, start, end, fields, line: 1, column: start + 1 });
const simple = source => ({ source, root: node('block', 0, source.length, { items: [] }) });
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);

test('appending to a handled block stays in the main body before its catch clauses', () => {
    const tree = require('./catch-fixture.cjs').catchFlow();
    const block = tree.root.fields.items[0];
    const site = api.statementInsertions(tree).find(site => site.start === block.start && site.end === block.end && site.before === undefined);
    const edit = api.insertStatementEdit(tree, site, 'let');
    assert.equal(edit.start, tree.source.indexOf('catch^'));
    assert(apply(tree.source, edit).includes('work()\nlet^ value = 0\ncatch^IOError.Eof:'));
});

test('every template and the native statement menu have Japanese labels', () => {
    const ja = require('../l10n/bundle.l10n.ja.json'), en = require('../l10n/bundle.l10n.json');
    for (const label of Object.values(api.STATEMENT_TEMPLATE_LABELS)) {
        assert.equal(en[label], label);
        assert(ja[label] && ja[label] !== label, label);
    }
    const pkg = require('../package.json');
    const command = pkg.contributes.menus['webview/context'].find(m => m.command === 'lhat.graph.toggleStatement');
    assert(command.when.includes('lhatStatement'));
    assert.equal(require('../package.nls.ja.json')['graph.toggleStatement'], '文の有効・無効を切り替え');
    assert(pkg.contributes.menus['webview/context'].find(m => m.command === 'lhat.graph.toggleFold').when.includes('lhatFoldable'));
    assert.equal(require('../package.nls.json')['graph.toggleFold'], 'Toggle Fold/Unfold');
    assert.equal(require('../package.nls.ja.json')['graph.toggleFold'], '折りたたみ・展開を切り替え');
});

test('empty files and callable bodies have a real append action below their start', () => {
    for (const tree of [simple(''), simple('# comment\n')]) {
        const graph = toElk(tree), [start, add] = graph.children;
        assert.equal(start.lhat.synthetic, 'start');
        assert.equal(add.lhat.synthetic, 'add');
        assert.deepEqual(add.lhat.insertion, api.statementInsertions(tree)[0]);
        assert(graph.edges.some(edge => edge.drawn && edge.sources[0] === start.id && edge.targets[0] === add.id));
        assert.equal(apply(tree.source, api.insertStatementEdit(tree, add.lhat.insertion, 'let')), tree.source + 'let^ value = 0\n');
    }
});

test('insertion targets are exact statement-list gaps, with no insertion before module or inside disabled code', () => {
    const source = 'module^ sample\n#[~ old() ]#\nlet^ value = 1\n';
    const module = node('module', 0, 14), disabled = node('disabled', 15, 27, { items: [node('call-stmt', 19, 24)] });
    const define = node('define', 28, 42, { targets: [node('ident', 33, 38)], values: [node('int', 41, 42)] });
    const tree = { source, root: node('block', 0, source.length, { items: [module, disabled, define] }) };
    const sites = api.statementInsertions(tree);
    assert.deepEqual(sites.map(s => s.before), [15, 28, undefined]);
    assert.equal(api.statementSites(tree).length, 3);
    assert(!api.insertStatementEdit(tree, { ...sites[0], before: 19 }, 'let'));
    assert(!api.insertStatementEdit(tree, sites[0], 'arbitrary text'));
    assert(api.statementTemplates(tree, sites[0]).find(t => t.id === 'let').text.includes('value2'));
});

test('statement templates respect loop and callable boundaries', () => {
    const source = 'repeat^ 1 { let^ p = p^{} }';
    const procBody = node('block', 22, 24), proc = node('func', 20, 24, { body: procBody });
    const loopBody = node('block', 10, 26, { items: [node('define', 12, 24, { values: [proc] })] });
    const tree = { source, root: node('block', 0, source.length, { items: [node('repeat', 0, source.length, { body: loopBody })] }) };
    const choices = start => api.statementTemplates(tree, api.statementInsertions(tree).find(s => s.start === start && s.before === undefined));
    assert(!choices(0).some(t => t.id === 'break'));
    assert(choices(10).some(t => t.id === 'break'));
    assert(!choices(22).some(t => t.id === 'break'));
    assert.equal(choices(22).find(t => t.id === 'return').text, 'return^');
});

test('insertions preserve comments, Unicode, CRLF and surrounding indentation', () => {
    const source = 'let^ f = p^{\r\n    # keep\r\n    work()\r\n}\r\n';
    const at = source.indexOf('work()'), body = node('block', source.indexOf('{'), source.indexOf('}') + 1, {
        items: [node('call-stmt', at, at + 6)],
    });
    const tree = { source, root: node('block', 0, source.length, { items: [node('define', 0, body.end, { values: [node('func', source.indexOf('p^'), body.end, { body })] })] }) };
    const site = api.statementInsertions(tree).find(s => s.start === body.start && s.before === at);
    const edited = apply(source, api.insertStatementEdit(tree, site, 'if'));
    assert.equal(edited, source.replace('    work()', '    if^ true^ {\r\n    }\r\n    work()'));
    const append = api.statementInsertions(tree).find(s => s.start === body.start && s.before === undefined);
    assert.equal(apply(source, api.insertStatementEdit(tree, append, 'let')), source.replace('\r\n}\r\n', '\r\n    let^ value = 0\r\n}\r\n'));
});

test('disabled groups show only their contents and preserve a context target for re-enabling the whole group', () => {
    const source = '#[~ old()\nnext() ]#';
    const disabled = node('disabled', 0, source.length, { items: [node('call-stmt', 4, 9), node('call-stmt', 10, 16)] });
    const tree = { source, root: node('block', 0, source.length, { items: [disabled] }) };
    const graph = toElk(tree), wrapper = flat(graph).find(n => n.lhat?.kind === 'disabled');
    assert(wrapper.lhat.layoutOnly);
    assert.equal(wrapper.labels[0].text, '');
    assert(wrapper.children.every(n => n.lhat.disabled && n.lhat.statement.start === 0 && n.lhat.statement.end === source.length));
    assert(!flat(wrapper).some(n => n.labels?.some(l => l.text.includes('#[~') || l.text.includes(']#'))));
});

test('appending to an inline Unicode-named procedure stays inside its body', () => {
    const source = 'let^ 日本語 = p^{}', start = source.indexOf('{');
    const body = node('block', start, source.length);
    const tree = { source, root: node('block', 0, source.length, { items: [node('define', 0, source.length, {
        values: [node('func', source.indexOf('p^'), source.length, { body })],
    })] }) };
    const site = api.statementInsertions(tree).find(s => s.start === start);
    assert.equal(apply(source, api.insertStatementEdit(tree, site, 'let')), 'let^ 日本語 = p^{\n    let^ value = 0\n}');
});

test('a loop main-body append stays after main statements and before its following clauses', () => {
    const source = 'repeat^ 1 { prolog^: pre() main^: work() last^: tail() }';
    const call = text => node('call-stmt', source.indexOf(text), source.indexOf(text) + text.length);
    const prolog = node('loop-clause', source.indexOf('prolog^'), source.indexOf('pre()') + 5, { body: [call('pre()')] });
    const last = node('loop-clause', source.indexOf('last^'), source.indexOf('tail()') + 6, { body: [call('tail()')] });
    const body = node('block', source.indexOf('{'), source.length, { items: [call('work()')], extra: [prolog, last] });
    const tree = { source, root: node('block', 0, source.length, { items: [node('repeat', 0, source.length, { body })] }) };
    const site = api.statementInsertions(tree).find(s => s.start === body.start && s.before === undefined);
    assert.equal(api.insertStatementEdit(tree, site, 'let').start, last.start);
    const scope = flat(toElk(tree)).find(n => n.lhat?.kind === 'block' && n.lhat.start === body.start);
    assert.deepEqual(scope.children.map(n => n.lhat.kind), ['loop-clause', 'call-stmt', 'add', 'loop-clause']);
});

function host(options = {}) {
    const source = 'work()', tree = { source, root: node('block', 0, 6, { items: [node('call-stmt', 0, 6)] }) };
    const document = { uri: { toString: () => 'file:statements' }, version: 1, getText: () => source, positionAt: character => ({ line: 0, character }) };
    const edits = [], requests = [];
    const mock = { l10n: { t: s => s }, Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        WorkspaceEdit: class { changes = []; replace(uri, range, text) { this.changes.push({ uri, range, text }); } },
        workspace: { applyEdit: async edit => { edits.push(edit); return !options.refuse; } },
    };
    const client = { sendRequest: async (method, params) => {
        if (method === 'lhat/ast') return tree;
        requests.push({ method, params }); options.reply?.(document);
        return options.refusal ? { refusal: 'Cannot switch off this selection.' } : { exact: !options.oldServer, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: '#[~ work() ]#' }] };
    } };
    const { editStatementFromGraph } = load('graphStatementEditor.ts', mock);
    return { document, edits, requests, tree, mock, client,
        run: message => editStatementFromGraph(document, tree, { id: 'test', version: 1, ...message }, client, () => !options.closed) };
}
test('toggle uses the clicked statement range and the existing language-server operation', async () => {
    const f = host(); await f.run({ type: 'toggleStatement', start: 0, end: 6 });
    assert.equal(f.requests[0].method, 'lhat/toggleDisabledCode');
    assert.equal(f.requests[0].params.exact, true);
    assert.equal(f.requests[0].params.range.end.character, 6);
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].changes[0].text, '#[~ work() ]#');
});
test('stale, invalid, closed and refused statement edits never apply to another source version', async () => {
    for (const options of [{ closed: true }, { reply: doc => doc.version++ }, { refusal: true }, { oldServer: true }]) {
        const f = host(options); await assert.rejects(f.run({ type: 'toggleStatement', start: 0, end: 6 })); assert.equal(f.edits.length, 0);
    }
    const invalid = host(); await assert.rejects(invalid.run({ type: 'toggleStatement', start: 1, end: 5 })); assert.equal(invalid.requests.length, 0);
    const insert = host(); await insert.run({ type: 'insertStatement', site: api.statementInsertions(insert.tree).at(-1), template: 'let' });
    assert.equal(insert.requests.length, 0); assert.equal(insert.edits.length, 1);
    const refused = host({ refuse: true }); await assert.rejects(refused.run({ type: 'insertStatement', site: api.statementInsertions(refused.tree).at(-1), template: 'let' }), /Could not apply/);
});

test('the native context command edits its graph document without needing an active text editor', async () => {
    const h = host(), messages = [];
    Object.assign(h.mock, { env: { language: 'en' }, Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } });
    Object.assign(h.mock.workspace, {
        getConfiguration: () => ({ get: () => 'en' }),
        onDidChangeTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }),
    });
    let receive, dispose;
    const panel = { active: true, onDidDispose: callback => { dispose = callback; }, webview: {
        asWebviewUri: uri => uri, cspSource: 'test:', postMessage: message => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: callback => { receive = callback; },
    } };
    const Provider = load('graphEditor.ts', h.mock).LhatGraphEditorProvider;
    const provider = new Provider({ extensionUri: 'test:extension' }, () => h.client);
    await provider.resolveCustomTextEditor(h.document, panel, {});
    receive({ type: 'ready' }); await new Promise(setImmediate);
    const context = { lhatGraphUri: 'file:statements', lhatGraphVersion: 1, lhatStatementStart: 0, lhatStatementEnd: 6 };
    provider.toggleStatement(context); await new Promise(setImmediate);
    assert.equal(h.edits.length, 1);
    assert.equal(h.requests[0].params.textDocument.uri, 'file:statements');
    assert(messages.some(m => m.type === 'statementResult' && !m.error));
    provider.toggleStatement({ ...context, lhatGraphVersion: 0 }); await new Promise(setImmediate);
    assert.equal(h.edits.length, 1);
    assert(messages.some(m => m.type === 'statementResult' && m.error?.includes('source changed')));
    const foldContext = { ...context, lhatFoldable: true, lhatFoldKey: 'call:0:6' };
    provider.toggleFold(foldContext);
    assert.deepEqual(messages.at(-1), { type: 'toggleFold', key: 'call:0:6', version: 1 });
    const count = messages.length;
    provider.toggleFold({ ...foldContext, lhatFoldable: false });
    provider.toggleFold({ ...foldContext, lhatGraphUri: 'file:another-graph' });
    assert.equal(messages.length, count, 'invalid or other-document contexts do not reach the graph');
    dispose(); provider.toggleStatement(context); provider.toggleFold(foldContext); await new Promise(setImmediate);
    assert.equal(messages.length, count, 'closed graph contexts are ignored');
    assert.equal(h.edits.length, 1);
});
