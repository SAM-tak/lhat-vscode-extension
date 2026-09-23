const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
const { conditionalExpressions } = require('./condition-fixture.cjs');
const { patternMatching } = require('./pattern-fixture.cjs');
const { assignment } = require('./assignment-fixture.cjs');

function load(file) {
    const entry = path.resolve(__dirname, '../src/webview', file);
    const mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { createLabeler, displayType, labelText, labelColumns, nameColumns, renameTargetKey, ENGLISH_VOCABULARY } = load('labels.ts');
const { toElk, titleOf, stackWideDefinitions } = load('map.ts');
const { configureLocalization, graphVocabulary } = load('localization.ts');
const ja = require('../l10n/bundle.l10n.ja.json');
const { HATS, HAT_GROUPS } = load('vocabulary.ts');
const japanese = {
    variableDefinition: ja['Variable Definition'], mutableVariableDefinition: ja['Mutable Variable Definition'],
    variableDeclaration: ja['Variable Declaration'], mutableVariableDeclaration: ja['Mutable Variable Declaration'],
    string: ja.Text, number: ja.Number,
    tableDefinition: ja['Table type definition'],
    table: ja.Table,
    input: ja.Input, output: ja.Output, noOutput: ja['No output'], missingInput: ja['Missing input'],
    call: ja.Call, methodCall: ja['Method Call'],
    condition: ja.Condition, conditionalBranch: ja['Conditional Branch'], conditionalSelection: ja['Conditional Selection'],
    pattern: ja.Pattern, patternBranch: ja['Pattern Matching Branch'], patternSelection: ja['Pattern Matching Selection'],
    assignments: Object.fromEntries(Object.entries(ENGLISH_VOCABULARY.assignments).map(([operator, label]) => [operator, ja[label]])),
    nilCheckedAssignment: ja['{0} (nil-checked)'],
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

test('operator cells use localized words without changing their edit tokens, and holes match numeric widths', () => {
    const source = 'flag and^ true^', n = fixture(source);
    const reply = { source, root: n('binary', source, { left: n('ident', 'flag'), right: n('hat-ident', 'true^') }) };
    for (const [vocabulary, word] of [[japanese, 'かつ'], [ENGLISH_VOCABULARY, 'And']]) {
        const operator = flatten(toElk(reply, { vocabulary })).find(node => node.lhat?.operator);
        assert.equal(display(operator), word);
        assert.equal(operator.lhat.operator.text, 'and^');
        assert(operator.width >= labelColumns(word) * 7.2 + 12);
        const graph = toElk(require('./operator-fixture.cjs').operatorExpression(), { vocabulary });
        const hole = flatten(graph).find(node => node.lhat?.operandInput);
        const number = flatten(graph).find(node => node.lhat?.literal?.value === '3');
        assert.equal(hole.width, number.width);
        const method = flatten(toElk(require('./method-fixture.cjs').methodCall(), { vocabulary }));
        assert.equal(display(method.find(node => node.lhat?.invocation)), vocabulary.methodCall);
        assert.equal(display(method.find(node => node.lhat?.ioGroup === 'self')), vocabulary.hats.self);
    }
});

test('reassignment and all compound operations have consistent translated titles, including nil-checked forms', () => {
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) for (const [operator, title] of Object.entries(vocabulary.assignments)) {
        for (const guarded of [false, true]) {
            const reply = assignment((guarded ? '?' : '') + operator, { lowered: true });
            const all = flatten(toElk(reply, { vocabulary }));
            const group = all.find(node => node.lhat?.kind === 'reassign-row');
            const expected = guarded ? vocabulary.nilCheckedAssignment.replace('{0}', title) : title;
            assert.equal(display(group), expected);
            assert.equal(titleOf(reply.root, reply.source, vocabulary), expected);
            const folded = flatten(toElk(reply, { vocabulary, folds: { [group.lhat.foldKey]: true } })).find(node => node.lhat?.collapsed);
            assert.equal(display(folded), expected);
            assert.equal(group.lhat.labelParts[0].source, (guarded ? '?' : '') + operator);
        }
    }
});

test('conditions and patterns initially fold, while explicit unfolds and Unfold All take precedence', () => {
    for (const reply of [conditionalExpressions(), patternMatching(), patternMatching({ expression: true })]) {
        const initial = flatten(toElk(reply, { collapse: true }));
        const frames = initial.filter(node => ['condition', 'pattern'].includes(node.lhat?.kind));
        assert.equal(frames.length, 2);
        assert(frames.every(node => node.lhat.collapsed && node.lhat.foldedSummary && !node.children));
        const key = frames[0].lhat.foldKey;
        const individual = flatten(toElk(reply, { collapse: true, folds: { [key]: false } }));
        assert(individual.find(node => node.lhat?.foldKey === key).children.length > 0);
        assert(individual.find(node => node.lhat?.foldKey === frames[1].lhat.foldKey).lhat.collapsed);
        const all = flatten(toElk(reply, { collapse: false, collapseAll: false, folds: {} }));
        assert(all.filter(node => ['condition', 'pattern'].includes(node.lhat?.kind))
            .every(node => !node.lhat.collapsed && node.children.length > 0));
    }
});

test('if statements and expressions have distinct bilingual titles and structured, foldable conditions', async () => {
    const reply = conditionalExpressions(), original = JSON.stringify(reply);
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) for (const scale of [0.7, 1, 2]) {
        const options = { vocabulary, scale, collapse: false };
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, options)), 5000);
        const all = flatten(graph), statement = all.find(n => n.lhat?.kind === 'if-stmt'), expression = all.find(n => n.lhat?.kind === 'if-expr');
        assert.equal(display(statement), vocabulary.conditionalBranch);
        assert.equal(display(expression), vocabulary.conditionalSelection);
        for (const kind of ['if-stmt', 'if-expr']) {
            const ast = kind === 'if-stmt' ? reply.root.fields.items[0] : reply.root.fields.items[1].fields.values[0];
            const mapped = kind === 'if-stmt' ? statement : expression;
            assert.equal(titleOf(ast, reply.source, vocabulary), display(mapped));
            const folded = flatten(toElk(reply, { ...options, folds: { [mapped.lhat.foldKey]: true } })).find(n => n.lhat?.foldKey === mapped.lhat.foldKey);
            assert(folded.lhat.collapsed);
            assert.equal(display(folded), display(mapped));
        }
        const conditions = all.filter(n => n.lhat?.condition);
        assert.equal(conditions.length, 2, 'an else arm needs no empty condition box');
        for (const frame of conditions) {
            assert.equal(display(frame), vocabulary.condition);
            assert(frame.lhat.noExecutionHandles && frame.lhat.foldable);
            assert(frame.children[0].lhat.operatorExpression || frame.children[0].lhat.expressionTree);
            assert(flatten(frame).filter(n => n.lhat?.invocation).every(n => n.lhat.noExecutionHandles));
            assert(frame.width >= frame.children[0].x + frame.children[0].width);
            assert(frame.height >= frame.children[0].y + frame.children[0].height);
            const folded = flatten(toElk(reply, { ...options, folds: { [frame.lhat.foldKey]: true } }));
            const hidden = folded.find(n => n.lhat?.foldKey === frame.lhat.foldKey);
            assert(hidden.lhat.collapsed && !hidden.children);
            assert.equal(display(hidden), vocabulary.condition);
            assert.equal(hidden.lhat.foldedSummary, reply.source.slice(frame.lhat.start, frame.lhat.end));
            assert(folded.some(n => n.lhat?.condition && n.lhat.foldKey !== frame.lhat.foldKey && !n.lhat.collapsed));
        }
    }
    assert.equal(JSON.stringify(reply), original);
});

test('pattern trees have bilingual captions and horizontal statement arms or vertical expression alternatives', async () => {
    for (const expression of [false, true]) for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) for (const scale of [0.7, 1, 2]) {
        const reply = patternMatching({ expression }), original = JSON.stringify(reply);
        const options = { vocabulary, scale, collapse: false };
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, options)), 5000);
        const all = flatten(graph), match = all.find(n => n.lhat?.kind === 'for');
        assert.equal(display(match), expression ? vocabulary.patternSelection : vocabulary.patternBranch);
        assert.equal(titleOf(reply.root, reply.source, vocabulary), display(match));
        const junction = all.find(n => n.lhat?.kind === (expression ? 'if-expr' : 'if-stmt'));
        assert(junction.lhat.layoutOnly, 'lowered IF adds no redundant visible box');
        assert.equal(junction.layoutOptions['elk.direction'], expression ? 'DOWN' : 'RIGHT');
        assert.equal(junction.children.length, 3);
        for (let i = 1; i < junction.children.length; i++) {
            const before = junction.children[i - 1], after = junction.children[i];
            assert(expression ? after.y >= before.y + before.height : after.x >= before.x + before.width);
        }
        const patterns = all.filter(n => n.lhat?.kind === 'pattern');
        assert.equal(patterns.length, 2, 'the default arm has no fabricated pattern');
        assert(patterns.every(n => display(n) === vocabulary.pattern && n.lhat.noExecutionHandles && n.lhat.foldable));
        assert.equal(flatten(patterns[0]).filter(n => n.lhat?.invocation).length, 1, 'the nested call retains its call card');
        assert.equal(flatten(patterns[0]).filter(n => n.lhat?.operatorExpression).length, 1, 'the pattern operator is inline');
        assert(flatten(patterns[1]).some(n => n.lhat?.literal?.value === '3'), 'literal patterns use the normal value node');
        for (const frame of patterns) {
            assert.equal(frame.lhat.condition.axis, expression ? 'horizontal' : undefined);
            assert(frame.width >= frame.children[0].x + frame.children[0].width);
            assert(frame.height >= frame.children[0].y + frame.children[0].height);
            const folded = flatten(toElk(reply, { ...options, folds: { [frame.lhat.foldKey]: true } }));
            const hidden = folded.find(n => n.lhat?.foldKey === frame.lhat.foldKey);
            assert(hidden.lhat.collapsed && !hidden.children);
            assert.equal(display(hidden), vocabulary.pattern);
            assert.equal(hidden.lhat.foldedSummary, reply.source.slice(frame.lhat.start, frame.lhat.end));
        }
        const foldedMatch = flatten(toElk(reply, { ...options, folds: { [match.lhat.foldKey]: true } })).find(n => n.lhat?.kind === 'for');
        assert(foldedMatch.lhat.collapsed);
        assert.equal(display(foldedMatch), display(match));
        assert.equal(JSON.stringify(reply), original);
    }
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

test('folded conditions and patterns keep a separate title and textual preview, including literal-only predicates', () => {
    for (const pattern of [false, true]) for (const [kind, code] of [
        ['binary', 'foo = 1'], ['binary', '"foo", "bar"'], ['string', '"日本語"'], ['int', '123'], ['hat-ident', 'true^'],
    ]) for (const scale of [0.7, 1, 2]) {
        const source = pattern ? `for^ subject { when^ ${code}: print("ok") }` : `if^ ${code} { print("ok") }`;
        const n = fixture(source), predicate = n(kind, code);
        const body = n('block', 'print("ok")', { items: [n('call-stmt', 'print("ok")')] });
        const clause = n('if-clause', `${pattern ? 'when^ ' : 'if^ '}${code}${pattern ? ':' : ' {'}`, { condition: predicate, body });
        const conditional = n('if-stmt', pattern ? source.slice(source.indexOf('{')) : source, { items: [clause] });
        const root = pattern ? n('for', source, { focus: [n('ident', 'subject')], body: conditional }) : conditional;
        const role = pattern ? 'pattern' : 'condition', key = `${role}:${predicate.start}:${predicate.end}`;
        const graph = toElk({ source, root }, { vocabulary: japanese, scale, folds: { [key]: true } });
        const folded = flatten(graph).find(node => node.lhat?.foldKey === key);
        assert.equal(display(folded), pattern ? 'パターン' : '条件');
        assert.equal(folded.lhat.foldedSummary, code);
        assert(!folded.lhat.literal && !folded.children, 'a folded literal is a text preview, not an editable literal slot');
        assert(folded.height >= Math.round(54 * scale));
        assert(folded.width >= Math.ceil(labelColumns(code) * 7.2 * scale), 'the preview is included in layout width');
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
        const groups = flatten(graph).filter(n => n.lhat?.bindingGroup);
        assert(groups[0].lhat.labelParts.some(p => p.role === 'variableDefinition' && p.text === vocabulary.variableDefinition));
        assert.equal(left[0].lhat.labelParts.find(p => p.typeSite).typeLabel, vocabulary.string);
        assert(createLabeler(source, root, vocabulary)(declarations[0], [], 200).parts.map(part => part.text).join('').includes('#[ var^ number^ ]#'), 'comments are not keyword replacements');
        assert.equal(display(groups[1]), vocabulary.mutableVariableDefinition);
        assert.equal(display(left[1]), 'number');
        assert.equal(left[1].lhat.labelParts.find(p => p.typeSite).typeLabel, vocabulary.number);
        assert.deepEqual(groups[1].lhat.labelParts.filter(p => p.role).map(p => p.role), ['mutableVariableDefinition']);
        assert.equal(groups[1].labels[0].text, 'var^number:number^', 'raw labels remain available for source inspection');
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
                assert.equal(display(node), def);
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

test('tables have concise bilingual captions and independent folds, including empty and nested tables', () => {
    const source = 'let^ value = { {}, { 1, 2 } }', n = fixture(source);
    const empty = n('table', '{}');
    const inner = n('table', '{ 1, 2 }', { items: ['1', '2'].map(text => n('table-entry', text, { value: n('int', text) })) });
    const outer = n('table', '{ {}, { 1, 2 } }', { items: [
        n('table-entry', '{}', { value: empty }), n('table-entry', '{ 1, 2 }', { value: inner }),
    ] });
    const reply = { source, root: n('define', source, { targets: [n('ident', 'value')], values: [outer] }) };
    const before = JSON.stringify(reply);
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
        const draw = options => flatten(toElk(reply, { vocabulary, ...options }));
        const tables = nodes => nodes.filter(node => node.lhat?.kind === 'table');
        let nodes = draw({ collapse: true }), visible = tables(nodes);
        assert.equal(visible.length, 1);
        assert(visible[0].lhat.foldable && visible[0].lhat.collapsed);
        assert(!visible[0].children?.length, 'folded descendants are omitted from the ELK graph');
        assert.equal(display(visible[0]), vocabulary.table);
        nodes = draw({ collapse: true, folds: { [outer.start]: false } });
        visible = tables(nodes);
        assert.equal(visible.length, 3);
        assert(!visible[0].lhat.collapsed);
        assert(visible.slice(1).every(node => node.lhat.collapsed && node.lhat.foldable));
        assert(!nodes.some(node => node.lhat?.literal), 'opening the parent does not force its nested tables open');
        nodes = draw({ collapse: false });
        visible = tables(nodes);
        assert.equal(visible.length, 3);
        assert(visible.every(node => node.lhat.foldable && !node.lhat.collapsed && display(node) === vocabulary.table));
        const emptyBox = visible.find(node => node.lhat.start === empty.start);
        assert.equal(emptyBox.children.length, 1);
        assert.equal(emptyBox.children[0].lhat.synthetic, 'add');
        assert.equal(emptyBox.children[0].lhat.insertion.start, empty.start);
        assert.equal(nodes.filter(node => node.lhat?.literal).length, 2);
        assert(tables(draw({ collapse: false, folds: { [outer.start]: true } }))[0].lhat.collapsed);
        nodes = draw({ collapse: true, root: outer, folds: { [outer.start]: true } });
        assert(!nodes[0].lhat.collapsed, 'drilling shows the selected table despite its saved fold');
        assert.equal(tables(nodes).length, 3);
        assert.equal(titleOf(outer, source, vocabulary), vocabulary.table);
        assert.equal(titleOf(empty, source, vocabulary), vocabulary.table);
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

test('try recursively renders its calls and operators, including through an enclosing expression', async () => {
    const source = 'var^ a2 = try^ f4(g(10) + 1)\nlet^ results = pack^ try^ pair()';
    const n = fixture(source);
    const integer = text => ({ ...n('int', text), inferredType: 'number^' });
    const call = (name, text, args, outputs) => ({ ...n('call', text, {
        target: n('ident', name, undefined, source.indexOf(text)), argument: args,
    }), callable: { inputs: args.map(() => ({ type: 'number^', name: 'x' })), outputs } });
    const inner = call('g', 'g(10)', [integer('10')], ['number^']);
    const addition = { ...n('binary', 'g(10) + 1', { left: inner,
        right: { ...n('int', '1', undefined, source.indexOf('+')), inferredType: 'number^' } }), inferredType: 'number^' };
    const outer = call('f4', 'f4(g(10) + 1)', [addition], ['number^|Failure']);
    const propagation = n('try', 'try^ f4(g(10) + 1)', { value: outer });
    const pair = call('pair', 'pair()', [], ['number^', 'number^']);
    const packed = n('pack', 'pack^ try^ pair()', { value: n('try', 'try^ pair()', { value: pair }) });
    const reply = { source, root: n('block', source, { items: [
        n('define', source.split('\n')[0], { targets: [n('ident', 'a2')], values: [propagation] }),
        n('define', source.split('\n')[1], { targets: [n('ident', 'results')], values: [packed] }),
    ] }) };
    const before = JSON.stringify(reply);
    for (const [vocabulary, caption, catchCaption] of [
        [ENGLISH_VOCABULARY, 'Propagate error', 'Catch'], [japanese, 'エラー伝播', 'エラー捕捉'],
    ]) {
        assert.equal(vocabulary.hats.try, caption);
        assert.equal(vocabulary.hats.catch, catchCaption);
        for (const collapse of [true, false]) {
            const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { vocabulary, collapse, width: 1000 })), 1000);
            const nodes = flatten(graph);
            const wrappers = nodes.filter(node => node.lhat?.kind === 'try');
            assert.equal(wrappers.length, 2);
            assert(wrappers.every(node => display(node) === `${caption} …`));
            const body = flatten(wrappers[0]);
            assert.equal(body.filter(node => node.lhat?.kind === 'call').length, 2);
            assert.equal(body.filter(node => node.lhat?.kind === 'binary').length, 1);
            assert.equal(body.filter(node => node.lhat?.kind === 'input-slot').length, 2);
            assert.equal(body.filter(node => node.lhat?.kind === 'output-slot').length, 2);
            assert.equal(body.find(node => node.lhat?.literal?.value === '10')?.lhat.start, source.indexOf('10'));
            assert.equal(nodes.find(node => node.lhat?.kind === 'pack').children[0].id, wrappers[1].id);
            const binding = nodes.find(node => node.lhat?.kind === 'binding-pair');
            assert.equal(binding.children.find(node => node.lhat?.definitionRole === 'value').id, wrappers[0].id);
            assert(binding.edges.some(edge => edge.definition));
            for (const wrapper of wrappers) {
                const child = wrapper.children[0];
                assert(child.x >= 0 && child.y > 0);
                assert(child.x + child.width <= wrapper.width && child.y + child.height <= wrapper.height);
            }
        }
    }
    assert.equal(JSON.stringify(reply), before);
});

test('disabled statements keep localized labels without exposing edits or changing live names', () => {
    const source = '#[~ enum^Method { GET, POST }\nlet^ text = "enum^ let^"\nlet^ number^ = 1\nnumber^\n#[~ let^ table = def^{} ]#\n]#\nnumber^\n#[ enum^Ignored { GET } ]#';
    const n = fixture(source);
    const enumeration = n('enumdef', 'enum^Method { GET, POST }', {
        name: n('ident', 'Method'), members: [n('enum-member', 'GET'), n('enum-member', 'POST')],
    });
    const literal = n('string', '"enum^ let^"');
    const table = n('def', 'def^{}');
    const nested = n('disabled', '#[~ let^ table = def^{} ]#', { items: [n('define', 'let^ table = def^{}', {
        targets: [n('ident', 'table')], values: [table],
    })] });
    const localUse = n('hat-ident', 'number^', undefined, source.indexOf('\nnumber^'));
    const disabled = n('disabled', source.slice(0, source.indexOf('\n]#') + 3), { items: [enumeration,
        n('define', 'let^ text = "enum^ let^"', { targets: [n('ident', 'text')], values: [literal] }),
        n('define', 'let^ number^ = 1', { targets: [n('hat-ident', 'number^')], values: [n('int', '1')] }), localUse, nested,
    ] });
    const liveUse = n('hat-ident', 'number^', undefined, disabled.end);
    const comment = n('comment', '#[ enum^Ignored { GET } ]#');
    const root = n('block', source, { items: [disabled, liveUse] }), reply = { source, root }, before = JSON.stringify(reply);
    for (const vocabulary of [ENGLISH_VOCABULARY, japanese]) {
        const label = createLabeler(source, root, vocabulary);
        assert.equal(labelText(label(enumeration, [])), `${vocabulary.hats.enum} Method`);
        assert.equal(labelText(label(table, [])), vocabulary.tableDefinition);
        assert.equal(labelText(label(localUse, [])), 'number^', 'disabled user-defined hats stay verbatim locally');
        assert.equal(labelText(label(liveUse, [])), vocabulary.hats.number, 'disabled bindings cannot shadow live built-ins');
        assert.equal(labelText(label(literal, [])), '"enum^ let^"');
        assert.equal(labelText(label(comment, [])), '#[ enum^Ignored { GET } ]#');
        for (const collapse of [true, false]) {
            const graph = flatten(toElk(reply, { vocabulary, collapse }));
            const box = graph.find(node => node.lhat?.kind === 'enumdef');
            assert(box.lhat.disabled);
            assert(display(box).startsWith(`${vocabulary.hats.enum} Method`));
            assert(graph.filter(node => node.lhat?.disabled).flatMap(node => node.lhat.labelParts ?? []).every(part => !part.name && !part.symbol && !part.typeSite),
                'disabled translations do not introduce live name or type controls');
        }
    }
    assert.equal(JSON.stringify(reply), before);
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
        assert.deepEqual(parts.filter(p => p.typeSite).map(p => p.typeLabel), ['数値', '文字列']);
    }
    assert.equal(titleOf(fn, source, japanese), '関数 x:文字列-> 数値');
    assert.equal(titleOf(fn, source), 'f^x:string^-> number^', 'source-oriented callers can retain the source title');
    const drilled = toElk({ source, root: fn }, { vocabulary: japanese, root: fn, collapse: true });
    const binding = flatten(drilled).find(n => n.lhat?.bindingGroup);
    assert.equal(display(binding), '可変変数定義');
    assert(flatten(binding).some(n => display(n) === 'result' && n.lhat.labelParts.some(p => p.typeLabel === '数値')));
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
