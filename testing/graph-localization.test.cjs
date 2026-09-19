const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');

function load(file) {
    const entry = path.resolve(__dirname, '../src/webview', file);
    const mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { createLabeler, displayType, labelText, labelColumns, nameColumns, renameTargetKey, ENGLISH_VOCABULARY } = load('labels.ts');
const { toElk, titleOf } = load('map.ts');
const { configureLocalization, graphVocabulary } = load('localization.ts');
const ja = require('../l10n/bundle.l10n.ja.json');
const { HATS, HAT_GROUPS } = load('vocabulary.ts');
const japanese = {
    variableDefinition: ja['Variable Definition'], mutableVariableDefinition: ja['Mutable Variable Definition'],
    variableDeclaration: ja['Variable Declaration'], mutableVariableDeclaration: ja['Mutable Variable Declaration'],
    string: ja.Text, number: ja.Number,
    tableDefinition: ja['Table type definition'],
    hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, ja[entry.text]])),
    outer: ja['Outer {0}: {1}'], levels: ja['{0} ({1} levels)'] };
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
const display = n => n.lhat?.labelParts?.map(p => p.text).join('') ?? n.labels?.[0]?.text;

function fixture(source) {
    return (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
}

test('VS Code bundles select Japanese, default English and per-message English fallback', () => {
    configureLocalization(ja);
    assert.deepEqual(graphVocabulary(), japanese);
    configureLocalization({ Text: '文字列' });
    assert.deepEqual(graphVocabulary(), { ...ENGLISH_VOCABULARY, string: '文字列',
        hats: { ...ENGLISH_VOCABULARY.hats, string: '文字列' } });
    configureLocalization();
    assert.deepEqual(graphVocabulary(), ENGLISH_VOCABULARY);
});

test('type menu spellings use the graph vocabulary and structural tables need only braces', () => {
    for (const [vocabulary, number, text, fn, proc] of [
        [ENGLISH_VOCABULARY, 'Number', 'Text', 'Function', 'Procedure'],
        [japanese, '数値', '文字列', '関数', '手続き'],
    ]) {
        assert.equal(displayType('number^', vocabulary), number);
        assert.equal(displayType('godot.Area2D', vocabulary), 'godot.Area2D');
        assert.equal(displayType('t^{ count:number^, child:t^{ name:string^ } }', vocabulary),
            `{ count:${number}, child:{ name:${text} } }`);
        assert.equal(displayType('f^number^ -> t^{ text:string^ };', vocabulary), `${fn} ${number} -> { text:${text} };`);
        assert.equal(displayType('p^string^;', vocabulary), `${proc} ${text};`);
        assert.equal(displayType('t^{ ["t^"]:string^ }', vocabulary), `{ ["t^"]:${text} }`);
        assert.equal(displayType('t^{}', vocabulary, true), `${vocabulary.hats.t}…`);
        assert.equal(displayType('f^number^ -> string^;', vocabulary, true), `${fn}…`);
        assert.equal(displayType('p^number^;', vocabulary, true), `${proc}…`);
        const source = 't^{ count:number^ }';
        const root = fixture(source)('table-type', source);
        assert.equal(labelText(createLabeler(source, root, vocabulary)(root, [])), `{ count:${number} }`);
    }
});

test('long structural types do not widen variable nodes; complete types remain available for editing', async () => {
    const source = 'let^nested = def^{}', n = fixture(source);
    for (const [short, long] of [
        ['t^{}', `t^{ ${Array.from({ length: 30 }, (_, i) => `member${i}:string^`).join(', ')} }`],
        ['f^number^ -> string^;', `f^${Array(30).fill('number^').join(', ')} -> string^;`],
        ['p^number^;', `p^${Array(30).fill('number^').join(', ')};`],
    ]) {
        for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
            for (const scale of [1, 2]) {
                const layout = async type => {
                    const root = n('define', source, { targets: [{ ...n('ident', 'nested'), inferredType: type }],
                        values: [n('def', 'def^{}')] });
                    return flatten(await new ELK().layout(toElk({ source, root }, { vocabulary, scale })));
                };
                const brief = (await layout(short)).find(n => n.lhat?.definitionRole === 'declaration');
                const nodes = await layout(long), declaration = nodes.find(n => n.lhat?.definitionRole === 'declaration');
                assert.equal(declaration.width, brief.width, 'signature length must not enlarge the declaration');
                assert(declaration.width < 280 * scale);
                const part = declaration.lhat.labelParts.find(p => p.typeSite);
                assert.equal(part.typeLabel, displayType(long, vocabulary, true));
                assert.equal(part.typeSite.typeText, long, 'the summary never replaces editable source syntax');
                assert.equal(part.name.value, 'nested');
                assert(nodes.find(n => n.lhat?.definitionRole === 'value').x >= declaration.x + declaration.width);
            }
        }
    }
});

test('declaration roles, names and built-in types have separate source-safe display runs', () => {
    const source = 'public^#[ var^ number^ ]#let^名前:string^ = "let^ number^"\nvar^number:number^ = 42';
    const n = fixture(source);
    const firstEnd = source.indexOf('\n');
    const declarations = [
        n('define', source.slice(0, firstEnd), {
            targets: [n('param', '名前:string^', { name: n('ident', '名前'), type: n('type-name', 'string^') })],
            values: [n('string', '"let^ number^"')],
        }),
        n('define', source.slice(firstEnd + 1), {
            targets: [n('param', 'number:number^', { name: n('ident', 'number', undefined, firstEnd), type: n('type-name', 'number^', undefined, firstEnd) })],
            values: [n('int', '42')],
        }),
    ];
    const root = n('block', source, { items: declarations });
    const before = JSON.stringify({ source, root });
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
        const graph = toElk({ source, root }, { vocabulary });
        const left = flatten(graph).filter(n => n.lhat?.definitionRole === 'declaration');
        assert(display(left[0]).includes(`${vocabulary.variableDefinition} 名前`));
        assert.equal(left[0].lhat.labelParts.find(p => p.typeSite).typeLabel, vocabulary.string);
        assert(display(left[0]).includes('#[ var^ number^ ]#'), 'comments are not keyword replacements');
        assert.equal(display(left[1]), `${vocabulary.mutableVariableDefinition} number`);
        assert.equal(left[1].lhat.labelParts.find(p => p.typeSite).typeLabel, vocabulary.number);
        assert.deepEqual(left[1].lhat.labelParts.filter(p => p.role).map(p => p.role), ['mutableVariableDefinition']);
        assert.equal(left[1].labels[0].text, 'var^number:number^', 'raw labels remain available for source inspection');
        const string = flatten(graph).find(n => n.lhat?.literal?.kind === 'string');
        assert.equal(string.lhat.literal.value, 'let^ number^');
        assert.equal(string.lhat.literalTypeLabel, vocabulary.string);
    }
    assert.equal(JSON.stringify({ source, root }), before, 'localization never mutates source/AST');
});

test('invalid value-less let/var bindings are not presented as declarations', () => {
    const source = 'let^fixed:number^\nvar^pending:string^';
    const n = fixture(source);
    const root = n('block', source, { items: [
        n('define', 'let^fixed:number^', { targets: [n('param', 'fixed:number^', {
            name: n('ident', 'fixed'), type: n('type-name', 'number^'),
        })] }),
        n('define', 'var^pending:string^', { targets: [n('param', 'pending:string^', {
            name: n('ident', 'pending'), type: n('type-name', 'string^'),
        })] }),
    ] });
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
        const labels = flatten(toElk({ source, root }, { vocabulary })).filter(node => node.lhat?.kind === 'define');
        assert.deepEqual(labels.map(display), ['let^fixed:number^', 'var^pending:string^']);
    }
});

test('every standard hat has a bilingual label and registered graph-specific color', () => {
    const colors = new Set(require('../package.json').contributes.colors.map(c => c.id));
    const css = fs.readFileSync(path.resolve(__dirname, '../src/webview/rf/rf.css'), 'utf8');
    const seen = new Set();
    for (const [words, category, english, translation] of HAT_GROUPS) {
        assert(colors.has(`lhat.graph.${category}`));
        assert(css.includes(`--vscode-lhat-graph-${category}`));
        assert.equal(ja[english], translation);
        for (const word of words.split(' ')) {
            assert(!seen.has(word), `duplicate spelling ${word}`); seen.add(word);
            const source = `${word}^`;
            const node = fixture(source)('hat-ident', source);
            for (const [vocabulary, expected] of [[ENGLISH_VOCABULARY, english], [japanese, translation]]) {
                const label = createLabeler(source, node, vocabulary)(node, []);
                assert.equal(labelText(label), expected, source);
                assert.equal(label.parts[0].category, category);
                assert.equal(label.parts[0].source, source, 'source spelling remains in tooltip');
            }
        }
    }
    // Include aliases and all language keywords even if the text grammar lags.
    for (const word of 'let var localerrordef int float mutable fresh box constbox if when other self Self this break next skip continue'.split(' ')) assert(seen.has(word));
});

test('module declarations and table definitions have distinct labels from def references, including nested/folded views', async () => {
    const source = 'module^demo\nlet^T = def^ { foo = 1, ref = def^.foo, outer = def^^.foo, inner = def^ { text = "def^.foo" } }';
    const n = fixture(source);
    const member = spelling => n('member', spelling, { target: n('hat-ident', spelling.split('.')[0]), argument: [n('ident', 'foo', undefined, source.indexOf(spelling))] });
    const nested = n('def', 'def^ { text = "def^.foo" }', { items: [n('table-entry', 'text = "def^.foo"', {
        key: n('ident', 'text'), value: n('string', '"def^.foo"'),
    })] });
    const definition = n('def', source.slice(source.indexOf('def^')), { items: [
        n('table-entry', 'foo = 1', { key: n('ident', 'foo'), value: n('int', '1') }),
        n('table-entry', 'ref = def^.foo', { key: n('ident', 'ref'), value: member('def^.foo') }),
        n('table-entry', 'outer = def^^.foo', { key: n('ident', 'outer'), value: member('def^^.foo') }),
        n('table-entry', `inner = ${source.slice(nested.start, nested.end)}`, { key: n('ident', 'inner'), value: nested }),
    ] });
    const root = n('block', source, { items: [n('module', 'module^demo', { name: n('ident', 'demo') }),
        n('define', source.slice(source.indexOf('let^')), { targets: [n('ident', 'T')], values: [definition] }),
    ] });
    const reply = { source, root }, before = JSON.stringify(reply);
    for (const [vocabulary, module, def, ref, outer] of [
        [japanese, 'モジュール宣言', 'テーブル型定義', '型定義', '外側1段: 型定義'],
        [ENGLISH_VOCABULARY, 'Module declaration', 'Table type definition', 'Type definition', 'Outer 1: Type definition'],
    ]) {
        const labeler = createLabeler(source, root, vocabulary);
        assert.equal(labelText(labeler(root.fields.items[0], [])), `${module} demo`);
        assert.equal(labelText(labeler(member('def^.foo'), [])), `${ref}.foo`);
        assert.equal(labelText(labeler(member('def^^.foo'), [])), `${outer}.foo`);
        assert(titleOf(definition, source, vocabulary).startsWith(def), 'breadcrumb uses construct label');
        for (const collapse of [true, false]) {
            const nodes = flatten(await new ELK().layout(toElk(reply, { vocabulary, collapse })));
            const definitions = nodes.filter(node => node.lhat?.kind === 'def');
            assert(definitions.length >= 1);
            for (const node of definitions) {
                assert(display(node).startsWith(def));
                assert(node.width >= labelColumns(def) * 7.2, 'longer caption fits the box');
                assert.equal(node.lhat.labelParts.find(p => p.role === 'def').source, 'def^');
            }
            if (!collapse) {
                assert(nodes.some(node => display(node) === `${ref}.foo`));
                assert(nodes.some(node => display(node) === `${outer}.foo`));
                assert(nodes.some(node => node.lhat?.literal?.value === 'def^.foo'), 'string contents stay literal');
            }
        }
        const drilled = flatten(toElk(reply, { root: definition, vocabulary, collapse: false }));
        assert(drilled.some(node => display(node) === `${ref}.foo`));
        assert(drilled.some(node => node.lhat?.kind === 'def' && display(node).startsWith(def)));
    }
    assert.equal(JSON.stringify(reply), before);
});

test('functions and procedures use independent cool/warm theme colors in every display language', () => {
    const colors = require('../package.json').contributes.colors;
    const fn = colors.find(c => c.id === 'lhat.graph.function');
    const proc = colors.find(c => c.id === 'lhat.graph.procedure');
    for (const theme of ['dark', 'light', 'highContrast', 'highContrastLight']) {
        assert.notEqual(fn.defaults[theme], proc.defaults[theme]);
    }
    assert.equal(fn.defaults.dark, '#89cff0');
    assert.equal(proc.defaults.dark, '#e3d58c');
    for (const vocabulary of [japanese, ENGLISH_VOCABULARY]) {
        for (const [word, category] of [['f', 'function'], ['p', 'procedure']]) {
            const source = `${word}^ {}`;
            const n = fixture(source), body = n('block', '{}');
            const root = n('func', source, { body });
            for (const collapse of [true, false]) {
                const nodes = flatten(toElk({ source, root }, { vocabulary, collapse }));
                const marker = nodes.find(n => n.lhat?.kind === 'signature-title');
                assert.equal(marker.lhat.labelParts.find(part => part.role === word).category, category);
            }
        }
    }
});

test('hat depth remains visible, while quoted text and user-defined hats remain unchanged', () => {
    const source = 'break^^^ next^^ self^^ Self^^^ "if^" \'let^\' `var^` custom^';
    const node = fixture(source)('expr', source);
    const label = createLabeler(source, node, japanese)(node, [], 200);
    assert.equal(labelText(label), '脱出（3段） 次の繰り返し（2段） 外側1段: 自身 外側2段: 自身の型 "if^" \'let^\' `var^` custom^');
    const declaration = 'let^tostring^ = 1\ntostring^';
    const n = fixture(declaration);
    const root = n('block', declaration, { items: [n('define', 'let^tostring^ = 1', {
        targets: [n('hat-ident', 'tostring^')], values: [n('int', '1')],
    }), n('hat-ident', 'tostring^', undefined, 18)] });
    const parts = createLabeler(declaration, root, japanese)(root, []).parts;
    assert(!parts.some(p => p.role === 'tostring'), 'a user binding is not a built-in member');
});

test('editable declarations carry full UTF-16 name spans, never translated or truncated names', () => {
    const name = '長い名前'.repeat(18);
    const source = `let^${name}:string^ = "text"`;
    const n = fixture(source);
    const root = n('define', source, { targets: [n('param', `${name}:string^`, {
        name: n('ident', name), type: n('type-name', 'string^'),
    })], values: [n('string', '"text"')] });
    const declaration = flatten(toElk({ source, root }, { vocabulary: japanese })).find(n => n.lhat?.definitionRole === 'declaration');
    const part = declaration.lhat.labelParts.find(p => p.name);
    assert.deepEqual(part.name, { start: 4, end: 4 + name.length, value: name });
    assert.equal(part.text, name);
    assert(declaration.width > labelColumns(name) * 7.2);
});

test('committed let/var names resize their input and declaration geometry without changing rename targets', async () => {
    assert.equal(nameColumns('x'), 3, 'small input minimum');
    assert.equal(nameColumns('日本語'), 6, 'full-width characters');
    for (const keyword of ['let', 'var']) {
        const source = `${keyword}^originalName:number^ = 42`;
        const n = fixture(source);
        const root = n('define', source, { targets: [n('param', 'originalName:number^', {
            name: n('ident', 'originalName'), type: n('type-name', 'number^'),
        })], values: [n('int', '42')] });
        const reply = { source, root };
        const snapshot = JSON.stringify(reply);
        for (const scale of [7 / 12, 1, 28 / 12]) {
            const layout = async nameValues => flatten(await new ELK().layout(toElk(reply, { scale, vocabulary: japanese, nameValues })));
            const declaration = nodes => nodes.find(n => n.lhat?.definitionRole === 'declaration');
            const before = declaration(await layout());
            const original = before.lhat.labelParts.find(p => p.name).name;
            const key = renameTargetKey(original);
            const long = 'とても長い定義名に変更した場合の表示';
            const grownGraph = await layout({ [key]: long });
            const grown = declaration(grownGraph);
            const shrunk = declaration(await layout({ [key]: 'x' }));
            assert(grown.width > before.width);
            assert(shrunk.width < before.width);
            assert(grown.width >= nameColumns(long) * 7.2 * scale);
            assert.equal(grownGraph.find(n => n.lhat?.definitionRole === 'value').x > grown.x + grown.width, true, 'right-hand value moves out of the resized declaration');
            assert.deepEqual(grown.lhat.labelParts, before.lhat.labelParts, 'pending resize cannot rewrite source spans/names');
            assert.equal(declaration(await layout({})).width, before.width, 'cancel/source refresh restores width');
            assert.equal(JSON.stringify(reply), snapshot);
        }
    }
});

test('identifiers, quoted member keys, literal contents and non-built-in type names are untouched', () => {
    const source = '`let^`:Custom = "string^ var^"';
    const n = fixture(source);
    const root = n('table-entry', source, {
        key: n('ident', '`let^`'), type: n('type-name', 'Custom'), value: n('string', '"string^ var^"'),
    });
    const label = createLabeler(source, root, japanese)(root, []);
    assert.equal(labelText(label), source);
    assert(label.parts.every(p => p.role === undefined));
    const string = n('string', '"string^ var^"');
    assert.equal(labelText(createLabeler(source, root, japanese)(string, [])), '"string^ var^"');
});

test('function signatures, folds, breadcrumbs and drilled views share the localized type vocabulary', () => {
    const source = 'f^x:string^-> number^ { var^result:number^ = 42 }';
    const n = fixture(source);
    const body = n('block', '{ var^result:number^ = 42 }', { items: [
        n('define', 'var^result:number^ = 42', {
            targets: [n('param', 'result:number^', { name: n('ident', 'result'), type: n('type-name', 'number^', undefined, source.indexOf('{')) })],
            values: [n('int', '42')],
        }),
    ] });
    const fn = n('func', source, {
        params: [n('param', 'x:string^', { name: n('ident', 'x'), type: n('type-name', 'string^') })],
        return_type: n('type-name', 'number^'), body,
    });
    for (const collapse of [true, false]) {
        const graph = toElk({ source, root: fn }, { vocabulary: japanese, collapse });
        const functionNode = flatten(graph).find(n => n.lhat?.kind === 'func');
        const signature = flatten(functionNode).find(n => n.lhat?.kind === 'signature');
        const parts = flatten(signature).flatMap(n => n.lhat?.labelParts ?? []);
        const title = parts.map(p => p.text).join('');
        assert(title.includes('x'));
        assert.deepEqual(parts.filter(p => p.typeSite).map(p => p.typeLabel), ['文字列', '数値']);
    }
    assert.equal(titleOf(fn, source, japanese), '関数 x:文字列-> 数値');
    assert.equal(titleOf(fn, source), 'f^x:string^-> number^', 'source-oriented callers can retain the source title');
    const drilled = toElk({ source, root: fn }, { vocabulary: japanese, root: fn, collapse: true });
    assert(flatten(drilled).some(n => display(n) === '可変変数定義 result' && n.lhat.labelParts.some(p => p.typeLabel === '数値')));
    assert(flatten(drilled).some(n => n.lhat?.literalTypeLabel === '数値'));
});

test('translated text, wide glyphs and literal type captions determine geometry at every font size', async () => {
    assert.equal(labelColumns('abc'), 3);
    assert.equal(labelColumns('可変変数定義'), 12);
    assert.equal(labelColumns('数値😀'), 6);
    assert.equal(labelColumns('e\u0301'), 1);
    const source = 'let^金額:number^ = 42';
    const n = fixture(source);
    const root = n('block', source, { items: [n('define', source, {
        targets: [n('param', '金額:number^', { name: n('ident', '金額'), type: n('type-name', 'number^') })],
        values: [n('int', '42')],
    })] });
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
        for (const scale of [7 / 12, 1, 28 / 12]) {
            const graph = await new ELK().layout(toElk({ source, root }, { vocabulary, scale }));
            const [declaration, value] = flatten(graph).find(n => n.lhat?.definitionRole === 'row').children;
            assert(declaration.width >= labelColumns(display(declaration)) * 7.2 * scale);
            assert(value.width >= labelColumns(vocabulary.number) * 7.2 * scale);
            assert.equal(value.height, Math.round(44 * scale));
            assert(declaration.x + declaration.width < value.x);
            assert.equal(value.ports[0].y, declaration.ports[0].y, 'definition endpoints remain aligned');
        }
    }
});

test('the extracted runtime and static catalogs have complete Japanese translations', () => {
    const base = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../l10n/bundle.l10n.json'), 'utf8'));
    assert.deepEqual(Object.keys(ja).sort(), Object.keys(base).sort());
    const nls = require('../package.nls.json'), translated = require('../package.nls.ja.json');
    assert.deepEqual(Object.keys(nls).sort(), Object.keys(translated).sort());
    const manifest = require('../package.json');
    assert.equal(manifest.l10n, './l10n');
    const setting = manifest.contributes.configuration.properties['lhat.graph.language'];
    assert.equal(setting.default, 'auto');
    assert.deepEqual(setting.enum, ['auto', 'ja', 'en']);
    assert.equal(setting.scope, 'window');
    for (const match of JSON.stringify(manifest).matchAll(/%([^%]+)%/g)) {
        assert.equal(typeof nls[match[1]], 'string');
        assert.equal(typeof translated[match[1]], 'string');
    }
});

async function graphHost({ language = 'en', setting, readFile } = {}) {
    const entry = path.resolve(__dirname, '../src/graphEditor.ts');
    const js = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
        external: ['vscode'], write: false }).outputFiles[0].text;
    const bundle = language === 'ja' ? ja : undefined;
    const messages = [], reads = [];
    let receive, configurationChanged, closed, textChanged;
    let requests = 0, subscriptionsDisposed = 0;
    const uri = { toString: () => 'test:source' };
    const mock = {
        env: { language }, l10n: { bundle, t: text => text },
        Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') },
        workspace: {
            fs: { readFile: async file => {
                reads.push(file);
                return readFile ? readFile() : Buffer.from(JSON.stringify(ja));
            } },
            getConfiguration: (section, resource) => {
                assert.equal(section, 'lhat.graph'); assert.equal(resource, uri);
                return { get: (key, fallback) => { assert.equal(key, 'language'); return setting ?? fallback; } };
            },
            onDidChangeTextDocument: callback => {
                textChanged = callback;
                return { dispose() { subscriptionsDisposed++; textChanged = undefined; } };
            },
            onDidChangeConfiguration: callback => {
                configurationChanged = callback;
                return { dispose() { subscriptionsDisposed++; configurationChanged = undefined; } };
            },
        },
    };
    const mod = new Module(entry);
    mod.require = name => name === 'vscode' ? mock : require(name);
    mod._compile(js, entry);
    const panel = { onDidDispose: callback => { closed = callback; }, webview: {
        asWebviewUri: uri => uri, cspSource: 'test:',
        postMessage: message => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: callback => { receive = callback; },
    } };
    const reply = { source: '', root: { kind: 'block', start: 0, end: 0, line: 1, column: 1 } };
    const provider = new mod.exports.LhatGraphEditorProvider({ extensionUri: 'test:extension' },
        () => ({ sendRequest: async () => { requests++; return reply; } }));
    await provider.resolveCustomTextEditor({ uri, version: 1, getText: () => '' }, panel, {});
    return {
        messages, reply, reads, mock,
        get requests() { return requests; },
        get subscriptionsDisposed() { return subscriptionsDisposed; },
        ready: () => receive({ type: 'ready' }),
        edit: () => textChanged?.({ document: { uri } }),
        close: () => closed(),
        change(value, affects = true) {
            setting = value;
            configurationChanged?.({ affectsConfiguration: (key, resource) => {
                assert.equal(key, 'lhat.graph.language'); assert.equal(resource, uri); return affects;
            } });
        },
    };
}
const flush = () => new Promise(setImmediate);

test('auto/unset use VS Code; explicit Japanese/English override only the graph before its first tree', async () => {
    for (const language of ['ja', 'en', 'fr']) {
        for (const setting of [undefined, 'auto', 'ja', 'en', 'invalid']) {
            const host = await graphHost({ language, setting });
            host.ready(); await flush();
            const expected = ['ja', 'en'].includes(setting) ? setting : language;
            assert.deepEqual(host.messages.map(m => m.type), ['localization', 'tree']);
            assert.equal(host.messages[0].language, expected);
            assert.deepEqual(host.messages[0].bundle, expected === 'ja' ? ja : undefined);
            assert.equal(host.messages[1].reply, host.reply, 'the original AST is forwarded untouched');
            assert.deepEqual(host.reads, setting === 'ja' ? ['test:extension/l10n/bundle.l10n.ja.json'] : []);
            assert.equal(host.mock.env.language, language, 'workbench language is untouched');
            host.close();
        }
    }
});

test('language changes update open graphs without rereading the AST, and listeners are disposed', async () => {
    const host = await graphHost({ language: 'en' });
    host.change('ja'); await flush();
    assert.equal(host.messages.length, 0, 'wait for Webview ready');
    host.ready(); await flush();
    host.change('en'); await flush();
    host.change('ja'); await flush();
    host.change(undefined); await flush();
    assert.deepEqual(host.messages.filter(m => m.type === 'localization').map(m => m.language), ['ja', 'en', 'ja', 'en']);
    assert.equal(host.requests, 1, 'language updates cannot reset graph-only drafts through an AST refresh');
    host.change('ja', false); await flush();
    assert.equal(host.messages.length, 5, 'unrelated configuration changes are ignored');
    host.edit(); await flush();
    assert.equal(host.requests, 2, 'source editing still refreshes the AST');
    host.close();
    assert.equal(host.subscriptionsDisposed, 2);
    host.change('ja'); await flush();
    assert.equal(host.messages.length, 6, 'closed views receive no updates');
});

test('a slow bundle cannot overwrite a newer language or publish a tree before the latest language', async () => {
    let finish;
    const host = await graphHost({ setting: 'ja', readFile: () => new Promise(resolve => { finish = resolve; }) });
    host.ready(); host.edit();
    assert.equal(host.messages.length, 0);
    host.change('en'); await flush();
    assert.deepEqual(host.messages.map(m => m.type), ['localization', 'tree']);
    assert.equal(host.messages[0].language, 'en');
    finish(Buffer.from(JSON.stringify(ja))); await flush();
    assert.equal(host.messages.length, 2, 'stale Japanese load is discarded');
    assert.equal(host.requests, 1);
    host.close();
});

test('disposing a panel during bundle loading suppresses both localization and tree messages', async () => {
    let finish;
    const host = await graphHost({ setting: 'ja', readFile: () => new Promise(resolve => { finish = resolve; }) });
    host.ready(); host.close();
    finish(Buffer.from(JSON.stringify(ja))); await flush();
    assert.deepEqual(host.messages, []);
    assert.equal(host.requests, 0);
});
