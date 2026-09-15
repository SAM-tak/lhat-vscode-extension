const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');

const mappingPath = path.resolve(__dirname, '../src/webview/map.ts');
const mapping = new Module(mappingPath);
mapping._compile(buildSync({
    entryPoints: [mappingPath], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text, mapping.id);
const { toElk, graphViewportX } = mapping.exports;
// Exercise the renderer's actual endpoint resolution as well as the mapping.
const renderer = fs.readFileSync(path.resolve(__dirname, '../src/webview/rf/main.tsx'), 'utf8').replace(/\r\n/g, '\n');
const first = renderer.indexOf('type Slides =');
const last = renderer.indexOf('/**\n * 8.6: inertia.');
assert(first >= 0 && last > first);
const toFlow = vm.runInNewContext(`const MarkerType={ArrowClosed:'arrowclosed'};
    ${transformSync(renderer.slice(first, last), { loader: 'tsx' }).code}; toFlow`, { graphViewportX });
const noop = () => {};
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
const starts = graph => flatten(graph).filter(n => n.lhat?.synthetic === 'start');
const draw = async (reply, options = {}) => {
    const graph = await new ELK().layout(toElk(reply, options));
    return { graph, flow: toFlow(graph, {}, 947, undefined, noop, noop, noop, noop, { current: null }, noop) };
};
const labelsOfEdges = flow => {
    const labels = new Map(flow.nodes.map(n => [n.id, n.data.isStart ? '<start>' : n.data.label]));
    return Array.from(flow.exec, e => `${labels.get(e.source)} -> ${labels.get(e.target)}`);
};

function nodesFor(source) {
    return (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        assert(start >= 0, `missing fixture: ${text}`);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
}

test('an empty file is one source-free start pictogram at every font scale', async () => {
    for (const source of ['', '# only a comment\n']) {
        const root = { kind: 'block', start: 0, end: source.length, line: 1, column: 1 };
        for (const scale of [1, 1.5, 2]) {
            const { graph, flow } = await draw({ source, root }, { scale });
            assert.equal(graph.children.length, 1);
            assert.equal(starts(graph).length, 1);
            assert.equal(graph.children[0].width, 24 * scale);
            assert.equal(graph.children[0].height, 24 * scale);
            assert.equal(flow.nodes.length, 1, 'no placeholder block node');
            const start = flow.nodes[0];
            assert(start.data.isStart);
            assert.equal(start.data.label, '');
            assert.equal(start.data.start, undefined, 'no fabricated source location');
            assert.equal(start.data.end, undefined);
            assert.equal(start.data.foldable, false);
            assert.equal(start.data.collapsed, false);
            assert.equal(flow.exec.length, 0);
        }
    }
});

test('the first top-level statement always has an incoming line; disabled statements are skipped', async () => {
    const source = '#[~ skipped() ]#\nlet^ x = 1\n#[~ ignored() ]#\nlast()';
    const n = nodesFor(source);
    const root = n('block', source, { items: [
        n('disabled', '#[~ skipped() ]#', { items: [n('call-stmt', 'skipped()')] }),
        n('define', 'let^ x = 1', { targets: [n('ident', 'x')], values: [n('int', '1')] }),
        n('disabled', '#[~ ignored() ]#', { items: [n('call-stmt', 'ignored()')] }),
        n('call-stmt', 'last()'),
    ] });
    const { graph, flow } = await draw({ source, root });
    assert.equal(starts(graph).length, 1);
    assert.deepEqual(labelsOfEdges(flow), ['<start> -> let^ x', 'let^ x -> last()']);
    for (const edge of flow.exec) {
        assert.equal(edge.sourceHandle, 'flow-out');
        assert.equal(edge.targetHandle, 'flow-in');
        assert.equal(edge.zIndex, 2000, 'execution lines are above nested container backgrounds');
    }
    assert.equal(flow.definitions.length, 1);
    const only = n('block', 'last()', { items: [n('call-stmt', 'last()')] });
    assert.deepEqual(labelsOfEdges((await draw({ source, root: only })).flow), ['<start> -> last()']);
});

test('functions and procedures have independent starts, including empty bodies and drill-down', async () => {
    const source = 'let^ f = f^{ one()\ntwo() }\nlet^ p = p^{}';
    const n = nodesFor(source);
    const fn = n('func', 'f^{ one()\ntwo() }', { body: n('block', '{ one()\ntwo() }', {
        items: [n('call-stmt', 'one()'), n('call-stmt', 'two()')],
    }) });
    const proc = n('func', 'p^{}', { body: n('block', '{}') });
    const root = n('block', source, { items: [
        n('define', 'let^ f = f^{ one()\ntwo() }', { targets: [n('ident', 'f')], values: [fn] }),
        n('define', 'let^ p = p^{}', { targets: [n('ident', 'p', undefined, source.indexOf('let^ p'))], values: [proc] }),
    ] });
    const reply = { source, root };
    const open = await draw(reply);
    assert.equal(starts(open.graph).length, 3, 'file plus both callables');
    const functions = flatten(open.graph).filter(n => n.lhat?.kind === 'func');
    assert.deepEqual(functions[0].children.map(n => n.lhat.kind), ['start', 'call-stmt', 'call-stmt']);
    assert.deepEqual(functions[1].children.map(n => n.lhat.kind), ['start']);
    assert(functions.every(n => n.layoutOptions['elk.direction'] === 'DOWN'));
    assert(functions.every(n => n.lhat.executionEntry === undefined), 'callable bodies remain independent chains');
    assert.deepEqual(labelsOfEdges(open.flow).sort(), [
        '<start> -> let^ f', 'let^ f -> let^ p', '<start> -> one()', 'one() -> two()',
    ].sort());
    assert.equal(starts((await draw(reply, { collapse: true })).graph).length, 1, 'folded contents are hidden');
    const drilled = await draw(reply, { root: fn, collapse: true, folds: { [fn.start]: true } });
    assert.equal(starts(drilled.graph).length, 1);
    assert.equal(drilled.graph.children[0].lhat.synthetic, 'start', 'drill-down has no extra body container');
    assert.deepEqual(labelsOfEdges(drilled.flow), ['<start> -> one()', 'one() -> two()']);
    const empty = await draw(reply, { root: proc, collapse: true });
    assert.equal(starts(empty.graph).length, 1);
    assert.equal(empty.flow.exec.length, 0);
    assert(empty.flow.nodes.some(n => n.data.isStart));
    assert.equal(empty.flow.nodes.length, 1, 'empty callable drill-down is just its start');
});

test('only the immediate callable body is hoisted; nested blocks, statements and inner functions survive', async () => {
    const source = 'p^{ before()\ndo^{ nested() }\nlet^ inner = f^{ value() }\nafter() }';
    const n = nodesFor(source);
    const nestedFunction = n('func', 'f^{ value() }', { body: n('block', '{ value() }', {
        items: [n('call-stmt', 'value()')],
    }) });
    const nestedBlock = n('block', 'do^{ nested() }', { items: [n('call-stmt', 'nested()')] });
    const body = n('block', source.slice(source.indexOf('{')), { items: [
        n('call-stmt', 'before()'), nestedBlock,
        n('define', 'let^ inner = f^{ value() }', { targets: [n('ident', 'inner')], values: [nestedFunction] }),
        n('call-stmt', 'after()'),
    ] });
    const root = n('func', source, { body });
    const { graph, flow } = await draw({ source, root });
    assert.deepEqual(graph.children.map(n => n.lhat.kind), ['start', 'call-stmt', 'block', 'define-row', 'call-stmt']);
    assert.equal(graph.children[2].lhat.start, nestedBlock.start);
    const inner = flatten(graph).find(n => n.lhat?.kind === 'func' && n.lhat.start === nestedFunction.start);
    assert.deepEqual(inner.children.map(n => n.lhat.kind), ['start', 'call-stmt']);
    assert.deepEqual(labelsOfEdges(flow).sort(), [
        '<start> -> before()', 'before() -> nested()', 'nested() -> let^ inner',
        'let^ inner -> after()', '<start> -> value()',
    ].sort());
    const folded = await draw({ source, root }, { root, collapse: true });
    assert.equal(starts(folded.graph).length, 1, 'the inner function still folds independently');
    assert(folded.flow.nodes.some(n => n.data.collapsed));
});

test('every supported list ends with one source-free add marker, even when empty', async () => {
    for (const [kind, text, name] of [
        ['table', '{}'], ['self-table', 'self^{}'], ['def', 'def^{}'],
        ['errordef', 'errordef^Empty {}', 'Empty'], ['enumdef', 'enum^Empty {}', 'Empty'],
    ]) {
        const n = nodesFor(text);
        const root = n(kind, text, name ? { name: n('ident', name) } : undefined);
        for (const scale of [1, 2]) {
            const { graph, flow } = await draw({ source: text, root }, { scale });
            assert.equal(graph.children.length, 1, `${kind}: empty list contains its insertion point`);
            const add = graph.children[0];
            assert.equal(add.lhat.synthetic, 'add');
            assert.equal(add.width, 24 * scale);
            assert.equal(add.height, 24 * scale);
            assert.equal(starts(graph).length, 0);
            assert.equal(flow.exec.length, 0);
            assert.equal(flow.definitions.length, 0);
            const control = flow.nodes[0];
            assert(control.data.isAdd);
            assert.equal(control.data.isStart, false);
            assert.equal(control.data.label, '');
            assert.equal(control.data.start, undefined);
            assert.equal(control.data.end, undefined);
            assert.equal(control.data.foldable, false);
        }
    }
});

test('nonempty list footers follow all members and wrapping rows, and hide with folded contents', async () => {
    for (const [kind, text] of [
        ['table', '{ 1, 2, 3 }'], ['self-table', 'self^{ a = 1, b = 2 }'],
        ['def', 'def^{ a = 1, b = 2 }'], ['enumdef', 'enum^Mode { A, B }'],
        ['errordef', 'errordef^Problem { Missing, Invalid }'],
    ]) {
        const source = `let^ value = ${text}`;
        const n = nodesFor(source);
        let fields;
        if (kind === 'table') fields = { items: ['1', '2', '3'].map(value => n('table-entry', value, { value: n('int', value) })) };
        else if (kind === 'self-table' || kind === 'def') fields = { items: [
            n('table-entry', 'a = 1', { key: n('ident', 'a'), value: n('int', '1') }),
            n('table-entry', 'b = 2', { key: n('ident', 'b'), value: n('int', '2') }),
        ] };
        else fields = {
            name: n('ident', kind === 'enumdef' ? 'Mode' : 'Problem'),
            members: (kind === 'enumdef' ? ['A', 'B'] : ['Missing', 'Invalid']).map(name =>
                n(kind === 'enumdef' ? 'enum-member' : 'error-kind', name, { name: n('ident', name) })),
        };
        const definition = n(kind, text, fields);
        const root = n('block', source, { items: [n('define', source, {
            targets: [n('ident', 'value')], values: [definition],
        })] });
        const reply = { source, root };
        for (const width of [160, 800]) {
            const { graph, flow } = await draw(reply, { root: definition, width, collapse: true });
            const add = graph.children.at(-1);
            assert.equal(add.lhat.synthetic, 'add');
            assert.equal(graph.children.filter(n => n.lhat?.synthetic === 'add').length, 1);
            assert.equal(starts(graph).length, 0);
            for (const member of graph.children.slice(0, -1)) assert(add.y >= member.y + member.height);
            assert(!flow.exec.some(e => e.source === add.id || e.target === add.id));
            assert(!flow.definitions.some(e => e.source === add.id || e.target === add.id));
        }
        if (kind !== 'table') {
            const { flow } = await draw(reply, { collapse: true });
            assert(flow.nodes.some(n => n.data.collapsed));
            assert(!flow.nodes.some(n => n.data.isAdd), 'folded list hides its insertion control');
        }
    }
});

test('branch-free enclosing expressions do not hide nested or empty list insertion points', async () => {
    const source = 'return^ { {}, { 1 } }';
    const n = nodesFor(source);
    const empty = n('table', '{}');
    const one = n('table', '{ 1 }', { items: [n('table-entry', '1', { value: n('int', '1') })] });
    const table = n('table', '{ {}, { 1 } }', { items: [
        n('table-entry', '{}', { value: empty }), n('table-entry', '{ 1 }', { value: one }),
    ] });
    const root = n('return', source, { value: [table] });
    const { flow } = await draw({ source, root });
    assert.equal(flow.nodes.filter(n => n.data.isAdd).length, 3);
    assert.equal(flow.exec.length, 0, 'list affordances do not introduce an execution chain');
});

test('execution crosses with and nested block boundaries at their actual first and last statements', async () => {
    const source = 'before()\nwith^log = open() { inside()\ndo^{ nested() }\nafter() }\nlast()';
    const n = nodesFor(source);
    const body = n('block', '{ inside()\ndo^{ nested() }\nafter() }', { items: [
        n('call-stmt', 'inside()'),
        n('block', 'do^{ nested() }', { items: [n('call-stmt', 'nested()')] }),
        n('call-stmt', 'after()'),
    ] });
    const withNode = n('with', 'with^log = open() { inside()\ndo^{ nested() }\nafter() }', {
        items: [n('define', 'with^log = open()', { targets: [n('ident', 'log')], values: [n('call', 'open()')] })],
        extra: [body],
    });
    const root = n('block', source, { items: [n('call-stmt', 'before()'), withNode, n('call-stmt', 'last()')] });
    const { graph, flow } = await draw({ source, root });
    assert.equal(starts(graph).length, 1, 'inline scopes continue the same chain');
    assert.deepEqual(labelsOfEdges(flow).sort(), [
        '<start> -> before()', 'before() -> with^log', 'with^log -> inside()',
        'inside() -> nested()', 'nested() -> after()', 'after() -> last()',
    ].sort());
    const byId = new Map(flow.nodes.map(n => [n.id, n]));
    assert(flow.exec.every(e => !byId.get(e.source).data.layoutOnly && !byId.get(e.target).data.layoutOnly));
});

test('member lists have no execution start, and disabled nested code has no active execution edges', async () => {
    const source = 'enum^Mode { A, B = 1 }\n#[~ p^{ one()\ntwo() } ]#';
    const n = nodesFor(source);
    const enumeration = n('enumdef', 'enum^Mode { A, B = 1 }', { name: n('ident', 'Mode'), members: [
        n('enum-member', 'A', { name: n('ident', 'A') }),
        n('enum-member', 'B = 1', { name: n('ident', 'B'), members: [n('int', '1')] }),
    ] });
    const disabled = n('disabled', '#[~ p^{ one()\ntwo() } ]#', { items: [
        n('func', 'p^{ one()\ntwo() }', { body: n('block', '{ one()\ntwo() }', {
            items: [n('call-stmt', 'one()'), n('call-stmt', 'two()')],
        }) }),
    ] });
    const root = n('block', source, { items: [enumeration, disabled] });
    const entered = await draw({ source, root }, { root: enumeration });
    assert.equal(starts(entered.graph).length, 0);
    assert.equal(entered.flow.exec.length, 0);
    assert.equal(entered.flow.definitions.length, 1);
    const file = await draw({ source, root });
    assert.deepEqual(labelsOfEdges(file.flow), ['<start> -> enum^Mode']);
});
