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
const { toElk, graphViewportX, stackWideDefinitions } = mapping.exports;
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
const statementsOf = clause => clause.children.filter(n => !n.lhat?.condition);
const conditionOf = clause => clause.children.find(n => n.lhat?.condition);
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
    assert(entered.flow.nodes.filter(n => !n.data.isAdd && !n.data.layoutOnly).every(n => n.data.noExecutionHandles));
    const file = await draw({ source, root });
    assert.deepEqual(labelsOfEdges(file.flow), ['<start> -> enum^Mode']);
});

test('table wrapping rows are invisible layout parents, not boxes or interaction targets', async () => {
    const values = ['10', '12', '15', '18', '20', '24', '30', '36', '40', '48', '60', '72', '90', '120', '150', '180'];
    const tableText = `{ ${values.join(', ')} }`;
    const source = `let^prices = ${tableText}`;
    const n = nodesFor(source);
    const table = n('table', tableText, { items: values.map(v =>
        n('table-entry', v, { value: n('int', v) })) });
    const root = n('block', source, { items: [n('define', source, {
        targets: [n('ident', 'prices')], values: [table],
    })] });
    for (const width of [300, 900]) {
        for (const scale of [1, 1.5]) {
            const { graph, flow } = await draw({ source, root }, { width, scale, collapse: false });
            const mapped = flatten(graph).find(c => c.lhat?.kind === 'table');
            const rows = mapped.children.filter(c => c.lhat === undefined);
            assert(rows.length > 1, 'fixture wraps into multiple rows');
            assert.deepEqual(rows.flatMap(row => row.children.map(c => c.lhat.literal.value)), values);
            for (const row of rows) {
                const node = flow.nodes.find(c => c.id === row.id);
                assert(node.data.layoutOnly);
                assert.equal(node.selectable, false);
                assert.equal(node.focusable, false);
                assert.equal(node.data.branchOffset, undefined);
                assert.equal(node.data.definitionBranchOffset, undefined);
                assert.equal(node.data.start, undefined);
                assert(!flow.exec.concat(flow.definitions).some(e => e.source === row.id || e.target === row.id));
                assert(row.children.every(c => flow.nodes.find(n => n.id === c.id).parentId === row.id));
            }
            assert(!flow.nodes.find(c => c.id === mapped.id).data.layoutOnly, 'table outer box stays visible');
            assert.equal(flow.definitions.length, 1, 'table still defines prices');
            assert(flow.nodes.some(c => c.data.isAdd && c.parentId === mapped.id));
            assert(flow.nodes.filter(c => c.data.literal).every(c => !c.data.layoutOnly));
            const footer = mapped.children.at(-1);
            assert(rows.every(row => footer.y >= row.y + row.height));
        }
    }
});

test('list member rows hide execution handles without hiding definitions or callable body handles', async () => {
    for (const [kind, head] of [['table', ''], ['def', 'def^'], ['self-table', 'self^']]) {
        const source = head + '{ count = 42, run = p^{ return^9 } }';
        const n = nodesFor(source);
        const fn = n('func', 'p^{ return^9 }', { body: n('block', '{ return^9 }', {
            items: [n('return', 'return^9', { value: n('int', '9') })],
        }) });
        const root = n(kind, source, { members: [
            n('table-entry', 'count = 42', { key: n('ident', 'count'), value: n('int', '42') }),
            n('table-entry', 'run = p^{ return^9 }', { key: n('ident', 'run'), value: fn }),
        ] });
        const { flow } = await draw({ source, root }, { collapse: false });
        const outside = flow.nodes.filter(n => !n.data.isAdd && n.data.start < fn.start);
        assert(outside.length > 0);
        assert(outside.every(n => n.data.noExecutionHandles), kind);
        assert(flow.nodes.find(n => n.data.start === fn.start && n.data.isContainer).data.noExecutionHandles);
        assert(flow.nodes.some(n => n.data.isStart && !n.data.noExecutionHandles));
        assert(flow.nodes.some(n => n.data.isReturn && !n.data.noExecutionHandles));
        assert.equal(flow.definitions.length, 3, 'count, run and returned value retain their definition handles');
        assert.equal(flow.exec.length, 1, 'callable body start still reaches its return');
    }
});

test('active scroll owners cover outer execution lines but retain internal lines and disabled-code bypasses', async () => {
    // Use React Flow's actual parent/selection/edge elevation rules, not just
    // the requested z-index: the library adds endpoint layers to each edge.
    const { adoptUserNodes, getElevatedEdgeZIndex } = await import('@xyflow/system');
    const box = (id, kind, x, y, width = 80, height = 30, extra = {}) => ({
        id, x, y, width, height, lhat: { kind, start: y, end: y + 1, ...extra },
    });
    const line = (id, source, target) => ({ id, sources: [source], targets: [target], drawn: true });
    const disabled = box('disabled', 'disabled', 80, 50, 1600, 150, { disabled: true });
    const disabledChild = box('disabled-child', 'func', 10, 30, 1580, 100, { disabled: true });
    disabled.children = [disabledChild];
    disabledChild.children = [box('disabled-leaf', 'call-stmt', 10, 30, 100, 30, { disabled: true })];
    const row = box('row', 'define-row', 80, 220, 1710, 240, {
        definitionRole: 'row', stackedDefinition: true,
    });
    const value = box('value', 'func', 108, 30, 1600, 200, { definitionRole: 'value' });
    const body = box('body', 'block', 10, 34, 1580, 150);
    body.children = [box('first', 'start', 300, 20), box('last', 'call-stmt', 300, 90)];
    body.edges = [line('inside', 'first', 'last')];
    value.children = [body];
    row.children = [box('declaration', 'define', 0, 0, 80, 30, { definitionRole: 'declaration' }), value];
    row.edges = [{ ...line('definition', 'value', 'declaration'), definition: true }];
    const graph = { id: 'root', width: 1790, height: 550,
        children: [box('before', 'start', 80, 0), disabled, row, box('after', 'define', 80, 500)],
        edges: [line('skip', 'before', 'declaration'), line('outside', 'declaration', 'after')],
    };
    for (const dx of [0, -100, -10000]) {
        const flow = toFlow(graph, { 'func:30:31': { dx, dy: 0 } }, 947, undefined,
            noop, noop, noop, noop, { current: null }, noop);
        const owner = flow.nodes.find(n => n.id === 'value');
        assert(owner.data.slideOwner);
        assert(flow.nodes.find(n => n.id === 'disabled').data.slideOwner);
        assert.equal(flow.nodes.find(n => n.id === 'body').zIndex, undefined, 'no independent nested lift');
        for (const selected of [undefined, 'declaration', 'value', 'body', 'first', 'disabled', 'disabled-child']) {
            const lookup = new Map();
            adoptUserNodes(flow.nodes.map(n => ({ ...n, selected: n.id === selected })), lookup, new Map());
            const z = id => lookup.get(id).internals.z;
            const edgeZ = edge => getElevatedEdgeZIndex({
                sourceNode: lookup.get(edge.source), targetNode: lookup.get(edge.target), zIndex: edge.zIndex,
            });
            const outside = flow.exec.find(e => e.id === 'x__outside');
            const skip = flow.exec.find(e => e.id === 'x__skip');
            const inside = flow.exec.find(e => e.id === 'x__inside');
            assert(z('value') > edgeZ(outside), 'active value covers the outer line, even after selection');
            assert(edgeZ(inside) > z('body'), 'internal execution remains above every enclosing background');
            assert(edgeZ(flow.definitions[0]) > z('value'), 'definition arrow stays visible');
            for (const id of ['disabled', 'disabled-child', 'disabled-leaf']) {
                assert(edgeZ(skip) > z(id), 'disabled boxes remain behind the bypassing line');
            }
            if (dx === -100) {
                const x = lookup.get('value').internals.positionAbsolute.x;
                const axis = lookup.get('declaration').internals.positionAbsolute.x + 40;
                assert(x < axis && axis < x + owner.width, 'scrolled value really crosses the outer line');
            }
        }
    }
});

test('explicit returns are source-backed pictograms with definition lines from their values', async () => {
    const source = 'before()\nreturn^ 42';
    const n = nodesFor(source);
    const ret = n('return', 'return^ 42', { value: [n('int', '42')] });
    const root = n('block', source, { items: [n('call-stmt', 'before()'), ret] });
    for (const scale of [1, 1.5, 2]) {
        const { graph, flow } = await draw({ source, root }, { scale });
        const marker = flow.nodes.find(n => n.data.isReturn);
        assert(marker);
        assert.equal(marker.width, Math.round(24 * scale));
        assert.equal(marker.height, marker.width);
        assert.equal(marker.data.label, '');
        assert.equal(marker.data.isStart, false);
        assert.equal(source.slice(marker.data.start, marker.data.end), 'return^');
        assert.equal(marker.data.foldable, false);
        assert.equal(flow.definitions.length, 1);
        const definition = flow.definitions[0];
        assert.equal(definition.target, marker.id);
        assert.equal(definition.targetHandle, 'definition-in');
        assert.equal(definition.sourceHandle, 'definition-out');
        assert.equal(flow.nodes.find(n => n.id === definition.source).data.label, '42');
        assert(flow.exec.some(e => e.target === marker.id), 'execution reaches the marker, not the expression');
        assert(!flow.exec.some(e => e.target === definition.source));
        const row = flatten(graph).find(n => n.lhat?.kind === 'return-row');
        assert.equal(row.lhat.executionNode, marker.id);
        for (const child of row.children) {
            assert.equal(child.lhat.definitionHandleY, marker.height / 2);
            assert.equal(child.ports[0].y, marker.height / 2);
        }
    }
    const bare = await draw({ source: 'return^', root: nodesFor('return^')('return', 'return^') });
    assert.equal(bare.flow.nodes.length, 1);
    assert(bare.flow.nodes[0].data.isReturn);
    assert.equal(bare.flow.definitions.length, 0, 'no placeholder expression or line for a bare return');
});

test('return pictograms survive simple branch clauses, disabled code and implicit returns', async () => {
    const source = 'if^ ready { return^ 1 el^: return^ }\n#[~ return^ 2 ]#';
    const n = nodesFor(source);
    const branch = n('if-stmt', 'if^ ready { return^ 1 el^: return^ }', { items: [
        n('if-clause', 'ready { return^ 1', { condition: n('ident', 'ready'), body: n('return', 'return^ 1', { value: [n('int', '1')] }) }),
        n('if-clause', 'el^: return^', { body: n('return', 'return^', undefined, source.indexOf('el^:')) }),
    ] });
    const root = n('block', source, { items: [branch, n('disabled', '#[~ return^ 2 ]#', {
        items: [n('return', 'return^ 2', { value: [n('int', '2')] })],
    })] });
    const { flow } = await draw({ source, root });
    const markers = flow.nodes.filter(n => n.data.isReturn);
    assert.equal(markers.length, 3, 'clauses must not compact their return into a text label');
    assert.equal(markers.filter(n => n.data.disabled).length, 1);
    assert(!flow.exec.some(e => markers.find(n => n.data.disabled)?.id === e.target));
    const implicitSource = 'f^{ computeResult() }', i = nodesFor(implicitSource);
    const implicit = i('func', implicitSource, { body: i('block', '{ computeResult() }', {
        items: [i('return', 'computeResult()', { value: [i('call', 'computeResult()')] })],
    }) });
    const tail = await draw({ source: implicitSource, root: implicit });
    const start = tail.flow.nodes.find(n => n.data.isStart);
    const marker = tail.flow.nodes.find(n => n.data.isReturn);
    const value = tail.flow.nodes.find(n => n.data.label === 'computeResult()');
    assert(start && marker && value);
    assert.equal(tail.flow.nodes.filter(n => n.data.isReturn).length, 1);
    assert.equal(marker.data.definitionRole, 'declaration');
    assert.equal(marker.data.foldable, false);
    assert.equal(implicitSource.slice(marker.data.start, marker.data.end), 'computeResult()', 'implicit return reveals the whole expression, not a fabricated keyword');
    assert.equal(tail.flow.definitions.length, 1);
    assert.equal(tail.flow.definitions[0].source, value.id);
    assert.equal(tail.flow.definitions[0].target, marker.id);
    assert.equal(tail.flow.exec.length, 1);
    assert.equal(tail.flow.exec[0].source, start.id);
    assert.equal(tail.flow.exec[0].target, marker.id);
    assert.equal(tail.graph.children[0].lhat.synthetic, 'start');
    assert.equal(tail.graph.children[1].lhat.kind, 'return-row');
    const folded = await draw({ source: implicitSource, root: implicit }, { collapse: true });
    assert(!folded.flow.nodes.some(n => n.data.isReturn), 'folded callable hides its contents together');
    const drilled = await draw({ source: implicitSource, root: implicit }, { root: implicit, collapse: true });
    assert.equal(drilled.flow.nodes.filter(n => n.data.isStart).length, 1);
    assert.equal(drilled.flow.nodes.filter(n => n.data.isReturn).length, 1, 'drilling restores both editing anchors');
});

test('implicit tuple returns retain their values and marker when partially scrolled', async () => {
    const values = Array.from({ length: 20 }, (_, i) => String(100 + i));
    const expression = `(${values.join(', ')})`, source = `f^{ ${expression} }`, n = nodesFor(source);
    const fn = n('func', source, { body: n('block', source.slice(source.indexOf('{')), {
        items: [n('return', expression, { value: values.map(v => n('int', v)) })],
    }) });
    for (const scale of [1, 2]) {
        const laid = await new ELK().layout(toElk({ source, root: fn }, { root: fn, width: 450, scale }));
        const stacked = stackWideDefinitions(laid, 434);
        const row = stacked.children.find(n => n.lhat?.kind === 'return-row');
        assert(row.lhat.stackedDefinition);
        const [marker, value] = row.children;
        assert.equal(value.y, marker.y + marker.height);
        assert.deepEqual(value.children.map(n => n.labels[0].text), values);
        const convert = slides => toFlow(stacked, slides, 450, undefined, noop, noop, noop, noop, { current: null }, noop);
        const flow = convert({}), owner = flow.nodes.find(n => n.data.slideOwner);
        const icon = flow.nodes.find(n => n.data.isReturn);
        assert.equal(owner.id, value.id);
        assert.equal(source.slice(icon.data.start, icon.data.end), expression);
        assert.equal(flow.nodes.filter(n => n.data.isStart).length, 1);
        assert(flow.exec.some(e => e.target === icon.id));
        const moved = convert({ [owner.data.slideKey]: { dx: -100, dy: 0 } });
        assert(moved.nodes.find(n => n.id === owner.id).position.x < owner.position.x);
        assert.deepEqual(moved.nodes.find(n => n.id === icon.id).position, icon.position);
        assert.equal(stackWideDefinitions(laid, 10000), laid, 'fitting expressions need no vertical offset');
    }
});

test('wide return values reuse the marker-height offset and outermost-only partial scrolling', async () => {
    const values = Array.from({ length: 20 }, (_, i) => String(100 + i));
    const source = `let^ f = f^{ return^ ${values.join(', ')} }`;
    const n = nodesFor(source);
    const ret = n('return', `return^ ${values.join(', ')}`, { value: values.map(v => n('int', v)) });
    const fn = n('func', source.slice(source.indexOf('f^{')), { body: n('block', source.slice(source.indexOf('{')), { items: [ret] }) });
    const root = n('block', source, { items: [n('define', source, { targets: [n('ident', 'f')], values: [fn] })] });
    const reply = { source, root };
    for (const scale of [1, 2]) {
        const laid = await new ELK().layout(toElk(reply, { root: fn, width: 450, scale }));
        const stacked = stackWideDefinitions(laid, 434);
        const row = stacked.children.find(n => n.lhat?.kind === 'return-row');
        const [marker, value] = row.children;
        assert(row.lhat.stackedDefinition);
        assert.equal(value.y, marker.y + marker.height);
        assert.deepEqual(value.children.map(n => n.labels[0].text), values, 'multiple values keep source order');
        assert.equal(stackWideDefinitions(laid, 10000), laid, 'fitting values return beside the marker');
        const convert = slides => toFlow(stacked, slides, 450, undefined, noop, noop, noop, noop, { current: null }, noop);
        const first = convert({}), owner = first.nodes.find(n => n.id === value.id);
        assert(owner.data.slideOwner);
        const shifted = convert({ [owner.data.slideKey]: { dx: -100, dy: 0 } });
        for (const node of shifted.nodes) {
            const before = first.nodes.find(n => n.id === node.id);
            if (node.id === value.id) assert(node.position.x < before.position.x);
            else assert.deepEqual(node.position, before.position, 'only the returned expression moves');
        }
        assert(first.exec.some(e => e.target === marker.id), 'callable start connects to the return marker');
    }
    const nested = stackWideDefinitions(await new ELK().layout(toElk(reply, { width: 450 })), 434);
    const nestedFlow = toFlow(nested, {}, 450, undefined, noop, noop, noop, noop, { current: null }, noop);
    assert.equal(nestedFlow.nodes.filter(n => n.data.slideOwner).length, 1);
    assert.equal(nestedFlow.nodes.find(n => n.data.slideOwner).data.start, fn.start, 'whole callable owns nested scrolling');
    assert(!flatten(nested).find(n => n.lhat?.kind === 'return-row').lhat.stackedDefinition);
    const folded = await draw(reply, { collapse: true });
    assert(!folded.flow.nodes.some(n => n.data.isReturn), 'return hides together with its folded callable');
});

test('if statements fan out through condition-only boxes to real entries and hoist only immediate bodies', async () => {
    const source = 'before()\nif^ ready { #[~ skipped() ]# let^ x = 1\nsecond() el^ other: do^{ nested() } el^: return^ 2 }\nafter()';
    const n = nodesFor(source);
    const disabled = n('disabled', '#[~ skipped() ]#', { items: [n('call-stmt', 'skipped()')] });
    const declaration = n('define', 'let^ x = 1', { targets: [n('ident', 'x')], values: [n('int', '1')] });
    const nested = n('block', 'do^{ nested() }', { items: [n('call-stmt', 'nested()')] });
    const ret = n('return', 'return^ 2', { value: [n('int', '2')] });
    const firstBody = n('block', '#[~ skipped() ]# let^ x = 1\nsecond()', { items: [disabled, declaration, n('call-stmt', 'second()')] });
    const secondBody = n('block', 'do^{ nested() }', { items: [nested] });
    const lastBody = n('block', 'return^ 2', { items: [ret] });
    const branch = n('if-stmt', source.slice(source.indexOf('if^'), source.indexOf('\nafter()')), { items: [
        n('if-clause', 'ready { #[~ skipped() ]# let^ x = 1\nsecond()', { condition: n('ident', 'ready'), body: firstBody }),
        n('if-clause', 'el^ other: do^{ nested() }', { condition: n('ident', 'other'), body: secondBody }),
        n('if-clause', 'el^: return^ 2', { body: lastBody }),
    ] });
    const root = n('block', source, { items: [n('call-stmt', 'before()'), branch, n('call-stmt', 'after()')] });
    for (const scale of [1, 2]) {
        const { graph, flow } = await draw({ source, root }, { scale });
        const mapped = flatten(graph).find(n => n.lhat?.kind === 'if-stmt');
        assert.deepEqual(mapped.children.map(n => conditionOf(n)?.labels[0].text), ['ready', 'other', undefined]);
        assert(mapped.children.every(n => n.labels[0].text === ''), 'conditions are not printed in the enclosing headers');
        for (const clause of mapped.children) {
            const predicate = conditionOf(clause);
            if (!predicate) continue;
            assert.equal(source.slice(predicate.lhat.start, predicate.lhat.end), predicate.labels[0].text, 'condition reveal selects only its expression');
            assert(!predicate.children, 'condition is an independent leaf');
            assert(!flow.exec.some(e => e.source === predicate.id || e.target === predicate.id), 'execution passes behind the condition, not into a new statement');
        }
        assert.deepEqual(statementsOf(mapped.children[0]).map(n => n.lhat.kind), ['disabled', 'define-row', 'call-stmt']);
        assert.equal(statementsOf(mapped.children[1])[0].lhat.start, nested.start, 'explicit nested block is retained');
        assert.equal(statementsOf(mapped.children[2])[0].lhat.kind, 'return-row', 'return is a direct child of its clause');
        assert.equal(starts(graph).length, 1, 'clauses do not introduce independent starts');
        assert(mapped.edges.every(e => !e.drawn), 'fan-out does not alter the ELK ordering constraints');
        const arms = flow.exec.filter(e => e.sourceHandle === 'flow-branch');
        const byId = new Map(flow.nodes.map(n => [n.id, n]));
        assert.equal(arms.length, 3);
        assert.deepEqual(Array.from(arms, e => byId.get(e.target).data.isReturn ? '<return>' : byId.get(e.target).data.label), ['let^ x', 'nested()', '<return>']);
        for (const edge of arms) {
            assert.equal(edge.source, mapped.id);
            assert.equal(edge.targetHandle, 'flow-in');
            assert.equal(edge.type, 'branch');
            assert.equal(edge.data.branchOffset, 18 * scale);
        }
        assert(flow.exec.some(e => byId.get(e.source).data.label === 'before()' && e.target === mapped.id));
        assert(flow.exec.some(e => e.source === mapped.id && byId.get(e.target).data.label === 'after()'));
        assert(flow.exec.some(e => byId.get(e.source).data.label === 'let^ x' && byId.get(e.target).data.label === 'second()'));
        assert(flow.exec.filter(e => e.sourceHandle !== 'flow-branch').every(e => e.type === 'smoothstep'), 'all ordinary execution lines use rounded orthogonal paths');
        assert(flow.exec.every(e => e.pathOptions.borderRadius === 6 && e.pathOptions.offset === 6));
    }
    const entered = await draw({ source, root }, { root: branch });
    const visible = new Set(entered.flow.nodes.map(n => n.id));
    assert(entered.flow.nodes.some(n => n.data.branchOffset !== undefined), 'IF root retains its top junction');
    assert(entered.flow.exec.every(e => visible.has(e.source) && visible.has(e.target)));
    const offRoot = { ...root, fields: { items: [{ ...branch, kind: 'disabled', fields: { items: [branch] } }] } };
    const off = await draw({ source, root: offRoot });
    assert.equal(off.flow.exec.length, 0, 'disabled IFs have no active branch lines');
});

test('nested ifs have separate junctions; empty and disabled-only clauses have no fabricated entry', async () => {
    const source = 'if^ outer { if^ inner { one() } el^ off: #[~ skip() ]# el^: }';
    const n = nodesFor(source);
    const inner = n('if-stmt', 'if^ inner { one() }', { items: [n('if-clause', 'inner { one()', {
        condition: n('ident', 'inner'), body: n('block', 'one()', { items: [n('call-stmt', 'one()')] }),
    })] });
    const root = n('if-stmt', source, { items: [
        n('if-clause', 'outer { if^ inner { one() }', { condition: n('ident', 'outer'), body: n('block', 'if^ inner { one() }', { items: [inner] }) }),
        n('if-clause', 'el^ off: #[~ skip() ]#', { condition: n('ident', 'off'), body: n('block', '#[~ skip() ]#', {
            items: [n('disabled', '#[~ skip() ]#', { items: [n('call-stmt', 'skip()')] })],
        }) }),
        n('if-clause', 'el^:', { body: { kind: 'block', start: source.length - 1, end: source.length - 1, line: 1, column: source.length } }),
    ] });
    const { graph, flow } = await draw({ source, root });
    const branches = flatten(graph).filter(n => n.lhat?.kind === 'if-stmt');
    const arms = flow.exec.filter(e => e.sourceHandle === 'flow-branch');
    assert.equal(arms.length, 2);
    assert(arms.some(e => e.source === branches[0].id && e.target === branches[1].id));
    assert(arms.some(e => e.source === branches[1].id && flow.nodes.find(n => n.id === e.target).data.label === 'one()'));
    const empty = branches[0].children.at(-1);
    assert.equal(empty.labels[0].text, '');
    assert(empty.width > 0 && empty.height > 0, 'empty else still has a visible box');
    assert.equal(empty.children.length, 0, 'no empty body placeholder');
});

test('if expressions remain expression branches without execution fan-out', async () => {
    const source = 'if^ ready: 1 el^: 2 ;', n = nodesFor(source);
    const root = n('if-expr', source, { items: [
        n('if-clause', 'if^ ready: 1', { condition: n('ident', 'ready'), body: n('int', '1') }),
        n('if-clause', 'el^: 2', { body: n('int', '2') }),
    ] });
    const { graph, flow } = await draw({ source, root });
    assert.equal(flow.exec.length, 0);
    assert(flatten(graph).every(n => n.lhat?.executionBranches === undefined));
    assert(flow.nodes.every(n => n.data.branchOffset === undefined));
});

test('pattern-match statements enter through their focus and an unboxed shared branch junction', async () => {
    const source = 'before()\nfor^ let^ subject = input { when^ 0: #[~ skip() ]# let^ result = 1\nuse(result) when^ 1 to^ 3, 5: return^ 2 when^ fits^ number^: do^{ nested() } other^: return^ 3 }\nafter()';
    const n = nodesFor(source);
    const focus = n('define', 'let^ subject = input', {
        targets: [n('ident', 'subject')], values: [n('ident', 'input')],
    });
    const arms = [
        n('if-clause', 'when^ 0: #[~ skip() ]# let^ result = 1\nuse(result)', {
            condition: n('binary', '0'), body: n('block', 'when^ 0: #[~ skip() ]# let^ result = 1\nuse(result)', { items: [
                n('disabled', '#[~ skip() ]#', { items: [n('call-stmt', 'skip()')] }),
                n('define', 'let^ result = 1', { targets: [n('ident', 'result')], values: [n('int', '1', undefined, source.indexOf('result ='))] }),
                n('call-stmt', 'use(result)'),
            ] }),
        }),
        n('if-clause', 'when^ 1 to^ 3, 5: return^ 2', {
            condition: n('binary', '1 to^ 3, 5'), body: n('block', 'when^ 1 to^ 3, 5: return^ 2', { items: [
                n('return', 'return^ 2', { value: [n('int', '2')] }),
            ] }),
        }),
        n('if-clause', 'when^ fits^ number^: do^{ nested() }', {
            condition: n('binary', 'fits^ number^'), body: n('block', 'when^ fits^ number^: do^{ nested() }', { items: [
                n('block', 'do^{ nested() }', { items: [n('call-stmt', 'nested()')] }),
            ] }),
        }),
        n('if-clause', 'other^: return^ 3', { body: n('block', 'other^: return^ 3', { items: [
            n('return', 'return^ 3', { value: [n('int', '3', undefined, source.indexOf('other^:'))] }),
        ] }) }),
    ];
    const body = n('if-stmt', source.slice(source.indexOf('{'), source.lastIndexOf(' }')), { items: arms });
    const match = n('for', source.slice(source.indexOf('for^'), source.indexOf('\nafter()')), { focus: [focus], body });
    const root = n('block', source, { items: [n('call-stmt', 'before()'), match, n('call-stmt', 'after()')] });
    for (const scale of [1, 2]) {
        const { graph, flow } = await draw({ source, root }, { scale });
        const boxes = flatten(graph);
        const outer = boxes.find(n => n.lhat?.kind === 'for');
        const junction = boxes.find(n => n.lhat?.kind === 'if-stmt');
        assert(junction.lhat.layoutOnly, 'the lowered IF is not another visible box');
        assert.equal(junction.labels[0].text, '');
        assert.equal(junction.layoutOptions['elk.direction'], 'RIGHT');
        assert.deepEqual(junction.children.map(n => conditionOf(n)?.labels[0].text), ['0', '1 to^ 3, 5', 'fits^ number^', undefined]);
        assert.deepEqual(statementsOf(junction.children[0]).map(n => n.lhat.kind), ['disabled', 'define-row', 'call-stmt']);
        assert.equal(statementsOf(junction.children[1])[0].lhat.kind, 'return-row');
        assert.equal(statementsOf(junction.children[2])[0].lhat.kind, 'block', 'explicit nested blocks survive');
        assert.equal(starts(graph).length, 1, 'a match does not create a new execution scope');
        const declaration = flow.nodes.find(n => n.data.label === 'let^ subject');
        const byId = new Map(flow.nodes.map(n => [n.id, n]));
        assert(flow.definitions.some(e => e.target === declaration.id && byId.get(e.source).data.label === 'input'));
        assert(flow.exec.some(e => e.source === outer.id && e.target === declaration.id && e.sourceHandle === 'flow-branch'));
        assert(flow.exec.some(e => e.source === declaration.id && e.target === junction.id));
        const branches = flow.exec.filter(e => e.source === junction.id);
        assert.equal(branches.length, 4);
        assert.deepEqual(Array.from(branches, e => byId.get(e.target).data.isReturn ? '<return>' : byId.get(e.target).data.label), ['let^ result', '<return>', 'nested()', '<return>']);
        assert(branches.every(e => e.sourceHandle === 'flow-branch' && e.data.branchOffset === 18 * scale));
        assert(flow.exec.some(e => byId.get(e.source).data.label === 'before()' && e.target === outer.id));
        assert(flow.exec.some(e => e.source === outer.id && byId.get(e.target).data.label === 'after()'));
        assert(byId.get(junction.id).data.layoutOnly);
        assert(flow.exec.every(e => byId.has(e.source) && byId.has(e.target)));
    }
    const drilled = await draw({ source, root }, { root: match });
    assert(drilled.flow.nodes.some(n => n.data.branchOffset !== undefined && !n.data.layoutOnly && n.data.label.startsWith('for^')));
    const disabled = n('disabled', source, { items: [match] });
    assert.equal((await draw({ source, root: disabled })).flow.exec.length, 0);
});

test('implicit match focuses retain their value; empty arms do not fabricate execution entries', async () => {
    const source = 'for^ input { when^ 0: other^: }', n = nodesFor(source);
    const root = n('for', source, {
        focus: [n('define', 'input', { targets: [n('focus (it^)', 'input')], values: [n('ident', 'input')] })],
        body: n('if-stmt', '{ when^ 0: other^:', { items: [
            n('if-clause', 'when^ 0:', { condition: n('binary', '0'), body: n('block', 'when^ 0:') }),
            n('if-clause', 'other^:', { body: n('block', 'other^:') }),
        ] }),
    });
    const { graph, flow } = await draw({ source, root });
    const junction = flatten(graph).find(n => n.lhat?.layoutOnly);
    assert.equal(junction.lhat.executionBranches.length, 0);
    assert.equal(flow.definitions.length, 1);
    assert.equal(flow.exec.length, 2, 'FOR enters its focus, then the empty branch junction');
    assert(junction.children.every(n => n.width > 0 && n.height > 0));
});

test('match expressions merge candidate definitions without execution lines; ordinary loops stay unchanged', async () => {
    const source = 'for^ input: when^ 0: 1 other^: 2 ;', n = nodesFor(source);
    const root = n('for', source, {
        focus: [n('define', 'input', { targets: [n('focus (it^)', 'input')], values: [n('ident', 'input')] })],
        body: n('if-expr', ': when^ 0: 1 other^: 2', { items: [
            n('if-clause', 'when^ 0: 1', { condition: n('binary', '0'), body: n('int', '1') }),
            n('if-clause', 'other^: 2', { body: n('int', '2') }),
        ] }),
    });
    const { graph, flow } = await draw({ source, root });
    assert.equal(flow.exec.length, 0);
    assert(flatten(graph).every(n => n.lhat?.executionBranches === undefined));
    const match = flatten(graph).find(n => n.lhat?.kind === 'for');
    const junction = flatten(graph).find(n => n.lhat?.kind === 'if-expr');
    assert(junction.lhat.layoutOnly, 'the lowered expression branch has no redundant box');
    assert.equal(junction.layoutOptions['elk.direction'], 'DOWN');
    assert.deepEqual(junction.children.map(n => conditionOf(n)?.labels[0].text), ['0', undefined]);
    assert.deepEqual(junction.children.map(n => statementsOf(n)[0].labels[0].text), ['1', '2']);
    assert.deepEqual(match.lhat.definitionBranches, [junction.id]);
    assert.equal(flow.definitions.filter(e => e.targetHandle === 'definition-branch').length, 3);
    assert.equal(flow.definitions.filter(e => e.targetHandle === 'definition-in').length, 1, 'focus definition is evaluated once');
    const loopSource = 'for^ row in^ items { visit(row) }', l = nodesFor(loopSource);
    const loop = l('for', loopSource, {
        focus: [l('ident', 'row')], bound: l('ident', 'items'),
        body: l('block', '{ visit(row) }', { items: [l('call-stmt', 'visit(row)')] }),
    });
    const ordinary = await draw({ source: loopSource, root: loop });
    assert(flatten(ordinary.graph).some(n => n.lhat?.kind === 'block'), 'loop body is not a match group');
    assert(ordinary.flow.nodes.every(n => n.data.branchOffset === undefined));
});

test('if expression conditions and values are separate, source-backed boxes joined by merging definition lines', async () => {
    const source = 'let^ grade = f^score:number^{ if^score >= 90: "A" el^score >= 80: "B" el^: "F" ; }';
    const n = nodesFor(source);
    const expression = n('if-expr', 'if^score >= 90: "A" el^score >= 80: "B" el^: "F" ;', { items: [
        n('if-clause', 'if^score >= 90: "A"', { condition: n('binary', 'score >= 90'), body: n('string', '"A"') }),
        n('if-clause', 'el^score >= 80: "B"', { condition: n('binary', 'score >= 80'), body: n('string', '"B"') }),
        n('if-clause', 'el^: "F"', { body: n('string', '"F"') }),
    ] });
    const ret = { ...expression, kind: 'return', fields: { value: [expression] } };
    const fn = n('func', source.slice(source.indexOf('f^')), { body: n('block', source.slice(source.indexOf('{')), { items: [ret] }) });
    const root = n('block', source, { items: [n('define', source, { targets: [n('ident', 'grade')], values: [fn] })] });
    for (const scale of [1, 2]) {
        const { graph, flow } = await draw({ source, root }, { scale });
        const branch = flatten(graph).find(n => n.lhat?.kind === 'if-expr');
        assert.equal(branch.layoutOptions['elk.direction'], 'DOWN');
        assert(branch.children.every(n => n.layoutOptions['elk.direction'] === 'RIGHT'));
        assert.deepEqual(branch.children.map(n => conditionOf(n)?.labels[0].text), ['score >= 90', 'score >= 80', undefined]);
        const values = branch.children.map(n => statementsOf(n)[0]);
        assert.deepEqual(values.map(n => n.labels[0].text), ['"A"', '"B"', '"F"']);
        assert.deepEqual(branch.lhat.definitionBranches, values.map(n => n.id));
        const merges = flow.definitions.filter(e => e.target === branch.id);
        assert.equal(merges.length, 3);
        for (const [i, edge] of merges.entries()) {
            assert.equal(edge.source, values[i].id);
            assert.equal(edge.sourceHandle, 'definition-out');
            assert.equal(edge.targetHandle, 'definition-branch');
            assert.equal(edge.type, 'definition-branch');
            assert.equal(edge.markerEnd, undefined, 'no duplicate arrowhead at the shared junction');
            assert.equal(edge.data.definitionBranchOffset, 18 * scale);
        }
        const markers = flow.nodes.filter(n => n.data.isReturn);
        assert.equal(markers.length, 1, 'candidate values do not invent per-arm returns');
        assert(flow.definitions.some(e => e.source === branch.id && e.target === markers[0].id && e.markerEnd));
        assert(flow.exec.every(e => !values.some(v => v.id === e.source || v.id === e.target)));
        for (const clause of branch.children) {
            const predicate = conditionOf(clause), value = statementsOf(clause)[0];
            assert.equal(value.lhat.definitionRole, 'value');
            assert.equal(source.slice(value.lhat.start, value.lhat.end), value.labels[0].text);
            if (!predicate) continue;
            assert.equal(predicate.lhat.condition.axis, 'horizontal');
            assert.equal(predicate.lhat.condition.entry, value.id);
            assert.equal(source.slice(predicate.lhat.start, predicate.lhat.end), predicate.labels[0].text);
            const rendered = flow.nodes.find(n => n.id === predicate.id);
            assert.equal(rendered.position.y + rendered.height / 2, value.y + value.lhat.definitionHandleY);
            assert(rendered.position.y >= 10 * scale && rendered.position.y + rendered.height <= clause.height - 10 * scale);
        }
    }
    const folded = await draw({ source, root }, { collapse: true });
    assert(!folded.flow.definitions.some(e => e.targetHandle === 'definition-branch'));
    const drilled = await draw({ source, root }, { root: fn, collapse: true });
    assert.equal(drilled.flow.definitions.filter(e => e.targetHandle === 'definition-branch').length, 3);
    const bare = await draw({ source, root }, { root: expression });
    assert.equal(bare.flow.exec.length, 0);
    assert.equal(bare.flow.definitions.length, 3);
    const visible = new Set(bare.flow.nodes.map(n => n.id));
    assert(bare.flow.definitions.every(e => visible.has(e.source) && visible.has(e.target)));
});

test('nested expression alternatives merge locally and do not bypass enclosing calculations or returned containers', async () => {
    const source = 'let^ y = (if^one: if^two: 1 el^: 2 ; el^: { 3 } ;) * 2', n = nodesFor(source);
    const inner = n('if-expr', 'if^two: 1 el^: 2 ;', { items: [
        n('if-clause', 'if^two: 1', { condition: n('ident', 'two'), body: n('int', '1') }),
        n('if-clause', 'el^: 2', { body: n('int', '2') }),
    ] });
    const table = n('table', '{ 3 }', { items: [n('table-entry', '3', { value: n('int', '3') })] });
    const outer = n('if-expr', 'if^one: if^two: 1 el^: 2 ; el^: { 3 } ;', { items: [
        n('if-clause', 'if^one: if^two: 1 el^: 2 ;', { condition: n('ident', 'one'), body: inner }),
        n('if-clause', 'el^: { 3 }', { body: table }),
    ] });
    const binary = n('binary', source.slice(source.indexOf('if^')), { left: outer, right: n('int', '2', undefined, source.lastIndexOf('*')) });
    const root = n('block', source, { items: [n('define', source, { targets: [n('ident', 'y')], values: [binary] })] });
    const { graph, flow } = await draw({ source, root });
    const branches = flatten(graph).filter(n => n.lhat?.kind === 'if-expr');
    assert.equal(flow.definitions.filter(e => e.targetHandle === 'definition-branch').length, 4);
    assert(flow.definitions.some(e => e.source === branches[1].id && e.target === branches[0].id));
    const declaration = flow.nodes.find(n => n.data.label === 'let^ y');
    const outward = flow.definitions.filter(e => e.target === declaration.id);
    assert.equal(outward.length, 1);
    assert.equal(flatten(graph).find(n => n.id === outward[0].source).lhat.kind, 'binary');
    const returnedTable = flatten(graph).find(n => n.lhat?.kind === 'table');
    assert(flow.definitions.some(e => e.source === returnedTable.id && e.target === branches[0].id));
    assert(returnedTable.children.some(n => n.lhat?.synthetic === 'add'), 'value internals survive the split');
});

test('condition boxes center on resolved execution endpoints, clamp inside their arms and cover only the line behind them', async () => {
    const { adoptUserNodes, getElevatedEdgeZIndex } = await import('@xyflow/system');
    for (const scale of [1, 2]) {
        const box = (id, kind, x, y, width, height, extra = {}) => ({
            id, x: x * scale, y: y * scale, width: width * scale, height: height * scale,
            lhat: { kind, start: 1, end: 8, ...extra },
        });
        const arms = [5, 140, 275].map((left, i) => {
            const target = box(`target-${i}`, 'define', left, 0, 30, 30, { definitionRole: 'declaration' });
            const row = box(`row-${i}`, 'define-row', 0, 0, 320, 30, {
                definitionRole: 'row', executionNode: target.id,
            });
            row.children = [target];
            const scope = box(`scope-${i}`, 'block', 0, 70, 320, 50, { executionEntry: row.id });
            scope.children = [row];
            const predicate = box(`condition-${i}`, 'binary', 17, 10, 140, 30, {
                condition: { entry: scope.id, inset: 10 * scale },
            });
            const arm = box(`arm-${i}`, 'if-clause', 340 * i, 34, 320, 140);
            arm.children = [predicate, scope];
            return arm;
        });
        const branch = box('branch', 'if-stmt', 10, 34, 1010, 190, {
            executionBranches: arms.map(n => n.children[1].id), branchOffset: 18 * scale,
        });
        branch.children = arms;
        const owner = box('owner', 'func', 80, 10, 1030, 240);
        owner.children = [branch];
        const graph = { id: 'view', width: 1190 * scale, height: 280 * scale, children: [owner] };
        for (const dx of [0, -100, -10000]) {
            const flow = toFlow(graph, { 'func:1:8': { dx, dy: 0 } }, 600, undefined,
                noop, noop, noop, noop, { current: null }, noop);
            const conditions = flow.nodes.filter(n => n.data.isCondition);
            assert.equal(conditions.length, 3);
            assert(conditions.every(n => n.data.slideKey === 'func:1:8' && !n.data.slideOwner), 'conditions move only with their outer owner');
            for (const selected of [undefined, 'owner', 'branch', 'arm-1', 'target-1', 'condition-1']) {
                const lookup = new Map();
                adoptUserNodes(flow.nodes.map(n => ({ ...n, selected: n.id === selected })), lookup, new Map());
                const edgeZ = edge => getElevatedEdgeZIndex({
                    sourceNode: lookup.get(edge.source), targetNode: lookup.get(edge.target), zIndex: edge.zIndex,
                });
                for (const [i, condition] of conditions.entries()) {
                    const actual = lookup.get(condition.id), arm = lookup.get(`arm-${i}`), target = lookup.get(`target-${i}`);
                    const min = arm.internals.positionAbsolute.x + 10 * scale;
                    const max = arm.internals.positionAbsolute.x + arm.width - condition.width - 10 * scale;
                    const centered = target.internals.positionAbsolute.x + target.width / 2 - condition.width / 2;
                    assert.equal(actual.internals.positionAbsolute.x, Math.max(min, Math.min(max, centered)));
                    assert(actual.internals.z > 8000, 'condition also covers the execution preview');
                    assert(flow.exec.every(e => actual.internals.z > edgeZ(e)), 'condition stays above execution edges after selection/scroll');
                    assert(flow.exec.every(e => e.source !== condition.id && e.target !== condition.id));
                    assert.equal(actual.data.start, 1);
                    assert.equal(actual.data.end, 8);
                    assert(flow.exec.some(e => e.target === target.id && edgeZ(e) > arm.internals.z), 'body is not lifted along with its condition');
                }
                assert(lookup.get('condition-0').internals.positionAbsolute.x > lookup.get('target-0').internals.positionAbsolute.x + 15 * scale - 70 * scale, 'left clamp is exercised');
                assert(lookup.get('condition-2').internals.positionAbsolute.x < lookup.get('target-2').internals.positionAbsolute.x + 15 * scale - 70 * scale, 'right clamp is exercised');
            }
        }
        const markOff = node => { node.lhat.disabled = true; for (const child of node.children ?? []) markOff(child); };
        markOff(owner);
        const off = toFlow(graph, {}, 600, undefined, noop, noop, noop, noop, { current: null }, noop);
        assert(off.nodes.filter(n => n.data.isCondition).every(n => n.zIndex === undefined), 'disabled code retains its bypass-line policy');
    }
});
