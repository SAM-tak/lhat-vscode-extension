const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
const { branchedCalls } = require('./call-tree-fixture.cjs');
const { assignment } = require('./assignment-fixture.cjs');
function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { listInsertions, insertListEdit, listTemplates, groupedOperatorSites, replaceOperatorEdit, operatorGroup, operatorSites } = load('graphLists.ts');
const { callInfo, callReceiver, takesSelf } = load('graphCalls.ts');
const { methodCall } = require('./method-fixture.cjs');
const { indexExpression } = require('./index-fixture.cjs');
const { toElk, stackWideDefinitions } = load('webview/map.ts');
const { ASSIGNMENT_LABELS, assignmentOperator, assignmentValues } = load('graphAssignments.ts');
const { commaLists } = load('graphLists.ts');
const { expressionCells, isInlineValue } = load('webview/operatorExpression.ts');
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);
function fixture(source) {
    return (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from); assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
}
function binding(source = 'let^ a, b = 1, 2') {
    const n = fixture(source);
    return { source, root: n('define', source, { targets: [n('ident', 'a', undefined, 4), n('ident', 'b', undefined, 4)],
        values: [n('int', '1'), n('int', '2')] }) };
}

test('operator rows preserve precedence, unary spelling, primitive values and parentheses outside AST spans', () => {
    for (const source of ['a + b * 2', 'a + #[ (ignored) ]# b * 2']) {
        const n = fixture(source);
        const product = n('binary', 'b * 2', { left: n('ident', 'b'), right: n('int', '2') });
        const root = n('binary', source, { left: n('ident', 'a'), right: product });
        const cells = expressionCells(root, source);
        assert.deepEqual(cells.map(cell => cell.token?.text ?? source.slice(cell.operand.start, cell.operand.end)), ['a', '+', 'b', '*', '2']);
        assert(cells.filter(cell => cell.operand).every(cell => cell.inline));
    }
    const source = '!flag and^ true^ or^ "(text)" = "text"', n = fixture(source);
    const unary = n('unary', '!flag', { value: n('ident', 'flag') });
    const left = n('binary', '!flag and^ true^', { left: unary, right: n('hat-ident', 'true^') });
    const right = n('binary', '"(text)" = "text"', { left: n('string', '"(text)"'), right: n('string', '"text"') });
    const cells = expressionCells(n('binary', source, { left, right }), source);
    assert.deepEqual(cells.map(cell => cell.token?.text ?? source.slice(cell.operand.start, cell.operand.end)),
        ['!', 'flag', 'and^', 'true^', 'or^', '"(text)"', '=', '"text"']);
    assert(cells.filter(cell => cell.operand).every(cell => cell.inline));
    for (const source of ['(a + b) * c', 'a * (b + c)']) {
        const n = fixture(source), grouped = source.startsWith('(') ? 'a + b' : 'b + c';
        for (const includeParens of [false, true]) {
            const inner = n('binary', includeParens ? `(${grouped})` : grouped,
                { left: n('ident', grouped[0]), right: n('ident', grouped.at(-1)) });
            const root = n('binary', source, source.startsWith('(') ? { left: inner, right: n('ident', 'c') }
                : { left: n('ident', 'a'), right: inner });
            const cells = expressionCells(root, source);
            assert.equal(cells.filter(cell => cell.operand && !cell.inline).length, 1);
            assert.equal(expressionCells(inner, source).filter(cell => cell.operand && !cell.inline).length, 0);
        }
    }
});

test('plain dotted name paths inline in operators, indices and method receivers', () => {
    for (const source of ['a.b.c + 1', 'items[a.b.c]', 'a.b.c.Remove(1)']) {
        const n = fixture(source);
        const inner = n('member', 'a.b', { target: n('ident', 'a'), argument: n('ident', 'b') });
        const path = n('member', 'a.b.c', { target: inner, argument: n('ident', 'c') }, 0, { inferredType: 'number^' });
        assert(isInlineValue(path, source));
        let root;
        if (source.includes('+')) root = n('binary', source, { left: path, right: n('int', '1') });
        else if (source.includes('[')) root = n('index', source, { target: n('ident', 'items'), argument: [path] });
        else root = n('call', source, { target: n('member', 'a.b.c.Remove', { target: path, argument: n('ident', 'Remove') }),
            argument: [n('int', '1')] }, 0, { callable: { signature: 'f^self^, number^ -> number^;', inputs: [{ type: 'number^' }], outputs: ['number^'] } });
        const all = flatten(toElk({ source, root }));
        assert(!all.some(node => node.lhat?.operandInput));
        const rendered = all.find(node => node.lhat?.kind === 'member' && node.lhat.start === path.start && node.lhat.end === path.end);
        assert(rendered && !rendered.children, 'the complete path is one source-backed leaf');
        if (root.kind === 'call') assert(all.find(node => node.lhat?.ioGroup === 'self').children.includes(rendered));
    }
});

test('dotted paths do not inline calls, indices, computed keys or grouped receivers', () => {
    for (const [source, baseText, kind] of [['make().x.y', 'make()', 'call'], ['items[0].x.y', 'items[0]', 'index'],
        ['(a).x.y', 'a', 'ident'], ['a.(x).y', 'a', 'ident']]) {
        const n = fixture(source), base = n(kind, baseText);
        const innerText = source.slice(0, source.lastIndexOf('.'));
        const inner = n('member', innerText, { target: base, argument: n('ident', 'x') });
        const path = n('member', source, { target: inner, argument: n('ident', 'y') });
        assert(!isInlineValue(path, source), source);
    }
    const source = 'self^. #[ignore (.)]# value.0', n = fixture(source);
    const inner = n('member', 'self^. #[ignore (.)]# value', { target: n('hat-ident', 'self^'), key: n('ident', 'value') });
    const path = n('member', source, { target: inner, key: n('int', '0') });
    assert(isInlineValue(path, source), 'comments and constant dot members do not turn a path into an expression');
    inner.computed = true;
    assert(!isInlineValue(path, source));
});

test('only resolved self signatures create method receivers, including legacy and explicit calls', () => {
    for (const signature of ['f^self^;', 'p^ mutable^self^, number^;', 'closed^f^self^ -> number^;']) assert(takesSelf(signature));
    for (const signature of ['f^number^;', 'f^f^self^; -> number^;', 'f^number^, self^;', '(f^self^;) & (f^number^;)']) assert(!takesSelf(signature));
    for (const legacy of [false, true]) for (const explicit of [false, true]) {
        const { root } = methodCall({ legacy, explicit });
        const info = callInfo(root), receiver = callReceiver(root);
        assert(receiver);
        assert.equal(receiver.explicit, explicit);
        assert.equal(receiver.value.kind, 'ident');
        assert.equal(info.inputs.length, explicit ? 2 : 1);
        assert.equal(info.inputs.at(-1).type, 'number^');
    }
    assert.equal(callReceiver(methodCall({ plain: true }).root), undefined, 'a function stored in a member is not a method');
    const ambiguous = methodCall().root;
    ambiguous.callable.signature = 'f^number^ -> number^;';
    assert.equal(callReceiver(ambiguous), undefined, 'the resolved arm overrides the target type');
});

test('server receiver metadata identifies already-bound built-ins without guessing from member names', () => {
    const reply = methodCall();
    reply.root.callable.signature = 'f^number^ -> Dense;';
    reply.root.fields.target.inferredType = reply.root.callable.signature;
    reply.root.callable.receiver = { binding: 'member', type: 'Dense' };
    assert.equal(callReceiver(reply.root).value.kind, 'ident');
    assert.equal(callReceiver(reply.root).type, 'Dense');
    let all = flatten(toElk(reply));
    assert.equal(all.find(node => node.lhat?.invocation).lhat.labelParts[0].text, 'Method Call');
    assert.equal(all.filter(node => node.lhat?.ioGroup === 'self').length, 1);
    assert.equal(all.filter(node => node.lhat?.kind === 'input-slot').length, 1);
    // An explicit negative answer is authoritative, including on a target
    // whose unresolved signature still contains self.
    reply.root.callable.receiver = null;
    reply.root.callable.signature = 'f^self^, number^ -> Dense;';
    assert.equal(callReceiver(reply.root), undefined);
    all = flatten(toElk(reply));
    assert(!all.some(node => node.lhat?.ioGroup === 'self'));
    assert.equal(all.find(node => node.lhat?.invocation).lhat.labelParts[0].text, 'Call');
    const explicit = methodCall({ explicit: true });
    explicit.root.callable.receiver = { binding: 'argument', type: 'Dense' };
    assert(callReceiver(explicit.root).explicit);
    explicit.root.callable.receiver = { binding: 'implicit', type: '?' };
    explicit.root.fields.argument = [];
    explicit.root.callable.inputs = [];
    all = flatten(toElk(explicit));
    assert(all.some(node => node.lhat?.kind === 'implicit-self'));
    assert(!all.some(node => node.lhat?.kind === 'missing-input'));
});

test('method Self is inline for simple values, separate from ordinary inputs and localized in its own group', async () => {
    for (const receiver of ['dense', '3', '"text"', 'true^']) for (const explicit of [false, true]) {
        const reply = methodCall({ receiver, explicit }), before = JSON.stringify(reply);
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply)), 1200);
        const all = flatten(graph), card = all.find(node => node.lhat?.invocation);
        assert.equal(card.lhat.labelParts[0].text, 'Method Call');
        const self = all.find(node => node.lhat?.ioGroup === 'self'), input = all.find(node => node.lhat?.ioGroup === 'input');
        assert.equal(self.labels[0].text, 'Self');
        assert.equal(self.children.length, 1);
        assert.equal(reply.source.slice(self.children[0].lhat.start, self.children[0].lhat.end), receiver);
        assert(self.y + self.height < input.y, 'Self sits above Input');
        assert.equal(input.children.length, 1);
        assert.equal(input.children[0].lhat.labelParts[0].text, 'index');
        assert.equal(all.filter(node => node.lhat?.kind === 'self-slot').length, 0);
        const tree = all.find(node => node.lhat?.callTree);
        assert.equal(tree.lhat.definitionLinks.length, 1, 'only the written index argument needs a wire');
        assert.equal(JSON.stringify(reply), before);
    }
    for (const procedure of [false, true]) {
        const graph = toElk(methodCall({ noArgs: true, procedure }));
        assert(flatten(graph).some(node => node.lhat?.ioGroup === 'self'));
        assert(!flatten(graph).some(node => node.lhat?.ioGroup === 'input'));
    }
});

test('complex Self values use the argument columns and are evaluated visually only once', async () => {
    for (const receiver of ['make()', '(1 + 2)']) {
        const reply = methodCall({ receiver });
        for (const scale of [0.7, 1, 2]) {
            const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 1200);
            const all = flatten(graph), self = all.find(node => node.lhat?.ioGroup === 'self');
            const slot = self.children[0], tree = all.find(node => node.lhat?.callTree);
            assert.equal(slot.lhat.kind, 'self-slot');
            assert(tree.lhat.definitionLinks.some(link => link.target === slot.id));
            assert.equal(tree.lhat.callArguments.length, 2, 'receiver and ordinary argument have distinct slots');
            assert.equal(all.filter(node => node.lhat?.invocation).length, receiver === 'make()' ? 2 : 1);
            assert.equal(all.filter(node => node.lhat?.operatorExpression).length, receiver === 'make()' ? 0 : 1);
            const title = tree.children[0].children[0].children[0];
            assert(!flatten(title).some(node => node.lhat?.invocation || node.lhat?.operatorExpression), 'the method title does not duplicate Self');
        }
    }
});

test('grouped operands and calls sit below compact operator rows with reserved definition lanes', async () => {
    const reply = require('./operator-fixture.cjs').operatorExpression(), before = JSON.stringify(reply);
    for (const scale of [0.7, 1, 2]) {
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 1000);
        const all = flatten(graph), tree = all.find(node => node.lhat?.expressionTree);
        const [row, column] = tree.children;
        assert.deepEqual(row.children.map(cell => cell.labels[0].text), ['', '*', '3', '+', '', '+', '']);
        assert.equal(all.filter(node => node.lhat?.invocation).length, 1);
        assert.equal(all.filter(node => node.lhat?.operatorExpression).length, 3);
        assert.equal(column.children.length, 3);
        assert(column.y > row.y + row.height);
        for (const [i, value] of column.children.entries()) {
            assert.equal(value.x, column.children[0].x);
            if (i) assert(value.y > column.children[i - 1].y + column.children[i - 1].height);
            const link = tree.lhat.operandLinks[i];
            assert.equal(link.source, value.lhat.definitionOutputs?.[0] ?? value.id);
            assert(value.lhat.operandOutputY !== undefined);
            const slot = row.children.find(cell => cell.id === link.target);
            assert(slot.lhat.operandInput);
            assert.equal(slot.lhat.labelParts[0].typeLabel, 'Number');
            assert.equal(slot.lhat.labelParts[0].source, 'number^');
            assert(link.laneOffset > 0 && link.laneOffset <= value.x);
            assert(slot.y + slot.height + link.rise < column.y + value.y);
        }
        const key = row.lhat.foldKey;
        const folded = flatten(toElk(reply, { folds: { [key]: true } }));
        assert(folded.some(node => node.lhat?.collapsed));
        assert(!folded.some(node => node.lhat?.operandLinks));
    }
    assert.equal(JSON.stringify(reply), before);
});

test('an extracted operand without an inferred type keeps its neutral hole', () => {
    const reply = require('./operator-fixture.cjs').operatorExpression();
    const call = reply.root.fields.left.fields.right;
    delete call.inferredType;
    call.callable.outputs = [];
    const graph = toElk(reply);
    const slots = flatten(graph).filter(node => node.lhat?.operandInput);
    assert(slots.some(slot => slot.labels[0].text === '•' && !slot.lhat.labelParts));
    assert(slots.some(slot => slot.lhat.labelParts?.[0].typeLabel === 'Number'));
});

test('a call operand uses its sole resolved output type when inferredType is absent', () => {
    const reply = require('./operator-fixture.cjs').operatorExpression();
    const call = reply.root.fields.left.fields.right;
    delete call.inferredType;
    const slotForCall = () => {
        const graph = toElk(reply);
        return flatten(graph).find(node => node.lhat?.operandInput && node.lhat.start === call.start && node.lhat.end === call.end);
    };
    assert.equal(slotForCall().lhat.labelParts[0].typeLabel, 'Number');
    call.callable.outputs = ['number^', 'string^'];
    assert.equal(slotForCall().labels[0].text, '•', 'multiple results do not identify one operand type');
});

test('binding additions insert a discard and nil together, preserving Unicode comments and trailing commas', () => {
    for (const source of ['let^ a, b = 1, 2', 'let^ a, #[日本語]# b = 1, #[keep]# 2,']) {
        const tree = binding(source), sites = listInsertions(tree);
        assert(sites.every(site => site.field === 'targets'));
        assert.equal(sites.length, 2);
        const between = sites.find(site => site.before !== undefined), append = sites.find(site => site.before === undefined);
        assert.equal(listTemplates(tree, append)[0].id, 'binding');
        const inserted = apply(source, insertListEdit(tree, between, 'binding'));
        assert.equal(inserted, source.replace('a,', 'a, _^,').replace('1,', '1, nil^,'));
        const added = apply(source, insertListEdit(tree, append, 'binding'));
        assert.equal(added, source.replace('b =', 'b, _^ =').replace('2', '2, nil^'));
        assert.equal(insertListEdit(tree, { ...append, field: 'values' }, 'binding'), undefined);
    }
});

test('a call initializer and existing arity mismatches never expose binding addition or rewrite source', () => {
    const source = 'let^ a, b = f()', n = fixture(source);
    const tree = { source, root: n('define', source, { targets: [n('ident', 'a'), n('ident', 'b')],
        values: [n('call', 'f()', { target: n('ident', 'f', undefined, 10) }, 0,
            { callable: { inputs: [], outputs: ['number^', 'string^'] } })] }) };
    assert.equal(listInsertions(tree).length, 0);
    assert(!flatten(toElk(tree)).some(node => node.lhat?.appendInsertion));
    const mismatch = binding(); mismatch.root.fields.values.pop();
    assert.equal(listInsertions(mismatch).length, 0);
    const before = JSON.stringify(mismatch); toElk(mismatch); assert.equal(JSON.stringify(mismatch), before);
});

test('tuple decomposition adds both positions while retaining its written parentheses', () => {
    const source = 'let^ a, b = (1, #[keep]# 2)', n = fixture(source);
    const root = n('define', source, { targets: [n('ident', 'a'), n('ident', 'b')],
        values: [n('tuple', '(1, #[keep]# 2)', { items: [n('int', '1'), n('int', '2')] })] });
    const tree = { source, root }, sites = listInsertions(tree);
    assert(sites.every(site => site.kind === 'define' && site.field === 'targets'));
    const append = sites.find(site => site.before === undefined);
    assert.equal(apply(source, insertListEdit(tree, append, 'binding')), 'let^ a, b, _^ = (1, #[keep]# 2, nil^)');
    assert.equal(flatten(toElk(tree)).filter(node => node.lhat?.kind === 'binding-pair').length, 2);
});

test('fixed call inputs cannot grow, missing inputs use declared defaults and variadic inputs can grow', () => {
    const source = 'f(1)', n = fixture(source);
    const call = n('call', source, { target: n('ident', 'f'), argument: [n('int', '1')] }, 0,
        { callable: { inputs: [{ type: 'number^', name: 'x' }], outputs: ['number^'] } });
    const tree = { source, root: call };
    assert.equal(listInsertions(tree).length, 0);
    call.callable.inputs.push({ type: 'number^', name: 'y', default: '(2 + 3) * 4' });
    let site = listInsertions(tree)[0];
    assert.equal(apply(source, insertListEdit(tree, site, 'default')), 'f(1, (2 + 3) * 4)');
    call.callable.inputs.pop(); call.callable.variadic = { type: 'number^' };
    site = listInsertions(tree)[0];
    assert.equal(apply(source, insertListEdit(tree, site, 'default')), 'f(1, 0)');
});

test('legacy callable types retain nested signatures and tuple outputs without invented names', () => {
    const target = { kind: 'ident', inferredType: 'f^f^number^ -> string^;, string^ -> number^, string^;' };
    const info = callInfo({ fields: { target } });
    assert.deepEqual(info.inputs, [{ type: 'f^number^ -> string^;' }, { type: 'string^' }]);
    assert.deepEqual(info.outputs, ['number^', 'string^']);
    assert.equal(callInfo({ fields: { target: { inferredType: '(f^number^ -> number^;) & (f^string^ -> string^;)' } } }), undefined);
});

function addition(source, nestedSide = 'left') {
    const n = fixture(source), a = n('ident', 'a'), b = n('ident', 'b'), c = n('ident', 'c');
    [a, b, c].forEach(node => { node.inferredType = 'number^'; });
    const binary = (left, right) => ({ kind: 'binary', start: left.start, end: right.end, fields: { left, right }, inferredType: 'number^' });
    return { source, root: nestedSide === 'left' ? binary(binary(a, b), c) : binary(a, binary(b, c)) };
}

test('one operator chain retains operand order and replaces every token in one edit', () => {
    const tree = addition('a + #[keep]# b + c'), group = operatorGroup(tree.root, tree.source, operatorSites(tree));
    assert.deepEqual(group.operands.map(node => tree.source.slice(node.start, node.end)), ['a', 'b', 'c']);
    assert.equal(groupedOperatorSites(tree).length, 1);
    assert.equal(apply(tree.source, replaceOperatorEdit(tree, group.site, '*')), 'a * #[keep]# b * c');
    const graph = toElk(tree);
    assert.equal(flatten(graph).filter(node => node.lhat?.kind === 'binary').length, 1);
    assert.equal(flatten(graph).filter(node => node.lhat?.kind === 'input-slot').length, 0);
    const row = flatten(graph).find(node => node.lhat?.operatorExpression);
    assert.deepEqual(row.children.map(node => node.labels[0].text), ['a', '+', 'b', '+', 'c']);
    assert(row.children.filter(node => node.lhat.operator).every(node => node.lhat.operator.members.length === 2));
});

test('parentheses, overload boundaries and short circuiting prevent operator grouping', () => {
    for (const [source, side] of [['a + (b + c)', 'right'], ['(a + b) + c', 'left']]) {
        const tree = addition(source, side);
        assert.equal(groupedOperatorSites(tree).length, 2);
        const parent = groupedOperatorSites(tree)[0];
        assert.equal((apply(source, replaceOperatorEdit(tree, parent, '*')).match(/\*/g) ?? []).length, 1);
        assert.equal(flatten(toElk(tree)).filter(node => node.lhat?.kind === 'binary').length, 2);
    }
    const overloaded = addition('a + b + c'); overloaded.root.fields.left.inferredType = 'MyValue';
    assert.equal(groupedOperatorSites(overloaded).length, 2);
    const overloadedResult = addition('a + b + c'); overloadedResult.root.fields.left.fields.left.inferredType = 'MyValue';
    assert.equal(groupedOperatorSites(overloadedResult).length, 2, 'an overloaded inner operator may itself return number');
    const short = addition('a and^ b and^ c');
    assert.equal(groupedOperatorSites(short).length, 2);
});

test('right associative chains retain source order and their existing association', () => {
    const tree = addition('a ** b ** c', 'right');
    const group = operatorGroup(tree.root, tree.source, operatorSites(tree));
    assert.deepEqual(group.operands.map(node => tree.source.slice(node.start, node.end)), ['a', 'b', 'c']);
    assert.equal(group.site.members.length, 2);
});

test('single comparisons and comparison chains use inline values and distinct operators', () => {
    const source = 'a < b', n = fixture(source);
    const root = n('compare-chain', source, { operands: [n('ident', 'a'), n('ident', 'b')] }, 0, { inferredType: 'bool^' });
    const graph = toElk({ source, root });
    assert(!flatten(graph).some(node => node.lhat?.invocation || node.lhat?.kind === 'input-slot' || node.lhat?.kind === 'output-slot'));
    assert.deepEqual(flatten(graph).find(node => node.lhat?.operatorExpression).children.map(node => node.labels[0].text), ['a', '<', 'b']);
    assert.equal(flatten(graph).find(node => node.lhat?.operator).lhat.operator.text, '<');
    const chainSource = 'a < b <= c', c = fixture(chainSource);
    const chain = { source: chainSource, root: c('compare-chain', chainSource, { operands: [c('ident', 'a'), c('ident', 'b'), c('ident', 'c')] }) };
    assert.deepEqual(groupedOperatorSites(chain).map(site => site.text), ['<', '<=']);
});

test('layout aligns vertical binding pairs and callable groups without duplicating evaluation', async () => {
    const source = 'let^ a, b = f(1, 2)', n = fixture(source);
    const call = n('call', 'f(1, 2)', { target: n('ident', 'f', undefined, 10), argument: [n('int', '1'), n('int', '2')] }, 0,
        { callable: { inputs: [{ type: 'string^', name: 'x' }, { type: 'number^', name: 'longer' }], outputs: ['number^', 'string^'] } });
    const root = n('define', source, { targets: [n('ident', 'a'), n('ident', 'b')], values: [call] });
    const tree = { source, root }, before = JSON.stringify(tree);
    for (const scale of [1, 2]) {
        const laid = stackWideDefinitions(await new ELK().layout(toElk(tree, { scale })), 5000), all = flatten(laid);
        assert.equal(all.filter(node => node.lhat?.kind === 'call').length, 1);
        const columns = all.find(node => node.lhat?.kind === 'call-groups');
        const [output, input] = columns.children;
        assert.equal(output.lhat.ioGroup, 'output'); assert.equal(input.lhat.ioGroup, 'input');
        assert(output.x + output.width < input.x); assert.equal(output.y, input.y);
        assert.equal(input.children[0].x, input.children[1].x);
        assert.equal(input.children[0].lhat.labelParts[0].typeLabel, 'Text');
        assert(input.children.every(node => node.lhat.kind === 'input-slot'));
        const callTree = all.find(node => node.lhat?.callTree), argumentsColumn = callTree.children[1];
        assert.equal(argumentsColumn.children[0].lhat.literalTypeLabel, 'Number');
        assert(argumentsColumn.x > callTree.children[0].x + callTree.children[0].width, 'values are outside the entire call card');
        const row = all.find(node => node.lhat?.kind === 'binding-outputs');
        assert.equal(row.lhat.definitionLinks.length, 2);
        assert.deepEqual(row.lhat.definitionLinks.map(link => link.source), output.children.map(node => node.id));
        const ys = new Map();
        const index = (node, y = 0) => { y += node.y ?? 0; ys.set(node.id, y + (node.lhat?.definitionHandleY ?? 0)); node.children?.forEach(child => index(child, y)); };
        index(laid);
        row.lhat.definitionLinks.forEach(link => assert.equal(ys.get(link.source), ys.get(link.target)));
    }
    assert.equal(JSON.stringify(tree), before);
    const laid = await new ELK().layout(toElk(binding())), pairs = flatten(laid).filter(node => node.lhat?.kind === 'binding-pair');
    assert(pairs[0].y + pairs[0].height < pairs[1].y);
    assert.equal(pairs[0].x, pairs[1].x);
});

test('calls omit empty groups and put a sole result beside the callable without losing definition endpoints', async () => {
    for (const outputs of [[], ['nil^'], ['number^', 'string^']]) for (const hasInput of [false, true]) {
        const expression = hasInput ? 'f(1)' : 'f()';
        const source = outputs.length === 1 ? `let^ result = ${expression}` : expression, n = fixture(source);
        const call = n('call', expression, { target: n('ident', 'f', undefined, source.indexOf(expression)),
            argument: hasInput ? [n('int', '1')] : [] }, 0,
            { callable: { inputs: hasInput ? [{ type: 'number^', name: 'x' }] : [], outputs } });
        const root = outputs.length === 1 ? n('define', source, { targets: [n('ident', 'result')], values: [call] }) : call;
        const reply = { source, root }, before = JSON.stringify(reply);
        for (const scale of [0.7, 2]) {
            const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 5000);
            const all = flatten(graph), invocation = all.find(node => node.lhat?.invocation);
            assert.equal(invocation.lhat.labelParts[0].text, 'Call');
            assert.notEqual(graph.id, invocation.id, 'a root call retains its visible box and caption');
            assert.equal(all.filter(node => node.lhat?.ioGroup === 'input').length, Number(hasInput));
            assert.equal(all.filter(node => node.lhat?.ioGroup === 'output').length, Number(outputs.length > 1));
            const slots = all.filter(node => node.lhat?.kind === 'output-slot');
            assert.deepEqual(invocation.lhat.definitionOutputs, slots.map(node => node.id));
            assert.equal(slots.length, outputs.length, 'nil is one result, not an empty result list');
            if (outputs.length === 1) {
                const header = invocation.children[0], [slot, title] = header.children;
                assert.equal(slot.id, slots[0].id);
                assert(slot.x + slot.width < title.x);
                assert.equal(slot.y + slot.height / 2, title.y + title.height / 2);
                const row = all.find(node => node.lhat?.kind === 'binding-pair');
                const declaration = row.children.find(node => node.lhat?.definitionRole === 'declaration');
                assert.equal(declaration.y + declaration.lhat.definitionHandleY,
                    invocation.y + header.y + slot.y + slot.lhat.definitionHandleY);
                assert(row.edges.some(edge => edge.definition));
            }
        }
        assert.equal(JSON.stringify(reply), before);
    }
});

test('empty variadic calls retain insertion, missing inputs retain slots, and definitions retain both groups', () => {
    const source = 'f()', n = fixture(source);
    const call = n('call', source, { target: n('ident', 'f'), argument: [] }, 0,
        { callable: { inputs: [], outputs: [], variadic: { type: 'any^' } } });
    let all = flatten(toElk({ source, root: call }));
    assert(!all.some(node => node.lhat?.ioGroup));
    const additions = all.filter(node => node.lhat?.synthetic === 'add');
    assert.equal(additions.length, 1);
    assert.equal(additions[0].lhat.insertion.field, 'argument');
    assert(listTemplates({ source, root: call }, additions[0].lhat.insertion).length > 0);
    call.callable.inputs.push({ type: 'number^', name: 'x', default: '1' });
    all = flatten(toElk({ source, root: call }));
    assert.equal(all.filter(node => node.lhat?.ioGroup === 'input').length, 1);
    assert.equal(all.filter(node => node.lhat?.kind === 'missing-input').length, 1);
    const definitionSource = 'p^{}', d = fixture(definitionSource);
    const definition = d('func', definitionSource, { body: d('block', '{}') });
    all = flatten(toElk({ source: definitionSource, root: definition }, { collapse: true }));
    assert.deepEqual(all.filter(node => node.lhat?.ioGroup).map(node => node.lhat.ioGroup), ['output', 'input']);
    assert(!all.some(node => node.lhat?.invocation));
});

test('call arguments retain inline operators and extract grouped expressions below their row', async () => {
    const source = 'f(a + (b * c), 4)', n = fixture(source);
    const number = (kind, text, fields) => ({ ...n(kind, text, fields), inferredType: 'number^' });
    const product = number('binary', 'b * c', { left: number('ident', 'b'), right: number('ident', 'c') });
    const sum = number('binary', 'a + (b * c)', { left: number('ident', 'a'), right: product });
    const root = n('call', source, { target: n('ident', 'f'), argument: [sum, number('int', '4')] }, 0,
        { callable: { inputs: [{ name: 'expression', type: 'number^' }, { name: 'other', type: 'number^' }], outputs: ['number^'] } });
    const tree = { source, root }, before = JSON.stringify(tree);
    for (const scale of [0.7, 1, 2]) for (const width of [450, 1200]) {
        const graph = stackWideDefinitions(await new ELK().layout(toElk(tree, { scale, width })), width - 16);
        const all = flatten(graph), points = new Map();
        const index = (node, x = 0, y = 0) => {
            x += node.x ?? 0; y += node.y ?? 0;
            points.set(node.id, { x, y, handleY: y + (node.lhat?.definitionHandleY ?? 0) });
            node.children?.forEach(child => index(child, x, y));
        };
        index(graph);
        assert.equal(all.filter(node => node.lhat?.kind === 'call').length, 1);
        assert.equal(all.filter(node => node.lhat?.kind === 'binary').length, 2);
        assert.equal(all.filter(node => node.lhat?.invocation).length, 1);
        assert(!all.some(node => node.lhat?.ioGroup === 'output'));
        const calls = all.filter(node => node.lhat?.invocation);
        const trees = all.filter(node => node.lhat?.callTree);
        assert.equal(trees.length, 1, 'direct call arguments join one layout, without nested call trees');
        const layout = trees[0];
        assert.equal(layout.children.length, 2);
        assert.deepEqual(layout.children.map(column => column.children.length), [1, 2]);
        const expression = all.find(node => node.lhat?.expressionTree);
        const [row, external] = expression.children;
        assert.deepEqual(row.children.map(cell => cell.labels[0].text), ['a', '+', '']);
        assert.equal(row.children[2].lhat.labelParts[0].typeLabel, 'Number');
        assert(external.y > row.y + row.height);
        assert.deepEqual(external.children[0].children.map(cell => cell.labels[0].text), ['b', '*', 'c']);
        assert.equal(expression.lhat.operandLinks.length, 1);
        for (const column of layout.children) {
            assert.equal(column.y, layout.children[0].y, 'depth columns start at the same top');
            for (const [i, value] of column.children.entries()) {
                assert.equal(value.x, column.children[0].x, 'same-depth values share a left edge');
                if (i) assert(value.y > column.children[i - 1].y + column.children[i - 1].height);
            }
        }
        for (const call of calls) {
            const frame = flatten(call).find(node => node.lhat?.ioGroup === 'input'), f = points.get(frame.id);
            assert.equal(flatten(call).filter(node => node.lhat?.invocation).length, 1, 'no call card contains an argument call');
            assert(frame.children.every(node => node.lhat.kind === 'input-slot'));
            const card = points.get(call.id);
            assert.equal(f.x + frame.width, card.x + call.width - Math.round(10 * scale), 'input frame hugs the right padding');
            for (const input of frame.children) {
                const p = points.get(input.id);
                assert(p.x >= f.x && p.x + input.width <= f.x + frame.width, 'input stays inside its frame');
                assert(p.y >= f.y && p.y + input.height <= f.y + frame.height);
            }
        }
        assert.equal(layout.lhat.definitionLinks.length, 2);
        for (const link of layout.lhat.definitionLinks) {
            const left = layout.children[link.column], right = layout.children[link.column + 1];
            const input = all.find(node => node.id === link.target), p = points.get(input.id);
            const lane = p.x + input.width + link.laneOffset;
            assert(lane > points.get(left.id).x + left.width && lane < points.get(right.id).x, 'bend lies in the column gap');
            assert(points.has(link.source), 'every input retains its actual expression/output endpoint');
        }
    }
    assert.equal(JSON.stringify(tree), before, 'layout never changes the source tree');
});

test('sibling calls share a column in source order and the next statement clears the whole tree', async () => {
    const reply = branchedCalls(), before = JSON.stringify(reply);
    for (const scale of [0.7, 1, 2]) {
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 5000);
        const trees = graph.children.filter(node => node.lhat?.callTree), [tree, next] = trees;
        const [first, second, third] = tree.children;
        assert.deepEqual(tree.children.map(column => column.children.length), [1, 3, 2]);
        assert.equal(first.y, second.y); assert.equal(second.y, third.y);
        const [left, right, label] = second.children;
        assert.equal(left.x, right.x); assert.equal(left.x, label.x);
        assert(left.lhat.invocation && right.lhat.invocation);
        assert.equal(reply.source.slice(left.lhat.start, left.lhat.end), 'left(a)');
        assert.equal(reply.source.slice(right.lhat.start, right.lhat.end), 'right(b)');
        assert(right.y > left.y + left.height); assert(label.y > right.y + right.height);
        assert(tree.height >= second.height && tree.height > first.height);
        assert(next.y > tree.y + tree.height, 'execution does not run into a deeper column');
        const firstCard = first.children[0], nextColumn = next.children[0], nextCard = nextColumn.children[0];
        const axis = tree.x + first.x + firstCard.x + firstCard.width / 2;
        assert.equal(axis, next.x + nextColumn.x + nextCard.x + nextCard.width / 2, 'execution stays on the first call cards');
        const start = graph.children.find(node => node.lhat?.synthetic === 'start');
        assert.equal(start.x + start.width / 2, axis);
        assert.equal(tree.lhat.definitionLinks.length, 5);
    }
    assert.equal(JSON.stringify(reply), before);
});

test('index expressions retain their own internal call scope outside the consuming call', async () => {
    const source = 'f(items[g(a)])', n = fixture(source);
    const inner = n('call', 'g(a)', { target: n('ident', 'g'), argument: [n('ident', 'a', undefined, source.indexOf('g('))] }, 0,
        { callable: { inputs: [{ name: 'index', type: 'number^' }], outputs: ['number^'] } });
    const index = n('index', 'items[g(a)]', { target: n('ident', 'items'), argument: [inner] });
    const outer = n('call', source, { target: n('ident', 'f'), argument: [index] }, 0,
        { callable: { inputs: [{ name: 'value', type: 'number^' }], outputs: ['number^'] } });
    const graph = stackWideDefinitions(await new ELK().layout(toElk({ source, root: outer })), 5000), all = flatten(graph);
    const trees = all.filter(node => node.lhat?.callTree), value = all.find(node => node.lhat?.kind === 'index');
    assert.equal(trees.length, 2);
    const scope = all.find(node => node.lhat?.expressionTree);
    assert(flatten(scope).includes(trees[1]), 'index keeps its own expression boundary');
    assert.equal(trees[0].children[1].children[0].id, scope.id);
    assert.deepEqual(value.children.map(cell => cell.labels[0].text), ['items', '[', '', ']']);
    assert.equal(value.children[2].lhat.labelParts[0].typeLabel, 'Number');
    assert.equal(value.lhat.definitionHandleY, value.height / 2);
    assert.equal(trees[0].lhat.definitionLinks[0].source, value.id);
});

test('index targets and subscripts embed only simple values and keep each complex value outside the row', async () => {
    for (const options of [{ simple: true }, {}, { targetCall: true, simple: true },
        { targetCall: true, indexCall: true }, { optional: true, simple: true }, { multi: true }]) {
        const reply = indexExpression(options), before = JSON.stringify(reply);
        for (const scale of [0.7, 1, 2]) {
            const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 1200);
            const all = flatten(graph), row = all.find(node => node.lhat?.kind === 'index');
            const expected = [options.targetCall ? '' : 'dense', options.optional ? '?[' : '[', options.simple ? 'i' : '',
                ...options.multi ? [',', '2'] : [], ']'];
            assert.deepEqual(row.children.map(cell => cell.labels[0].text), expected);
            for (let i = 1; i < row.children.length; i++) {
                const a = row.children[i - 1], b = row.children[i];
                assert(a.x + a.width <= b.x);
                assert.equal(a.y + a.height / 2, b.y + b.height / 2);
            }
            const holes = row.children.filter(cell => cell.lhat?.operandInput);
            const scope = all.find(node => node.lhat?.expressionTree);
            assert.equal(holes.length, Number(!!options.targetCall) + Number(!options.simple));
            if (holes.length) {
                assert.equal(scope.lhat.operandLinks.length, holes.length);
                const [header, column] = scope.children;
                assert.equal(header.id, row.id);
                assert(column.y >= header.y + header.height);
                for (const [i, child] of column.children.entries()) {
                    assert.equal(scope.lhat.operandLinks[i].source, child.lhat.definitionOutputs?.[0] ?? child.id);
                    assert.equal(scope.lhat.operandLinks[i].target, holes[i].id);
                }
            }
            assert.equal(all.filter(node => node.lhat?.invocation).length, Number(!!options.targetCall) + Number(!!options.indexCall));
        }
        assert.equal(JSON.stringify(reply), before);
    }
});

test('port-aligned call subtrees reserve descendant space and keep literal wires horizontal', async () => {
    let source = '';
    const expression = spec => {
        const start = source.length;
        let kind, fields, callable;
        if (Array.isArray(spec)) {
            const [name, ...args] = spec;
            source += name;
            const target = { kind: 'ident', start, end: source.length, line: 1, column: start + 1 };
            source += '(';
            const argument = args.map((arg, i) => { if (i) source += ', '; return expression(arg); });
            source += ')';
            kind = 'call'; fields = { target, argument };
            callable = { inputs: args.map(() => ({ type: 'number^', name: 'x' })), outputs: ['number^'] };
        } else {
            source += spec;
            kind = /^\d/.test(spec) ? 'int' : spec.startsWith('"') ? 'string' : 'ident';
        }
        return { kind, start, end: source.length, line: 1, column: start + 1, fields, callable, inferredType: 'number^' };
    };
    const first = expression(['expect', ['both', ['both', ['eq', 'a', '3'], ['eq', 'b', '10']], ['eq', 'values', '30']], '"label"']);
    source += '\n';
    const next = expression(['done']);
    const statement = value => ({ ...value, kind: 'call-stmt', fields: { value }, callable: undefined });
    const root = { kind: 'block', start: 0, end: source.length, line: 1, column: 1,
        fields: { items: [statement(first), statement(next)] } };
    const reply = { source, root };
    for (const scale of [0.7, 1, 2]) {
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply, { scale })), 5000);
        const tree = flatten(graph).find(node => node.lhat?.callTree), points = new Map();
        const following = graph.children.find(node => node.lhat?.callTree && node !== tree);
        assert(following.y > tree.y + tree.height, 'growing a subtree moves the following statement too');
        assert(graph.height >= following.y + following.height, 'the enclosing frame contains the shifted statement');
        const index = (node, x = 0, y = 0) => {
            x += node.x ?? 0; y += node.y ?? 0;
            points.set(node.id, { x, y, portY: y + (node.lhat?.definitionHandleY ?? (node.height ?? 0) / 2), node });
            node.children?.forEach(child => index(child, x, y));
        };
        index(tree);
        const call = text => [...points.values()].find(p => p.node.lhat?.invocation && source.slice(p.node.lhat.start, p.node.lhat.end) === text);
        const deep = call('eq(b, 10)'), lower = call('eq(values, 30)');
        assert(lower.y + lower.node.height > deep.y + deep.node.height);
        const b = [...points.values()].find(p => p.node.lhat?.kind === 'ident' && source.slice(p.node.lhat.start, p.node.lhat.end) === 'b');
        const values = [...points.values()].find(p => p.node.lhat?.kind === 'ident' && source.slice(p.node.lhat.start, p.node.lhat.end) === 'values');
        assert(values.y > deep.y + deep.node.height, 'later branch values clear the preceding branch card');
        assert(b.y > deep.y, 'a leaf follows its input, rather than the top of its depth column');
        for (const link of tree.lhat.definitionLinks) {
            const from = points.get(link.source), to = points.get(link.target);
            if (['ident', 'int'].includes(from.node.lhat?.kind)) {
                assert.equal(from.portY, to.portY, 'non-colliding literal/identifier links are horizontal');
            }
        }
        const lanes = tree.lhat.definitionLinks.map(link => {
            const from = points.get(link.source), to = points.get(link.target);
            return { x: to.x + to.node.width + link.laneOffset, top: Math.min(from.portY, to.portY), bottom: Math.max(from.portY, to.portY) };
        }).filter(line => line.bottom > line.top);
        lanes.forEach((line, i) => lanes.slice(i + 1).forEach(other => {
            assert(Math.abs(line.x - other.x) > 0.01 || line.bottom <= other.top || other.bottom <= line.top,
                'unrelated vertical wires never share an overlapping segment');
        }));
        for (const column of tree.children) for (const item of column.children) {
            assert(item.y >= 0 && item.y + item.height <= column.height);
            assert(column.y + column.height <= tree.height);
            assert(column.x + column.width <= tree.width);
        }
    }
});

test('call folds prune only their subtree, retain independent sibling state and restore on unfold', () => {
    const reply = branchedCalls(), before = JSON.stringify(reply);
    const expanded = flatten(toElk(reply, { collapse: true }));
    const calls = expanded.filter(node => node.lhat?.invocation);
    assert.equal(calls.length, 4, 'initial definition folding does not hide newly foldable calls');
    assert(calls.every(node => node.lhat.foldable && node.lhat.foldKey));
    assert(expanded.filter(node => ['ident', 'input-slot', 'output-slot'].includes(node.lhat?.kind))
        .every(node => !node.lhat.foldable), 'leaves and port slots have no fold buttons');
    const left = calls.find(node => reply.source.slice(node.lhat.start, node.lhat.end) === 'left(a)');
    const right = calls.find(node => reply.source.slice(node.lhat.start, node.lhat.end) === 'right(b)');
    const folds = { [left.lhat.foldKey]: true };
    const folded = flatten(toElk(reply, { folds }));
    assert.equal(folded.filter(node => node.lhat?.invocation).length, 3);
    assert(folded.find(node => node.lhat?.foldKey === left.lhat.foldKey).lhat.collapsed);
    assert(folded.some(node => node.lhat?.invocation && node.lhat.foldKey === right.lhat.foldKey));
    assert(folded.length < expanded.length, 'hidden subtrees never reach ELK or React Flow');
    assert.equal(flatten(toElk(reply, { folds: { ...folds, [left.lhat.foldKey]: false } }))
        .filter(node => node.lhat?.invocation).length, 4);
    const allFolded = flatten(toElk(reply, { collapseAll: true }));
    assert.equal(allFolded.filter(node => node.lhat?.collapsed).length, 2, 'Fold All folds the two statements, not the view root');
    assert.equal(JSON.stringify(reply), before);
});

test('nested calls with the same starting offset have independent fold identities', () => {
    const source = 'f(1)(2)', n = fixture(source);
    const inner = n('call', 'f(1)', { target: n('ident', 'f'), argument: [n('int', '1')] }, 0,
        { callable: { inputs: [{ type: 'number^' }], outputs: ['number^'] } });
    const outer = n('call', source, { target: inner, argument: [n('int', '2')] }, 0,
        { callable: { inputs: [{ type: 'number^' }], outputs: ['number^'] } });
    const reply = { source, root: outer };
    const calls = flatten(toElk(reply)).filter(node => node.lhat?.invocation);
    assert.equal(calls.length, 2);
    const keys = calls.map(node => node.lhat.foldKey);
    assert.equal(new Set(keys).size, 2);
    for (const key of keys) {
        const folded = flatten(toElk(reply, { folds: { [key]: true } }));
        assert(folded.some(node => node.lhat?.foldKey === key && node.lhat.collapsed));
        if (key === `call:${inner.start}:${inner.end}`) assert(folded.some(node => node.lhat?.invocation && node.lhat.foldKey !== key));
    }
});

test('all reassignment spellings align positional pairs vertically and retain only written RHS values', async () => {
    for (const base of Object.keys(ASSIGNMENT_LABELS)) for (const guarded of [false, true]) for (const lowered of [false, true]) {
        const operator = (guarded ? '?' : '') + base, reply = assignment(operator, { lowered, comments: true });
        const before = JSON.stringify(reply);
        assert.equal(assignmentOperator(reply.root, reply.source).text, operator);
        assert.deepEqual(assignmentValues(reply.root, reply.source).map(n => reply.source.slice(n.start, n.end)), ['1', '2']);
        const values = commaLists(reply).find(list => list.node === reply.root && list.field === 'values');
        assert.deepEqual(values.items.map(n => reply.source.slice(n.start, n.end)), ['1', '2']);
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply)), 5000);
        const all = flatten(graph), group = all.find(n => n.lhat?.kind === 'reassign-row');
        assert(group && group.lhat.bindingGroup && group.lhat.foldable);
        assert.equal(group.layoutOptions['elk.direction'], 'DOWN');
        assert.equal(group.children.length, 2);
        assert(group.children[1].y > group.children[0].y + group.children[0].height);
        group.children.forEach((pair, i) => {
            const [target, value] = pair.children;
            assert.equal(target.labels[0].text, ['a', 'b'][i]);
            assert.equal(value.lhat.literal.value, ['1', '2'][i]);
            assert(target.x + target.width < value.x);
            assert.equal(target.y + target.lhat.definitionHandleY, value.y + value.lhat.definitionHandleY);
            assert(pair.edges.some(edge => edge.drawn && edge.definition && edge.sources[0] === `${value.id}__definition-out` && edge.targets[0] === `${target.id}__definition-in`));
        });
        assert(!group.edges.some(edge => edge.drawn), 'pairs are not separate sequential execution steps');
        assert(!all.some(n => n.lhat?.invocation), 'synthetic compound-operation trees are not displayed');
        assert.equal(JSON.stringify(reply), before);
    }
});

test('compound RHS expressions remain intact without duplicating indexed write targets', async () => {
    const source = 'items[next()] += amount + 1', n = fixture(source);
    const target = n('index', 'items[next()]', { target: n('ident', 'items'), argument: [
        n('call', 'next()', { target: n('ident', 'next'), argument: [] }),
    ] });
    const right = n('binary', 'amount + 1', { left: n('ident', 'amount'), right: n('int', '1') }, 0, { inferredType: 'number^' });
    for (const lowered of [false, true]) {
        const value = lowered ? n('binary', source, { left: target, right }) : right;
        const root = n('reassign', source, { targets: [target], values: [value] });
        const reply = { source, root }, before = JSON.stringify(reply);
        assert.equal(assignmentValues(root, source)[0], right);
        const graph = stackWideDefinitions(await new ELK().layout(toElk(reply)), 5000), all = flatten(graph);
        const targets = all.filter(node => node.lhat?.kind === 'index' && node.lhat?.definitionRole === 'declaration');
        assert.equal(targets.length, 1);
        assert.equal(targets[0].labels[0].text, 'items[next()]');
        assert.equal(all.filter(node => node.lhat?.invocation).length, 0, 'the written RHS addition is an inline expression');
        assert.equal(all.filter(node => node.lhat?.operatorExpression).length, 1);
        assert.equal(all.find(node => node.lhat?.operator).lhat.operator.text, '+');
        assert.equal(JSON.stringify(reply), before);
    }
});

test('plain reassignments share multi-result calls, whereas compound assignments do not unpack arity mismatches', () => {
    for (const operator of [':=', '?:=', '+=', '?+=']) {
        const source = `a, b ${operator} pair()`, n = fixture(source);
        const call = n('call', 'pair()', { target: n('ident', 'pair'), argument: [] }, 0,
            { callable: { inputs: [], outputs: ['number^', 'string^'] } });
        const root = n('reassign', source, { targets: [n('ident', 'a'), n('ident', 'b')], values: [call] });
        const all = flatten(toElk({ source, root }));
        assert.equal(all.filter(node => node.lhat?.invocation).length, 1);
        if (operator.endsWith(':=')) {
            const row = all.find(node => node.lhat?.kind === 'binding-outputs');
            assert.equal(row.lhat.definitionLinks.length, 2);
            assert.equal(new Set(row.lhat.definitionLinks.map(link => link.source)).size, 2);
        } else {
            assert(!all.some(node => node.lhat?.kind === 'binding-outputs'));
            assert(all.some(node => node.lhat?.kind === 'missing-input'));
        }
    }
});
