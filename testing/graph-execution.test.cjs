const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { buildSync, transformSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');
const { branchedCalls } = require('./call-tree-fixture.cjs');
const { branchFlow, terminalFlow } = require('./condition-fixture.cjs');
const { patternMatching } = require('./pattern-fixture.cjs');
const { catchFlow } = require('./catch-fixture.cjs');

const mappingPath = path.resolve(__dirname, '../src/webview/map.ts');
const mapping = new Module(mappingPath);
mapping._compile(buildSync({
    entryPoints: [mappingPath], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text, mapping.id);
const { toElk, graphViewportX, stackWideDefinitions } = mapping.exports;
const gesturePath = path.resolve(__dirname, '../src/webview/rf/gesture.ts');
const gesture = new Module(gesturePath);
gesture._compile(buildSync({
    entryPoints: [gesturePath], bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text, gesture.id);
const { ownsHorizontalSlide } = gesture.exports;
// Exercise the renderer's actual endpoint resolution as well as the mapping.
const renderer = fs.readFileSync(path.resolve(__dirname, '../src/webview/rf/main.tsx'), 'utf8').replace(/\r\n/g, '\n');
const first = renderer.indexOf('type Slides =');
const last = renderer.indexOf('/**\n * 8.6: inertia.');
assert(first >= 0 && last > first);
const toFlow = vm.runInNewContext(`const MarkerType={ArrowClosed:'arrowclosed'};
    ${transformSync(renderer.slice(first, last), { loader: 'tsx' }).code}; toFlow`,
    { graphViewportX, ownsHorizontalSlide });
const noop = () => {};
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
const starts = graph => flatten(graph).filter(n => n.lhat?.synthetic === 'start');
const statementsOf = clause => clause.children.filter(n => !n.lhat?.condition && n.lhat?.synthetic !== 'add');
const conditionOf = clause => clause.children.find(n => n.lhat?.condition);
const draw = async (reply, options = {}) => {
    const graph = await new ELK().layout(toElk(reply, options));
    return { graph, flow: toFlow(graph, {}, 947, undefined, noop, noop, noop, noop, { current: null }, noop) };
};

test('break and continue stop their path without hiding the other branch or the code after the loop', async () => {
    for (const kind of ['break', 'next', 'continue', 'skip']) {
        for (const conditional of [false, true]) {
            const jumpText = `${kind}^`;
            const inner = `before()\n${jumpText}\ndead()`;
            const branchText = `if^true^ {\n${inner}\n}`;
            const bodyText = `{\n${conditional ? branchText : inner}\nalive()\n}`;
            const loopText = `repeat^3 ${bodyText}`;
            const source = `${loopText}\nafter()`;
            const n = (kind, text, fields) => {
                const start = source.indexOf(text);
                assert(start >= 0);
                return { kind, start, end: start + text.length, line: 1, column: 1, fields };
            };
            const call = name => {
                const value = n('call', `${name}()`, { target: n('ident', name), argument: [] });
                value.callable = { inputs: [], outputs: [] };
                return { ...value, kind: 'call-stmt', fields: { value }, callable: undefined };
            };
            const jump = n(kind, jumpText);
            const branch = conditional ? n('if-stmt', branchText, { items: [n('if-clause', branchText, {
                condition: n('hat-ident', 'true^'), body: n('block', `{\n${inner}\n}`, { items: [call('before'), jump, call('dead')] }),
            })] }) : undefined;
            const body = n('block', bodyText, { items: conditional ? [branch, call('alive')] : [call('before'), jump, call('dead'), call('alive')] });
            const loop = n('repeat', loopText, { count: n('int', '3'), body });
            const reply = { source, root: n('block', source, { items: [loop, call('after')] }) };
            const { graph, flow } = await draw(reply);
            const transfer = flatten(graph).find(node => node.lhat?.kind === kind);
            assert(transfer.lhat.executionTerminal);
            assert(flow.exec.some(edge => edge.target === transfer.id));
            assert(!flow.exec.some(edge => edge.source === transfer.id), 'no fall-through, merge or speculative jump route');
            const dead = flow.nodes.find(node => node.data.isCall && node.data.start === source.indexOf('dead()'));
            assert(dead.data.noExecutionHandles);
            assert(!flow.exec.some(edge => edge.source === dead.id || edge.target === dead.id));
            const alive = flow.nodes.find(node => node.data.isCall && node.data.start === source.indexOf('alive()'));
            assert.equal(alive.data.noExecutionHandles, !conditional);
            if (conditional) {
                const junction = flatten(graph).find(node => node.lhat?.kind === 'if-stmt');
                assert.equal(junction.lhat.executionBranchExits.length, 0);
                assert(junction.lhat.executionBypass, 'the condition-false path still continues');
                assert(flow.exec.some(edge => edge.target === alive.id));
            }
            const after = flow.nodes.find(node => node.data.isCall && node.data.start === source.indexOf('after()'));
            assert(!after.data.noExecutionHandles);
            assert(flow.exec.some(edge => edge.target === after.id), 'termination does not escape the loop scope');
        }
    }
});

test('catch handlers occupy separate columns and are never entered by normal execution', async () => {
    const reply = catchFlow();
    const { graph, flow } = await draw(reply);
    const scope = flatten(graph).find(n => n.lhat?.catchScope);
    assert(scope);
    const [main, ...handlers] = scope.children;
    assert.equal(handlers.length, 2);
    assert(handlers[0].x >= main.x + main.width);
    assert(handlers[1].x >= handlers[0].x + handlers[0].width);
    for (const lane of handlers) assert(Math.abs(lane.y - main.y) < 1, 'lanes have aligned tops');
    const headers = handlers.map(lane => flatten(lane).find(n => n.lhat?.kind === 'catch'));
    assert.equal(scope.lhat.executionBranches.length, 1, 'only the main body is entered');
    for (const header of headers) {
        assert.equal(header.labels[0].text, 'Catch');
        assert(!flow.exec.some(e => e.target === header.id), 'no normal path enters a catch');
        assert(flow.exec.some(e => e.source === header.id), 'each handler has its own vertical path');
    }
    assert.equal(headers[0].lhat.foldedSummary, 'IOError.Eof');
    assert.equal(headers[1].lhat.foldedSummary, undefined);
    assert(!flatten(scope).some(n => n.lhat?.kind === 'error'), 'filters belong inside the Catch box');
    for (const header of headers) {
        const edge = flow.exec.find(e => e.source === header.id);
        assert(flow.nodes.find(n => n.id === edge.target).data.isCall, 'Catch connects directly to its body');
    }
    assert.equal(scope.lhat.executionBranchExits.length, 3);
    assert.equal(flow.exec.filter(e => e.target === scope.id && e.targetHandle === 'flow-merge').length, 3);
    const after = flow.nodes.find(n => n.data.isCall && n.data.start === reply.source.indexOf('after()'));
    assert(flow.exec.some(e => e.source === scope.id && e.target === after.id), 'merged paths continue after the block');
    assert(scope.edges.every(e => !e.drawn), 'lane ordering is not execution');
});

test('unfolding a handled block after Fold All retains folded catch bodies and their execution paths', async () => {
    const reply = catchFlow();
    const handled = reply.root.fields.items[0];
    const key = `${handled.kind}:${handled.start}:${handled.end}`;
    const { graph, flow } = await draw(reply, { collapseAll: true, folds: { [key]: false } });
    const scope = flatten(graph).find(n => n.lhat?.catchScope);
    assert(scope);
    for (const lane of scope.children.slice(1)) {
        const header = flatten(lane).find(n => n.lhat?.kind === 'catch');
        const folded = flatten(lane).find(n => n.lhat?.collapsed && n.lhat?.kind === 'call-stmt');
        assert(header && folded, 'each handler still contains its folded statement');
        assert(flow.exec.some(e => e.source === header.id && e.target === folded.id), 'catch enters its folded statement');
        assert(flow.exec.some(e => e.source === folded.id), 'folded statement continues along the handler path');
        assert(scope.lhat.executionBranchExits.some(id => flatten(lane).some(n => n.id === id)),
            'the handler rejoins the scope');
    }
    assert.equal(scope.lhat.executionBranchExits.length, 3);
});

test('unfolding if and el clauses after Fold All retains their folded statements', async () => {
    const reply = branchFlow({ otherwise: true });
    const branch = reply.root.fields.items[0];
    const key = node => `${node.kind}:${node.start}:${node.end}`;
    const folds = Object.fromEntries([branch, ...branch.fields.items].map(node => [key(node), false]));
    const { graph, flow } = await draw(reply, { collapseAll: true, folds });
    const clauses = flatten(graph).filter(n => n.lhat?.kind === 'if-clause');
    assert.equal(clauses.length, 2);
    for (const clause of clauses) {
        const folded = flatten(clause).find(n => n.lhat?.collapsed && n.lhat?.kind === 'call-stmt');
        assert(folded, 'each opened clause retains its folded statement');
        assert(flow.exec.some(e => e.target === folded.id), 'the clause enters its statement');
        assert(flow.exec.some(e => e.source === folded.id), 'the statement continues to the branch merge');
    }
});

test('catch fall-through remains reachable after a terminal main path and terminal handlers do not merge', async () => {
    for (const callable of [false, true]) {
        const reply = catchFlow({ mainTerminal: true, handlerTerminal: true, callable });
        const { graph, flow } = await draw(reply);
        const scope = flatten(graph).find(n => n.lhat?.catchScope);
        assert(scope, 'callable-body hoisting preserves the catch junction');
        assert.equal(scope.lhat.executionTerminal, false, 'the first handler can still complete');
        assert.equal(scope.lhat.executionBranchExits.length, 1);
        const terminals = flatten(scope).filter(n => n.lhat?.pictogram === 'return');
        assert.equal(terminals.length, 2);
        for (const terminal of terminals) assert(!flow.exec.some(e => e.source === terminal.id));
        const after = flow.nodes.find(n => n.data.isCall && n.data.start === reply.source.indexOf('after()'));
        assert(flow.exec.some(e => e.source === scope.id && e.target === after.id));
    }
});

test('drilled catch scopes and immediate callable bodies keep their own start without an incoming edge', async () => {
    const reply = catchFlow(), body = reply.root.fields.items[0];
    const callable = catchFlow({ callable: true });
    const callableBody = callable.root.fields.body;
    const handled = callableBody.fields.items[0];
    callableBody.fields = { items: handled.fields.items, arms: handled.fields.arms };
    for (const [tree, options] of [[reply, { root: body }], [callable, {}]]) {
        const { graph, flow } = await draw(tree, options);
        const scope = flatten(graph).find(n => n.lhat?.catchScope);
        assert(scope);
        assert.equal(scope.lhat.executionBranches.length, 0);
        const markers = starts(scope);
        assert.equal(markers.length, 1);
        assert(!flow.exec.some(edge => edge.target === markers[0].id));
        assert.equal(flow.exec.filter(edge => edge.target === scope.id && edge.targetHandle === 'flow-merge').length, 3);
    }
});

test('wide call trees scroll as one group while execution and routed definitions retain their actual endpoints', async () => {
    const graph = stackWideDefinitions(await new ELK().layout(toElk(branchedCalls(), { width: 320 })), 304);
    const paint = slides => toFlow(graph, slides, 320, undefined, noop, noop, noop, noop, { current: null }, noop);
    const flow = paint({}), owner = flow.nodes.find(n => n.data.slideOwner && n.data.layoutOnly);
    assert(owner && owner.data.slideKey, 'the invisible call-tree extent owns horizontal movement');
    const absolute = node => { let x = node.position.x; while (node.parentId) { node = flow.nodes.find(n => n.id === node.parentId); x += node.position.x; } return x; };
    const executionCards = flow.nodes.filter(node => node.data.isCall && !node.data.noExecutionHandles);
    assert.equal(absolute(executionCards[1]) + executionCards[1].width / 2 + graphViewportX(graph, 320), 160,
        'the following fitting statement is independently centred');
    assert.equal(flow.definitions.length, 5);
    for (const edge of flow.definitions) {
        assert.equal(edge.type, 'call-definition');
        assert(edge.data.laneOffset > 0);
        assert(flow.nodes.some(n => n.id === edge.source && n.data.definitionRole === 'value'));
        assert(flow.nodes.some(n => n.id === edge.target && n.data.definitionRole === 'declaration'));
    }
    for (const edge of flow.exec) {
        for (const endpoint of [edge.source, edge.target]) {
            const node = flow.nodes.find(n => n.id === endpoint);
            assert(!node.data.noExecutionHandles, 'execution ends at visible statement cards, not layout wrappers or arguments');
        }
    }
    const shifted = paint({ [owner.data.slideKey]: { dx: -80, dy: 0 } });
    assert(shifted.nodes.find(n => n.id === owner.id).position.x < owner.position.x);
    assert.deepEqual(Array.from(shifted.definitions, e => [e.source, e.target, e.data.laneOffset]),
        Array.from(flow.definitions, e => [e.source, e.target, e.data.laneOffset]));
    for (const node of flow.nodes.filter(n => n.data.slideKey === owner.data.slideKey && n.id !== owner.id)) {
        assert.deepEqual(shifted.nodes.find(n => n.id === node.id).position, node.position, 'children retain their positions relative to the scrolling owner');
    }
});

test('a function literal is an external call target and operator calls connect from their result boxes', async () => {
    const source = 'f^n:number^{n}(10) + f(1)';
    const n = (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from);
        assert(start >= 0);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const fn = n('func', 'f^n:number^{n}', {
        params: [n('param', 'n:number^', { name: n('ident', 'n'), type: n('type-name', 'number^') })],
        return_type: n('type-name', 'number^'),
        body: n('block', '{n}', { items: [n('ident', 'n', undefined, source.indexOf('{'))] }),
    });
    const first = n('call', 'f^n:number^{n}(10)', { target: fn, argument: [n('int', '10')] }, 0,
        { callable: { inputs: [{ type: 'number^' }], outputs: ['number^'] } });
    const second = n('call', 'f(1)', { target: n('ident', 'f', undefined, source.indexOf(' + ')),
        argument: [n('int', '1')] }, source.indexOf(' + '),
        { callable: { inputs: [{ type: 'number^' }], outputs: ['number^'] } });
    const reply = { source, root: n('binary', source, { left: first, right: second }) };
    const { graph, flow } = await draw(reply);
    const all = flatten(graph), tree = all.find(node => node.lhat?.expressionTree);
    const targetTree = all.find(node => node.lhat?.callTree && node.lhat.start === first.start);
    const card = all.find(node => node.lhat?.invocation && node.lhat.start === first.start);
    const outside = all.find(node => node.lhat?.kind === 'func' && node.id !== card?.id);
    assert(outside && targetTree && card);
    assert.equal(outside.lhat.inlineable, false);
    assert(!flatten(card).includes(outside), 'the function is not inside the call card');
    const target = card.lhat.callTarget;
    assert(flow.definitions.some(edge => edge.source === outside.id && edge.target === target.input &&
        edge.sourceHandle === 'definition-out' && edge.targetHandle === 'definition-in'));
    const output = all.find(node => node.id === targetTree.lhat.definitionOutputs[0]);
    assert(output && output.lhat.kind === 'output-slot');
    assert(tree.lhat.operandLinks.some(link => link.source === output.id));
    assert(flow.definitions.some(edge => edge.source === output.id && edge.type === 'operand-definition' &&
        edge.sourceHandle === 'definition-out'));
    assert.equal(all.find(node => node.lhat?.kind === 'ident' && node.lhat.start === second.fields.target.start)?.lhat.inlineable, true);
});
test('fitting expressions are centred as a whole; oversized expressions start left and scroll', () => {
    const card = { id: 'card', x: 0, y: 0, width: 120, height: 100,
        lhat: { kind: 'call', start: 0, end: 10, invocation: true } };
    const tree = { id: 'tree', x: 300, y: 0, width: 500, height: 100,
        lhat: { kind: 'call-tree', start: 0, end: 10, callTree: true, layoutOnly: true },
        children: [{ id: 'column', x: 0, y: 0, width: 120, height: 100, children: [card] }] };
    const anchor = { id: 'anchor', x: 0, y: 150, width: 120, height: 40,
        lhat: { kind: 'ident', start: 11, end: 12 } };
    const graph = { id: 'view', width: 800, height: 200, children: [tree, anchor] };
    const paint = (slides = {}, width = 600) => toFlow(graph, slides, width, undefined, noop, noop, noop, noop, { current: null }, noop);
    const flow = paint(), owner = flow.nodes.find(n => n.id === 'tree');
    assert(owner.width < 600 - 16);
    assert.equal(owner.position.x + graphViewportX(graph, 600), 50);
    assert(owner.position.x + owner.width + graphViewportX(graph, 600) <= 592);
    assert(!owner.data.slideOwner, 'centring exposes the entire fitting-width expression');
    assert(owner.data.scrollSurface, 'a call tree has a pointer surface in its empty spaces');
    const narrow = paint({}, 400), narrowOwner = narrow.nodes.find(n => n.id === 'tree');
    assert.equal(narrowOwner.position.x + graphViewportX(graph, 400), 8);
    assert(narrowOwner.data.slideOwner && narrowOwner.data.slideKey);
    assert.equal(narrowOwner.data.slideMax, 0);
    assert(narrowOwner.data.slideMin < 0);
    assert.equal(narrow.nodes.find(n => n.id === 'card').data.slideKey, narrowOwner.data.slideKey);
    const moved = paint({ [narrowOwner.data.slideKey]: { dx: narrowOwner.data.slideMin, dy: 0 } }, 400);
    const movedOwner = moved.nodes.find(n => n.id === 'tree');
    assert.equal(movedOwner.position.x + movedOwner.width + graphViewportX(graph, 400), 392);
    assert.deepEqual(moved.nodes.find(n => n.id === 'anchor').position, flow.nodes.find(n => n.id === 'anchor').position);
    assert(!paint({}, 1600).nodes.find(n => n.id === 'tree').data.slideOwner, 'a wider viewport removes unnecessary sliding');
    assert.equal(paint({}, 1600).nodes.find(n => n.id === 'tree').position.x + graphViewportX(graph, 1600), 550,
        'non-overflowing expressions also centre their complete bounds');
});

const labelsOfEdges = flow => {
    const labels = new Map(flow.nodes.map(n => [n.id, n.data.isStart ? '<start>' : n.data.isAdd ? '<add>' : n.data.label]));
    return Array.from(flow.exec, e => `${labels.get(e.source)} -> ${labels.get(e.target)}`);
};

function nodesFor(source) {
    return (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        assert(start >= 0, `missing fixture: ${text}`);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
}

test('an empty file has a source-free start and append control at every font scale', async () => {
    for (const source of ['', '# only a comment\n']) {
        const root = { kind: 'block', start: 0, end: source.length, line: 1, column: 1 };
        for (const scale of [1, 1.5, 2]) {
            const { graph, flow } = await draw({ source, root }, { scale });
            assert.equal(graph.children.length, 2);
            assert.equal(starts(graph).length, 1);
            assert.equal(graph.children[0].width, 24 * scale);
            assert.equal(graph.children[0].height, 24 * scale);
            assert.equal(flow.nodes.length, 2, 'start and append, with no placeholder block node');
            assert(flow.nodes[1].data.isAdd && flow.nodes[1].data.insertion);
            const start = flow.nodes[0];
            assert(start.data.isStart);
            assert.equal(start.data.label, '');
            assert.equal(start.data.start, undefined, 'no fabricated source location');
            assert.equal(start.data.end, undefined);
            assert.equal(start.data.foldable, false);
            assert.equal(start.data.collapsed, false);
            assert.deepEqual(labelsOfEdges(flow), ['<start> -> <add>']);
            assert(flow.nodes[1].data.executionAppend);
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
    assert.deepEqual(labelsOfEdges(flow).sort(), ['<start> -> let^ x', 'let^ x -> last()', 'last() -> <add>'].sort());
    for (const edge of flow.exec) {
        assert.equal(edge.selectable, false);
        assert.equal(edge.deletable, false);
        assert.equal(edge.reconnectable, false);
        assert.equal(edge.sourceHandle, 'flow-out');
        assert.equal(edge.targetHandle, 'flow-in');
        assert.equal(edge.zIndex, 2000, 'execution lines are above nested container backgrounds');
    }
    assert.equal(flow.definitions.length, 1);
    assert(flow.nodes.every(node => node.connectable === false));
    const only = n('block', 'last()', { items: [n('call-stmt', 'last()')] });
    assert.deepEqual(labelsOfEdges((await draw({ source, root: only })).flow), ['<start> -> last()', 'last() -> <add>']);
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
    assert.deepEqual(functions[0].children.map(n => n.lhat.kind), ['signature', 'start', 'call-stmt', 'call-stmt', 'add']);
    assert.deepEqual(functions[1].children.map(n => n.lhat.kind), ['signature', 'start', 'add']);
    assert(functions.every(n => n.layoutOptions['elk.direction'] === 'DOWN'));
    assert(functions.every(n => n.lhat.executionEntry === undefined), 'callable bodies remain independent chains');
    assert.deepEqual(labelsOfEdges(open.flow).sort(), [
        '<start> -> let^ f', 'let^ f -> let^ p', '<start> -> one()', 'one() -> two()',
        '<start> -> <add>', 'let^ p -> <add>', 'two() -> <add>',
    ].sort());
    assert.equal(starts((await draw(reply, { collapse: true })).graph).length, 1, 'folded contents are hidden');
    const drilled = await draw(reply, { root: fn, collapse: true, folds: { [fn.start]: true } });
    assert.equal(starts(drilled.graph).length, 1);
    const drilledFunction = flatten(drilled.graph).find(n => n.lhat?.kind === 'func');
    assert.equal(drilledFunction.children[0].lhat.kind, 'signature', 'drill-down retains the editable declaration');
    assert.equal(drilledFunction.children[1].lhat.synthetic, 'start', 'the body begins directly below the signature');
    assert.deepEqual(labelsOfEdges(drilled.flow), ['<start> -> one()', 'one() -> two()', 'two() -> <add>']);
    const empty = await draw(reply, { root: proc, collapse: true });
    assert.equal(starts(empty.graph).length, 1);
    assert.deepEqual(labelsOfEdges(empty.flow), ['<start> -> <add>']);
    assert(empty.flow.nodes.some(n => n.data.isStart));
    assert(flatten(empty.graph).some(n => n.lhat?.kind === 'signature'));
    assert.equal(empty.flow.nodes.filter(n => n.data.isStart || n.data.isAdd).length, 4,
        'empty callable has argument/result insertion controls plus body start/append');
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
    const outer = flatten(graph).find(n => n.lhat?.kind === 'func' && n.lhat.start === root.start);
    assert.deepEqual(outer.children.map(n => n.lhat.kind), ['signature', 'start', 'call-stmt', 'block', 'define-row', 'call-stmt', 'add']);
    assert.equal(outer.children[3].lhat.start, nestedBlock.start);
    const inner = flatten(graph).find(n => n.lhat?.kind === 'func' && n.lhat.start === nestedFunction.start);
    assert.deepEqual(inner.children.map(n => n.lhat.kind), ['signature', 'start', 'call-stmt', 'add']);
    assert.deepEqual(labelsOfEdges(flow).sort(), [
        '<start> -> before()', 'before() -> nested()', 'nested() -> <add>', '<add> -> let^ inner',
        'let^ inner -> after()', '<start> -> value()', 'value() -> <add>', 'after() -> <add>',
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
            assert.equal(add.width, Math.round(15.4 * scale));
            assert.equal(add.height, Math.round(15.4 * scale));
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
        const { flow } = await draw(reply, { collapse: true });
        assert(flow.nodes.some(n => n.data.collapsed));
        assert(!flow.nodes.some(n => n.data.isAdd && !n.data.insertion), 'folded member list hides its own insertion control');
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
        'inside() -> nested()', 'nested() -> <add>', '<add> -> after()', 'after() -> <add>', '<add> -> last()', 'last() -> <add>',
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
    assert.deepEqual(labelsOfEdges(file.flow), ['<start> -> enum^Mode', 'enum^Mode -> <add>']);
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
        assert.equal(flow.exec.length, 1, 'callable body ends at its return');
        assert(!flow.nodes.some(node => node.data.executionAppend));
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

test('scroll updates retain every execution and definition endpoint before DOM remeasurement', async () => {
    const { adoptUserNodes, getEdgePosition, ConnectionMode, Position } = await import('@xyflow/system');
    const box = (id, kind, x, y, width = 80, height = 30, extra = {}) => ({
        id, x, y, width, height, lhat: { kind, start: y, end: y + 1, ...extra },
    });
    const line = (id, source, target) => ({ id, sources: [source], targets: [target], drawn: true });
    const wide = box('wide', 'block', 80, 50, 1600, 220);
    wide.children = [box('first', 'start', 300, 30), box('last', 'call-stmt', 300, 100)];
    wide.edges = [line('inside', 'first', 'last')];
    const declaration = box('declaration', 'define', 80, 350, 80, 30, { definitionRole: 'declaration' });
    const value = box('value', 'int', 200, 350, 80, 30, { definitionRole: 'value' });
    const graph = { id: 'root', width: 1680, height: 430,
        children: [box('before', 'start', 80, 0), wide, declaration, value],
        edges: [line('enter', 'before', 'wide'), line('outside', 'wide', 'declaration'),
            { ...line('definition', 'value', 'declaration'), definition: true }],
    };
    const render = dx => toFlow(graph, { 'block:50:51': { dx, dy: 0 } }, 947, undefined,
        noop, noop, noop, noop, { current: null }, noop);
    const lookup = new Map(), parents = new Map();
    const initial = render(0);
    adoptUserNodes(initial.nodes, lookup, parents);
    // Seed the first completed DOM measurement, then use React Flow's real
    // adoption/edge resolution without another ResizeObserver notification.
    for (const node of lookup.values()) {
        node.measured = { width: node.width, height: node.height };
        const handle = (id, position, x, y) => ({ id, position, x, y, width: 7, height: 7 });
        node.internals.handleBounds = {
            source: [handle('flow-out', Position.Bottom, node.width / 2, node.height),
                handle('definition-out', Position.Left, 0, node.height / 2)],
            target: [handle('flow-in', Position.Top, node.width / 2, 0),
                handle('definition-in', Position.Right, node.width, node.height / 2)],
        };
    }
    const endpoints = flow => new Map([...flow.exec, ...flow.definitions].map(edge => [edge.id,
        getEdgePosition({ id: edge.id, sourceNode: lookup.get(edge.source), targetNode: lookup.get(edge.target),
            sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, connectionMode: ConnectionMode.Strict }),
    ]));
    const baseline = endpoints(initial);
    assert([...baseline.values()].every(Boolean));
    const baseX = lookup.get('first').internals.positionAbsolute.x;
    for (const dx of [-30, -180, -75, 0]) {
        const flow = render(dx);
        adoptUserNodes(flow.nodes, lookup, parents);
        const current = endpoints(flow);
        assert.deepEqual([...current].filter(([, position]) => !position).map(([id]) => id), [],
            `all lines must stay mounted immediately after scrolling to ${dx}`);
        const moved = current.get('x__inside'), start = baseline.get('x__inside');
        const shift = lookup.get('first').internals.positionAbsolute.x - baseX;
        assert.equal(shift, dx, 'the fixture actually scrolls');
        assert.equal(moved.sourceX, start.sourceX + shift, 'inner line follows its scrolled parent');
        assert.equal(moved.targetX, start.targetX + shift);
        assert.equal(moved.sourceY, start.sourceY);
        assert.deepEqual(current.get('d__definition'), baseline.get('d__definition'),
            'the unrelated definition line keeps its position and remains drawable');
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
    assert.equal(bare.flow.nodes.filter(n => n.data.isReturn || n.data.isAdd).length, 2);
    assert(bare.flow.nodes.some(n => n.data.isReturn));
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
    assert.equal(tail.flow.definitions[0].source, flatten(tail.graph).find(n => n.id === value.id).lhat.definitionOutputs[0]);
    assert.equal(tail.flow.definitions[0].target, marker.id);
    assert.equal(tail.flow.exec.length, 1);
    assert(!tail.flow.nodes.some(node => node.data.executionAppend));
    assert.equal(tail.flow.exec[0].source, start.id);
    assert.equal(tail.flow.exec[0].target, marker.id);
    const callable = flatten(tail.graph).find(n => n.lhat?.kind === 'func');
    assert.equal(callable.children[1].lhat.synthetic, 'start');
    assert.equal(callable.children[2].lhat.kind, 'return-row');
    const folded = await draw({ source: implicitSource, root: implicit }, { collapse: true });
    assert(!folded.flow.nodes.some(n => n.data.isReturn), 'folded callable hides its contents together');
    const drilled = await draw({ source: implicitSource, root: implicit }, { root: implicit, collapse: true });
    assert.equal(drilled.flow.nodes.filter(n => n.data.isStart).length, 1);
    assert.equal(drilled.flow.nodes.filter(n => n.data.isReturn).length, 1, 'drilling restores both editing anchors');
});

test('implicit tuple returns and their outer callable retain independent partial scrolling', async () => {
    const values = Array.from({ length: 20 }, (_, i) => String(100 + i));
    const expression = `(${values.join(', ')})`, source = `f^{ ${expression} }`, n = nodesFor(source);
    const fn = n('func', source, { body: n('block', source.slice(source.indexOf('{')), {
        items: [n('return', expression, { value: values.map(v => n('int', v)) })],
    }) });
    for (const scale of [1, 2]) {
        const laid = await new ELK().layout(toElk({ source, root: fn }, { root: fn, width: 450, scale }));
        const stacked = stackWideDefinitions(laid, 434);
        const row = flatten(stacked).find(n => n.lhat?.kind === 'return-row');
        assert(row.lhat.stackedDefinition);
        const [marker, value] = row.children;
        assert.equal(value.y, marker.y + marker.height);
        assert.deepEqual(value.children.map(n => n.labels[0].text), values);
        const convert = slides => toFlow(stacked, slides, 450, undefined, noop, noop, noop, noop, { current: null }, noop);
        const flow = convert({});
        const owners = flow.nodes.filter(n => n.data.slideOwner);
        const owner = owners.find(n => n.id === value.id);
        const outerOwner = owners.find(n => n.id !== value.id);
        const icon = flow.nodes.find(n => n.data.isReturn);
        assert(owner, 'the wide returned value overrides horizontal motion in its subtree');
        assert(outerOwner, 'the wide callable still scrolls from the rest of its box');
        assert.equal(icon.data.slideKey, outerOwner.data.slideKey,
            'the fixed return marker belongs to the outer scrolling region');
        assert.equal(source.slice(icon.data.start, icon.data.end), expression);
        assert.equal(flow.nodes.filter(n => n.data.isStart).length, 1);
        assert(flow.exec.some(e => e.target === icon.id));
        const moved = convert({ [owner.data.slideKey]: { dx: -100, dy: 0 } });
        assert(moved.nodes.find(n => n.id === owner.id).position.x < owner.position.x);
        assert.deepEqual(moved.nodes.find(n => n.id === icon.id).position, icon.position);
        const outerMoved = convert({ [outerOwner.data.slideKey]: { dx: -100, dy: 0 } });
        assert(outerMoved.nodes.find(n => n.id === outerOwner.id).position.x < outerOwner.position.x);
        assert.deepEqual(outerMoved.nodes.find(n => n.id === owner.id).position,
            owner.position, 'the inner owner keeps its parent-relative position while the callable moves');
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
        const row = flatten(stacked).find(n => n.lhat?.kind === 'return-row');
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
    assert.equal(nestedFlow.nodes.find(n => n.data.slideOwner).data.start, root.start, 'the enclosing binding frame owns nested scrolling');
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
        assert.deepEqual(mapped.children.map(n => conditionOf(n)?.labels[0].text), ['Condition', 'Condition', undefined]);
        assert.deepEqual(mapped.children.map(n => conditionOf(n)?.children[0].labels[0].text), ['ready', 'other', undefined]);
        assert(mapped.children.every(n => n.labels[0].text === ''), 'conditions are not printed in the enclosing headers');
        for (const clause of mapped.children) {
            const predicate = conditionOf(clause);
            if (!predicate) continue;
            assert.equal(source.slice(predicate.lhat.start, predicate.lhat.end), predicate.children[0].labels[0].text, 'condition reveal selects only its expression');
            assert(predicate.children.length === 1 && predicate.lhat.noExecutionHandles, 'condition contains its expression without joining execution flow');
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
        assert(flow.exec.filter(e => e.sourceHandle !== 'flow-branch').every(e => e.type === 'execution'), 'ordinary execution lines use the target-near orthogonal router');
        assert(flow.exec.every(e => e.pathOptions.borderRadius === 6 && e.pathOptions.offset === 6));
        assert(mapped.lhat.foldable && mapped.lhat.foldKey);
        const folded = await draw({ source, root }, { scale, folds: { [mapped.lhat.foldKey]: true } });
        const foldedBranch = folded.flow.nodes.find(node => node.data.foldKey === mapped.lhat.foldKey);
        assert(foldedBranch.data.collapsed);
        assert(folded.flow.exec.some(edge => edge.target === foldedBranch.id));
        assert(folded.flow.exec.some(edge => edge.source === foldedBranch.id));
        assert(!folded.flow.exec.some(edge => edge.sourceHandle === 'flow-branch'),
            'a collapsed control structure keeps outer execution but removes hidden branch wires');
    }
    const entered = await draw({ source, root }, { root: branch });
    const visible = new Set(entered.flow.nodes.map(n => n.id));
    assert(entered.flow.nodes.some(n => n.data.branchOffset !== undefined), 'IF root retains its top junction');
    assert(entered.flow.exec.every(e => visible.has(e.source) && visible.has(e.target)));
    const offRoot = { ...root, fields: { items: [{ ...branch, kind: 'disabled', fields: { items: [branch] } }] } };
    const off = await draw({ source, root: offRoot });
    assert.deepEqual(labelsOfEdges(off.flow), ['<start> -> <add>'], 'disabled IFs are bypassed on the way to the append point');
});

test('nested ifs have separate junctions and empty clauses enter their statement append points', async () => {
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
    const arms = flow.exec.filter(e => e.type === 'branch');
    assert.equal(arms.length, 4);
    assert.equal(arms.filter(e => flow.nodes.find(n => n.id === e.target).data.executionAppend).length, 2);
    assert.equal(flow.exec.filter(e => e.type === 'execution-bypass').length, 1, 'only the inner IF lacks an else arm');
    assert(arms.some(e => e.source === branches[0].id && e.target === branches[1].id));
    assert(arms.some(e => e.source === branches[1].id && flow.nodes.find(n => n.id === e.target).data.label === 'one()'));
    const empty = branches[0].children.at(-1);
    assert.equal(empty.labels[0].text, '');
    assert(empty.width > 0 && empty.height > 0, 'empty else still has a visible box');
    assert.equal(empty.children.length, 1, 'only the append control remains in an empty body');
    assert.equal(empty.children[0].lhat.synthetic, 'add');
});

test('statement branches merge completed arms and route no-match paths around their contents', async () => {
    for (const otherwise of [false, true]) for (const next of [false, true]) for (const empty of [false, true]) {
        const reply = branchFlow({ otherwise, next, empty });
        const { graph, flow } = await draw(reply);
        const branch = flatten(graph).find(node => node.lhat?.kind === 'if-stmt');
        const byId = new Map(flow.nodes.map(node => [node.id, node]));
        const bypass = flow.exec.filter(edge => edge.type === 'execution-bypass');
        assert.equal(bypass.length, otherwise ? 0 : 1, 'an explicit else replaces the no-match path');
        if (!otherwise) {
            assert.equal(bypass[0].source, branch.id);
            assert.equal(bypass[0].target, branch.id);
            assert.equal(bypass[0].sourceHandle, 'flow-branch');
            assert.equal(bypass[0].targetHandle, 'flow-merge');
            assert(bypass[0].data.laneOffset > 0);
        }
        const merges = flow.exec.filter(edge => edge.targetHandle === 'flow-merge' && edge.type !== 'execution-bypass');
        assert.equal(merges.length, otherwise ? 2 : 1);
        assert(merges.every(edge => byId.get(edge.source).data.executionAppend && edge.target === branch.id));
        const continuation = flow.exec.find(edge => edge.source === branch.id && edge.sourceHandle === 'flow-out');
        assert(continuation, 'the joined branch always has a continuation');
        assert.equal(byId.get(continuation.target).data.executionAppend, !next);
        for (const node of flow.nodes.filter(node => node.data.executionAppend)) {
            assert(flow.exec.some(edge => edge.target === node.id), 'every visible statement footer has an incoming path');
        }
        const folded = await draw(reply, { folds: { [branch.lhat.foldKey]: true } });
        assert(!folded.flow.exec.some(edge => edge.type === 'execution-bypass' || edge.targetHandle === 'flow-merge'),
            'folding hides internal branch routes');
        assert(folded.flow.exec.some(edge => folded.flow.nodes.find(node => node.id === edge.target).data.executionAppend));
    }
});

test('return and panic end their paths and terminal branches do not merge or offer statement appends', async () => {
    for (const panic of [false, true]) for (const branch of ['none', 'partial', 'all']) for (const trailing of [false, true]) {
        const reply = terminalFlow({ panic, branch, trailing }), original = JSON.stringify(reply);
        const { graph, flow } = await draw(reply);
        const all = new Map(flatten(graph).map(node => [node.id, node]));
        const terminals = flow.nodes.filter(node => node.data.isReturn || all.get(node.id).lhat?.kind === 'panic');
        assert.equal(terminals.length, branch === 'all' ? 2 : 1);
        for (const terminal of terminals) {
            assert(terminal.data.executionTerminal);
            assert(flow.exec.some(edge => edge.target === terminal.id), 'live terminal statements still have incoming execution');
            assert(!flow.exec.some(edge => edge.source === terminal.id), 'terminal statements have no outgoing execution');
        }
        assert(!flow.exec.some(edge => edge.targetHandle === 'flow-merge' && edge.type !== 'execution-bypass'),
            'terminating arms do not rejoin the branch');
        assert.equal(flow.nodes.filter(node => node.data.executionAppend).length, branch === 'partial' ? 1 : 0);
        assert.equal(flow.exec.filter(edge => edge.type === 'execution-bypass').length, branch === 'partial' ? 1 : 0);
        if (trailing) {
            const following = flow.nodes.find(node => node.data.isCall && node.data.start === reply.source.indexOf('print'));
            assert(following, 'already-written unreachable source remains visible');
            assert.equal(following.data.noExecutionHandles, branch !== 'partial');
            assert.equal(!!following.data.insertion, branch === 'partial');
            assert.equal(flow.exec.some(edge => edge.target === following.id), branch === 'partial');
        }
        assert.equal(JSON.stringify(reply), original);
    }
});

test('disabled terminals do not cut live execution, and panic unary nodes are also terminal', async () => {
    for (const panic of [false, true]) {
        const reply = terminalFlow({ panic, trailing: true, disabled: true });
        const { flow } = await draw(reply);
        const after = flow.nodes.find(node => node.data.isCall);
        assert(flow.exec.some(edge => edge.target === after.id));
        assert(flow.nodes.some(node => node.data.executionAppend));
    }
    const reply = terminalFlow({ panic: true, trailing: true });
    reply.root.fields.body.fields.items[0].kind = 'unary';
    const { graph, flow } = await draw(reply);
    assert(!flow.nodes.some(node => node.data.executionAppend));
    const panic = flatten(graph).find(node => node.lhat?.operatorExpression && node.lhat.executionTerminal);
    assert(panic);
    assert(!flow.exec.some(edge => edge.source === panic.id));
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
        assert.deepEqual(junction.children.map(n => conditionOf(n)?.labels[0].text), ['Pattern', 'Pattern', 'Pattern', undefined]);
        assert.deepEqual(junction.children.map(n => { const pattern = conditionOf(n); return pattern && source.slice(pattern.lhat.start, pattern.lhat.end); }),
            ['0', '1 to^ 3, 5', 'fits^ number^', undefined]);
        assert.deepEqual(statementsOf(junction.children[0]).map(n => n.lhat.kind), ['disabled', 'define-row', 'call-stmt']);
        assert.equal(statementsOf(junction.children[1])[0].lhat.kind, 'return-row');
        assert.equal(statementsOf(junction.children[2])[0].lhat.kind, 'block', 'explicit nested blocks survive');
        assert.equal(starts(graph).length, 1, 'a match does not create a new execution scope');
        const declaration = flow.nodes.find(n => n.data.label === 'let^ subject');
        const byId = new Map(flow.nodes.map(n => [n.id, n]));
        const target = flow.nodes.find(n => n.data.definitionRole === 'declaration' && n.data.label === 'subject');
        assert(flow.definitions.some(e => e.target === target.id && byId.get(e.source).data.label === 'input'));
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
    assert(drilled.flow.nodes.some(n => n.data.branchOffset !== undefined && !n.data.layoutOnly && n.data.label === 'Pattern Matching Branch'));
    const disabled = n('disabled', source, { items: [match] });
    assert.equal((await draw({ source, root: disabled })).flow.exec.length, 0);
});

test('implicit match focuses retain their value and empty arms connect their append points', async () => {
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
    assert.equal(junction.lhat.executionBranches.length, 2);
    assert.equal(flow.definitions.length, 1);
    assert.equal(flow.exec.length, 6, 'focus and junction connect the two empty arms and merge their exits');
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
    assert.deepEqual(junction.children.map(n => conditionOf(n)?.labels[0].text), ['Pattern', undefined]);
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

test('structured patterns retain their value connections without becoming execution steps', async () => {
    for (const expression of [false, true]) for (const defaultArm of [false, true]) {
        const reply = patternMatching({ expression, defaultArm });
        const { graph, flow } = await draw(reply);
        const patterns = flatten(graph).filter(node => node.lhat?.kind === 'pattern');
        assert.equal(patterns.length, 2);
        const inside = new Set(patterns.flatMap(flatten).map(node => node.id));
        assert(flow.exec.every(edge => !inside.has(edge.source) && !inside.has(edge.target)));
        assert.equal(flow.definitions.filter(edge => inside.has(edge.source) && inside.has(edge.target)).length, 2,
            'the call retains its input wire and feeds the inline addition through an operand slot');
        if (expression) {
            assert.equal(flow.exec.length, 0);
            assert.equal(flow.definitions.filter(edge => edge.targetHandle === 'definition-branch').length, defaultArm ? 4 : 3);
        } else {
            assert.equal(flow.exec.filter(edge => edge.type === 'execution-bypass').length, defaultArm ? 0 : 1);
        }
        const folded = await draw(reply, { folds: { [patterns[0].lhat.foldKey]: true } });
        assert(flatten(folded.graph).some(node => node.lhat?.foldKey === patterns[0].lhat.foldKey && node.lhat.collapsed));
        assert.equal(folded.flow.exec.length, flow.exec.length, 'folding a pattern leaves statement dispatch intact');
    }
});

test('if expression conditions and values are separate, source-backed boxes joined by merging definition lines', async () => {
    const source = 'let^ grade = f^score:number^{ if^score >= 90: "A" el^score >= 80: "B" el^: "F" ; }';
    const n = nodesFor(source);
    const comparison = (text, value) => n('binary', text, {
        left: n('ident', 'score', undefined, source.indexOf(text)), right: n('int', value),
    });
    const expression = n('if-expr', 'if^score >= 90: "A" el^score >= 80: "B" el^: "F" ;', { items: [
        n('if-clause', 'if^score >= 90: "A"', { condition: comparison('score >= 90', '90'), body: n('string', '"A"') }),
        n('if-clause', 'el^score >= 80: "B"', { condition: comparison('score >= 80', '80'), body: n('string', '"B"') }),
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
        assert.deepEqual(branch.children.map(n => conditionOf(n)?.labels[0].text), ['Condition', 'Condition', undefined]);
        assert.deepEqual(branch.children.map(n => { const p = conditionOf(n); return p && source.slice(p.lhat.start, p.lhat.end); }),
            ['score >= 90', 'score >= 80', undefined]);
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
            const expression = predicate.children[0];
            assert(expression.lhat.operatorExpression, 'the comparison uses the inline expression layout');
            assert(flatten(expression).some(n => n.lhat?.operator?.text === '>='));
            const inside = new Set(flatten(predicate).map(n => n.id));
            assert(flow.exec.every(e => !inside.has(e.source) && !inside.has(e.target)));
            assert.equal(flow.definitions.filter(e => inside.has(e.source) && inside.has(e.target)).length, 0);
            const rendered = flow.nodes.find(n => n.id === predicate.id);
            const desired = value.y + value.lhat.definitionHandleY - rendered.height / 2;
            assert.equal(rendered.position.y, Math.max(10 * scale, Math.min(clause.height - rendered.height - 10 * scale, desired)));
            assert(rendered.position.y >= 10 * scale && rendered.position.y + rendered.height <= clause.height - 10 * scale);
        }
    }
    const folded = await draw({ source, root }, { collapse: true });
    assert(!folded.flow.definitions.some(e => e.targetHandle === 'definition-branch'));
    const drilled = await draw({ source, root }, { root: fn, collapse: true });
    assert.equal(drilled.flow.definitions.filter(e => e.targetHandle === 'definition-branch').length, 3);
    const bare = await draw({ source, root }, { root: expression });
    assert.equal(bare.flow.exec.length, 0);
    assert.equal(bare.flow.definitions.filter(e => e.targetHandle === 'definition-branch').length, 3);
    assert.equal(bare.flow.definitions.length, 3, 'inline condition operands need no separate input connections');
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
    const declaration = flow.nodes.find(n => n.data.definitionRole === 'declaration' && n.data.label === 'y');
    const outward = flow.definitions.filter(e => e.target === declaration.id);
    assert.equal(outward.length, 1);
    assert(flatten(graph).find(n => n.id === outward[0].source).lhat.operatorExpression);
    assert.equal(outward[0].source, flatten(graph).find(n => n.lhat?.kind === 'binary').lhat.definitionOutputs[0]);
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
