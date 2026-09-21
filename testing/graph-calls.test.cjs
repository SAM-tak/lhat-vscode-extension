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
        const [output, argumentsColumn] = columns.children;
        const [input, ...argumentRows] = argumentsColumn.children;
        assert.equal(output.lhat.ioGroup, 'output'); assert.equal(input.lhat.ioGroup, 'input');
        assert(output.x + output.width < argumentsColumn.x + input.x); assert.equal(output.y, argumentsColumn.y + input.y);
        assert.equal(input.children[0].x, input.children[1].x);
        assert.equal(input.children[0].lhat.labelParts[0].typeLabel, 'Text');
        assert(input.children.every(node => node.lhat.kind === 'input-slot'));
        assert.equal(argumentRows[0].children[0].lhat.literalTypeLabel, 'Number');
        for (const row of argumentRows) assert(row.x + row.children[0].x > input.x + input.width, 'argument value is outside the input frame');
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

test('nested call and operator values stay outside input frames, aligned to their own inputs', async () => {
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
        assert.equal(all.filter(node => node.lhat?.invocation).length, 3);
        assert(!all.some(node => node.lhat?.ioGroup === 'output'));
        for (const column of all.filter(node => node.lhat?.kind === 'call-inputs')) {
            const [frame, ...rows] = column.children, f = points.get(frame.id);
            assert.equal(frame.lhat.ioGroup, 'input');
            assert(frame.children.every(node => node.lhat.kind === 'input-slot'));
            for (const [i, row] of rows.entries()) {
                const input = frame.children[i], value = row.children[0];
                const p = points.get(input.id), v = points.get(value.id);
                assert(p.x >= f.x && p.x + input.width <= f.x + frame.width, 'input stays inside its frame');
                assert(v.x > f.x + frame.width, 'the entire value stays outside the input frame');
                const output = value.lhat.definitionOutputs?.[0] ?? value.id;
                assert.equal(p.handleY, points.get(output).handleY, 'definition line joins matching slot heights');
                assert(p.y >= f.y && p.y + input.height <= f.y + frame.height);
                assert.equal(row.edges[0].targets[0], `${input.id}__definition-in`, 'reparenting retains the edge endpoint');
                if (i + 1 < rows.length) assert(row.y + row.height < rows[i + 1].y, 'tall nested values clear the next row');
            }
        }
    }
    assert.equal(JSON.stringify(tree), before, 'layout never changes the source tree');
});
