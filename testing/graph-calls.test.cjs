const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { listInsertions, insertListEdit, listTemplates, groupedOperatorSites, replaceOperatorEdit, operatorGroup, operatorSites } = load('graphLists.ts');
const { callInfo } = load('graphCalls.ts');
const { toElk, stackWideDefinitions } = load('webview/map.ts');
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
    assert.equal(flatten(graph).filter(node => node.lhat?.kind === 'input-slot').length, 3);
    assert(flatten(graph).filter(node => node.lhat?.kind === 'input-slot').every(node => node.lhat.labelParts[0].text === ''));
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

test('a single comparison uses callable slots; comparison chains keep their distinct operators', () => {
    const source = 'a < b', n = fixture(source);
    const root = n('compare-chain', source, { operands: [n('ident', 'a'), n('ident', 'b')] }, 0, { inferredType: 'bool^' });
    const graph = toElk({ source, root });
    assert.equal(flatten(graph).filter(node => node.lhat?.kind === 'input-slot').length, 2);
    assert.equal(flatten(graph).filter(node => node.lhat?.kind === 'output-slot').length, 1);
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
        assert.equal(input.children[0].children[0].lhat.labelParts[0].typeLabel, 'Text');
        assert.equal(input.children[0].children[1].lhat.literalTypeLabel, 'Number');
        const row = all.find(node => node.lhat?.definitionLinks);
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
