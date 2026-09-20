// Run with: node --test testing/graph-definition.test.cjs
// AST fixtures keep these layout regressions independent of a local lhatls.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const ELK = require('elkjs/lib/elk.bundled.js');

const mappingPath = path.resolve(__dirname, '../src/webview/map.ts');
const mapping = new Module(mappingPath);
mapping._compile(buildSync({
    entryPoints: [mappingPath],
    bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text, mapping.id);
const { toElk, graphViewportX, stackWideDefinitions, titleOf } = mapping.exports;
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];
const rows = graph => flatten(graph).filter(n => n.lhat?.definitionRole === 'row');
const statements = graph => graph.children.filter(n => n.lhat?.synthetic !== 'start');
const elements = graph => graph.children.filter(n => n.lhat?.synthetic !== 'add');
const pairLabels = row => row.children.map(n => n.labels[0].text);

function assertDefinition(row, source, expected) {
    assert.equal(row.lhat.definitionRole, 'row');
    assert.deepEqual(pairLabels(row), expected);
    const [declaration, value] = row.children;
    assert.equal(declaration.lhat.definitionRole, 'declaration');
    assert.equal(value.lhat.definitionRole, 'value');
    assert.equal(source.slice(declaration.lhat.start, declaration.lhat.revealEnd), expected[0]);
    assert.equal(row.edges.length, 1);
    assert.equal(row.edges[0].definition, true);
    assert.equal(row.edges[0].sources[0], `${value.id}__definition-out`);
    assert.equal(row.edges[0].targets[0], `${declaration.id}__definition-in`);
    assert.equal(declaration.ports[0].layoutOptions['elk.port.side'], 'EAST');
    assert.equal(value.ports[0].layoutOptions['elk.port.side'], 'WEST');
}

function nodesFor(source) {
    return (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        assert(start >= 0, `missing fixture span: ${text}`);
        return {
            kind, start, end: start + text.length, fields,
            line: source.slice(0, start).split('\n').length,
            column: start - source.lastIndexOf('\n', start),
        };
    };
}

test('declaration/value ports point left, while expression branches transpose down', async () => {
    const source = 'let^ y = (if^ x > 10: 1 el^: 0 ;) * 2\nlet^ z:number^ = 3';
    const n = nodesFor(source);
    const branch = n('if-expr', 'if^ x > 10: 1 el^: 0 ;', { items: [
        n('if-clause', 'if^ x > 10: 1', {
            condition: n('binary', 'x > 10'), body: n('int', '1', undefined, source.indexOf(': 1')),
        }),
        n('if-clause', 'el^: 0', { body: n('int', '0', undefined, source.indexOf('el^:')) }),
    ] });
    const value = n('binary', 'if^ x > 10: 1 el^: 0 ;) * 2', {
        left: branch, right: n('int', '2'),
    });
    const root = n('block', source, { items: [
        n('define', source.split('\n')[0], { targets: [n('ident', 'y')], values: [value] }),
        n('define', source.split('\n')[1], { targets: [n('param', 'z:number^')], values: [n('int', '3')] }),
    ] });
    const graph = toElk({ source, root });
    const [first, second] = rows(graph);
    assert.equal(first.children[0].labels[0].text, 'let^ y');
    assert.equal(second.children[0].labels[0].text, 'let^ z:number^');
    assert.equal(first.children[1].layoutOptions['elk.direction'], 'RIGHT');
    assert.equal(first.children[1].children[0].layoutOptions['elk.direction'], 'DOWN');
    assert.equal(first.children[1].children[1].children, undefined);
    const laid = await new ELK().layout(graph);
    for (const row of rows(laid)) {
        const [declaration, definition] = row.children;
        assert(declaration.x + declaration.width < definition.x);
        assert.equal(declaration.y, definition.y);
        assert.equal(row.edges[0].definition, true);
        assert.equal(row.edges[0].sources[0], `${definition.id}__definition-out`);
        assert.equal(row.edges[0].targets[0], `${declaration.id}__definition-in`);
        assert.equal(row.lhat.executionNode, declaration.id);
    }
    const [a, b] = rows(laid);
    assert.equal(a.x + a.children[0].width / 2, b.x + b.children[0].width / 2);
    assert(b.y >= a.y + a.height, 'next statement clears the entire definition');
});

test('folds affect only the value and cannot hide the body when entering it', () => {
    const source = 'let^ f = f^x { print(x) }';
    const n = nodesFor(source);
    const fn = n('func', 'f^x { print(x) }', {
        body: n('block', '{ print(x) }', { items: [n('call-stmt', 'print(x)')] }),
    });
    const root = n('block', source, { items: [
        n('define', source, { targets: [n('ident', 'f')], values: [fn] }),
    ] });
    const folds = { [fn.start]: true };
    const row = rows(toElk({ source, root }, { folds }))[0];
    assert.equal(row.children[0].lhat.collapsed, undefined);
    assert.equal(row.children[1].lhat.collapsed, true);
    assert.equal(row.edges[0].definition, true);
    const entered = toElk({ source, root }, { root: fn, folds, collapse: true });
    assert(flatten(entered).some(n => n.lhat?.kind === 'call-stmt'));
});

test('multiple initializers stay together; uninitialized declarations stay single', () => {
    const source = 'let^ a, b = 1, 2\nlet^ c:number^';
    const n = nodesFor(source);
    const root = n('block', source, { items: [
        n('define', source.split('\n')[0], {
            targets: [n('ident', 'a'), n('ident', 'b')], values: [n('int', '1'), n('int', '2')],
        }),
        n('define', source.split('\n')[1], { targets: [n('param', 'c:number^')] }),
    ] });
    const graph = toElk({ source, root });
    assert.equal(rows(graph).length, 1);
    const row = rows(graph)[0];
    assert.equal(row.children[0].labels[0].text, 'let^ a, b');
    assert.deepEqual(row.children[1].children.map(n => n.labels[0].text), ['1', '2']);
    assert.equal(statements(graph)[1].labels[0].text, 'let^ c:number^');
});

test('var declarations use the same definition lines, types and execution endpoints as let', async () => {
    const source = 'var^ count:number^ = 0\nvar^ pending:number^\ncount := 1';
    const n = nodesFor(source);
    const root = n('block', source, { items: [
        n('define', source.split('\n')[0], {
            targets: [n('param', 'count:number^')], values: [n('int', '0')],
        }),
        n('define', source.split('\n')[1], { targets: [n('param', 'pending:number^')] }),
        n('reassign', 'count := 1', {
            targets: [n('ident', 'count', undefined, source.lastIndexOf('count'))], values: [n('int', '1')],
        }),
    ] });
    const graph = await new ELK().layout(toElk({ source, root }));
    assert.equal(rows(graph).length, 1, 'no definition line for an uninitialized variable or reassignment');
    assertDefinition(statements(graph)[0], source, ['var^ count:number^', '0']);
    assert.equal(statements(graph)[1].labels[0].text, 'var^ pending:number^');
    assert.equal(statements(graph)[2].labels[0].text, 'count := 1');
    assert.equal(graph.edges[1].sources[0], `${statements(graph)[0].id}__flow-out`);
    assert(graph.edges.filter(e => !e.targets.includes(graph.children.at(-1).id)).every(e => e.drawn && !e.definition));
    assert.equal(graph.children.at(-1).lhat.synthetic, 'add');
});

test('table member pairs wrap using both boxes; positional comparisons stay leaves', async () => {
    const source = '{ first = 1, second = 2, [("a=b")] #[ ignored = ]# = 3, (1 = 1), 42 }';
    const n = nodesFor(source);
    const table = n('table', source, { items: [
        n('table-entry', 'first = 1', { key: n('ident', 'first'), value: n('int', '1') }),
        n('table-entry', 'second = 2', { key: n('ident', 'second'), value: n('int', '2') }),
        n('table-entry', '[("a=b")] #[ ignored = ]# = 3', { key: n('string', '"a=b"'), value: n('int', '3') }),
        n('table-entry', '(1 = 1)', { value: n('binary', '1 = 1') }),
        n('table-entry', '42', { value: n('int', '42') }),
    ] });
    for (const width of [360, 1500]) {
        const graph = await new ELK().layout(toElk({ source, root: table }, { width }));
        const pairs = rows(graph);
        assert.equal(pairs.length, 3);
        assertDefinition(pairs[0], source, ['first', '1']);
        assertDefinition(pairs[1], source, ['second', '2']);
        assertDefinition(pairs[2], source, ['[("a=b")]', '3']);
        for (const pair of pairs) {
            const [left, right] = pair.children;
            assert.equal(left.y, right.y);
            assert(left.x + left.width < right.x);
        }
        const positional = flatten(graph).filter(n => ['(1 = 1)', '42'].includes(n.labels?.[0]?.text));
        assert.equal(positional.length, 2);
        assert(positional.every(n => !n.children && !n.lhat.definitionRole));
        assert(flatten(graph).flatMap(n => n.edges ?? []).every(e => !e.drawn || e.definition));
        assert(width === 1500 ? elements(graph).length === 1 : elements(graph).length > 1,
            'rows wrap using the full labeled value width, including the type caption');
        assert.equal(graph.children.at(-1).lhat.synthetic, 'add', 'insertion affordance follows all rows');
        for (const line of elements(graph)) {
            assert.equal(line.layoutOptions['elk.direction'], 'RIGHT');
            for (let i = 1; i < line.children.length; i++) {
                assert(line.children[i].x >= line.children[i - 1].x + line.children[i - 1].width);
                assert.equal(line.children[i].y + line.children[i].height / 2,
                    line.children[i - 1].y + line.children[i - 1].height / 2,
                    'mixed-height pairs and values in one table row share a horizontal centerline');
            }
        }
    }
});

test('def and self-table members split while abstract fields and function parameters do not', async () => {
    const source = 'def^{ self^{ count:number^ = 0 }, abstract^limit:number^, override^new = f^n = 1 { n }, op^= = f^a, b { a = b } }';
    const n = nodesFor(source);
    const template = n('self-table', 'self^{ count:number^ = 0 }', { items: [
        n('table-entry', 'count:number^ = 0', {
            key: n('ident', 'count'), type: n('type-name', 'number^'), value: n('int', '0'),
        }),
    ] });
    const method = n('func', 'f^n = 1 { n }', {
        params: [n('param', 'n = 1', { name: n('ident', 'n', undefined, source.indexOf('f^n')), fallback: n('int', '1') })],
        body: n('block', '{ n }', { items: [n('return', 'n', {
            value: [n('ident', 'n', undefined, source.indexOf('{ n'))],
        }, source.indexOf('{ n'))] }),
    });
    const equality = n('func', 'f^a, b { a = b }', { body: n('block', '{ a = b }', {
        items: [n('return', 'a = b', { value: [n('binary', 'a = b')] })],
    }) });
    const definition = n('def', source, { items: [
        n('table-entry', 'self^{ count:number^ = 0 }', { value: template }),
        n('table-entry', 'abstract^limit:number^', {
            key: n('ident', 'limit'), value: n('type-name', 'number^', undefined, source.indexOf('abstract^')),
        }),
        n('table-entry', 'override^new = f^n = 1 { n }', { key: n('ident', 'new'), value: method }),
        n('table-entry', 'op^= = f^a, b { a = b }', { key: n('ident', '=', undefined, source.indexOf('op^')), value: equality }),
    ] });
    const reply = { source, root: definition };
    const graph = await new ELK().layout(toElk(reply));
    const pairs = rows(graph).filter(n => n.lhat.kind === 'member-row');
    assert.equal(pairs.length, 3, 'only explicit member values split');
    assertDefinition(pairs[0], source, ['count:number^', '0']);
    assert.equal(pairs[1].children[0].labels[0].text, 'override^new');
    assert.equal(pairs[1].children[1].labels[0].text, 'f^n = 1 …');
    assert.equal(pairs[2].children[0].labels[0].text, 'op^=');
    assert.equal(graph.children[0].lhat.kind, 'self-table', 'no anonymous wrapper around the template');
    assert(flatten(graph).some(n => n.labels?.[0]?.text === 'abstract^limit:number^' && !n.children));
    for (const pair of pairs) assert.equal(pair.children[0].y, pair.children[1].y);
    const entered = toElk(reply, { root: definition, collapse: true });
    const foldedMethod = rows(entered).find(n => n.children[0].labels[0].text === 'override^new');
    assert(foldedMethod.children[1].lhat.collapsed, 'only the method value folds');
    assert.equal(foldedMethod.children[0].lhat.collapsed, undefined);
    assert.equal(foldedMethod.edges[0].definition, true);
    const methodView = toElk(reply, { root: method, collapse: true });
    assert.equal(rows(methodView).length, 1, 'only the implicit return splits; parameter defaults remain in the signature');
    assert.equal(rows(methodView)[0].lhat.kind, 'return-row');
});

test('branch-free enclosing expressions expose nested member definitions', async () => {
    const source = 'return^ { child = { leaf = 1 } }';
    const n = nodesFor(source);
    const inner = n('table', '{ leaf = 1 }', { items: [
        n('table-entry', 'leaf = 1', { key: n('ident', 'leaf'), value: n('int', '1') }),
    ] });
    const outer = n('table', '{ child = { leaf = 1 } }', { items: [
        n('table-entry', 'child = { leaf = 1 }', { key: n('ident', 'child'), value: inner }),
    ] });
    const root = n('return', source, { value: [outer] });
    const graph = await new ELK().layout(toElk({ source, root }, { width: 450 }));
    assert.equal(rows(graph).length, 3, 'return value and both nested member definitions');
    assert.equal(rows(graph)[0].children[0].lhat.pictogram, 'return');
    assertDefinition(rows(graph)[2], source, ['leaf', '1']);
    assert.equal(rows(graph)[1].children[0].labels[0].text, 'child');
    assert.equal(rows(graph)[1].children[1].lhat.kind, 'table');
});

test('viewport centring protects declaration positions without preserving empty layout space', () => {
    const row = {
        id: 'definition', x: 666, width: 500,
        lhat: { definitionRole: 'row' },
        children: [{ id: 'declaration', x: 0, width: 234, lhat: { definitionRole: 'declaration' } }],
    };
    const graph = { id: 'root', width: 1566, children: [
        { id: 'wide-call', x: 10, width: 1546 }, row,
    ] };
    const x = graphViewportX(graph, 1020);
    assert.equal(x + graph.width / 2, 510, 'wide siblings must not move the document axis right');
    assert(row.x + x >= 8 && row.x + row.width + x <= 1012, 'the fitting definition is fully visible');
    assert.equal(graphViewportX({ ...graph, children: [] }, 1020), x, 'adding a visible declaration does not shift the graph');
    assert.equal(graphViewportX(graph, 2000), (2000 - graph.width) / 2, 'a fitting graph remains centred');

    const nearLeft = { ...row, x: 100, children: [{ ...row.children[0], x: 20 }] };
    assert.equal(graphViewportX({ ...graph, children: [row, nearLeft] }, 450), 8 - 120,
        'only actual declaration clipping limits centring, including the child offset');
    assert.equal(graphViewportX({ ...nearLeft, width: 1200 }, 450), 8 - 20,
        'a drilled-in row ignores its former parent-relative position');
});

test('only wide outermost values drop; later statements gain clearance without moving the declaration', () => {
    const makeRow = (id, width, y, declarationHeight = 30) => ({
        id, x: 40, y, width, height: 240,
        lhat: { kind: 'define-row', start: y, end: y + 1, definitionRole: 'row' },
        children: [
            { id: `${id}-decl`, x: 0, y: 0, width: 80, height: declarationHeight,
                lhat: { definitionRole: 'declaration' } },
            { id: `${id}-value`, x: 108, y: 0, width: width - 108, height: 240,
                lhat: { definitionRole: 'value' }, children: [{ id: 'inner', x: 10, y: 34 }] },
        ],
        ports: [{ id: `${id}-out`, x: 40, y: 240, layoutOptions: { 'elk.port.side': 'SOUTH' } }],
    });
    const wide = makeRow('wide', 1200, 60);
    const next = makeRow('next', 180, 320);
    const nested = makeRow('nested', 1600, 34);
    const container = { id: 'container', x: 0, y: 580, width: 1620, height: 284, children: [nested] };
    const original = { id: 'root', width: 1640, height: 884, children: [wide, next, container] };
    const result = stackWideDefinitions(original, 931);
    assert.equal(result.children[0].children[1].y, 30);
    assert.equal(result.children[0].children[1].x, 108);
    assert.equal(result.children[0].height, 270);
    assert.equal(result.children[0].ports[0].y, 270);
    assert.equal(result.children[0].lhat.stackedDefinition, true);
    assert.equal(result.children[0].children[0], wide.children[0], 'declaration is untouched');
    assert.equal(result.children[0].children[1].children, wide.children[1].children, 'descendants stay relative');
    assert.equal(result.children[1].y, 350);
    assert.equal(result.children[1].children[1].y, 0, 'fitting row stays horizontal');
    assert.equal(result.children[2].y, 610);
    assert.equal(result.children[2].children[0], nested, 'nested declarations never split off another scroller');
    assert.equal(result.height, original.height + 30);
    assert.equal(wide.children[1].y, 0, 'input layout is not mutated');
    assert.equal(stackWideDefinitions(original, 2000), original, 'wide viewport restores the original layout');
    assert.equal(stackWideDefinitions(original, 1200), original, 'right edge at the margin needs no offset');
    assert.equal(stackWideDefinitions(original, 1199).children[0].lhat.stackedDefinition, true);
    assert.equal(stackWideDefinitions(makeRow('scaled', 1200, 0, 45), 931).children[1].y, 45);
    const twoWide = stackWideDefinitions({ ...original, children: [wide, makeRow('second', 1300, 320, 45), container] }, 931);
    assert.equal(twoWide.children[1].y, 350);
    assert.equal(twoWide.children[1].children[1].y, 45);
    assert.equal(twoWide.children[2].y, 655);
    assert.equal(twoWide.height, original.height + 75, 'each wide value contributes its own clearance');
});

test('a fitting-width table still scrolls when its positioned right edge is off screen', () => {
    // inventory.lh:15, at a 900px viewport. The declaration column places
    // the 806px row at x=163, so its right edge is 977px on screen.
    const row = {
        id: 'prices-row', x: 163, y: 200, width: 806, height: 134,
        lhat: { definitionRole: 'row' },
        children: [
            { id: 'prices', x: 0, y: 0, width: 90, height: 30,
                lhat: { definitionRole: 'declaration' } },
            { id: 'table', x: 118, y: 0, width: 688, height: 134,
                lhat: { definitionRole: 'value' }, children: [{ id: 'row-1', x: 10, y: 34 }] },
        ],
    };
    // Another declaration anchors the left margin; this row is displaced
    // within that shared column, not merely by empty space before all rows.
    const anchor = { id: 'anchor', x: 0, y: 0, width: 80, height: 30,
        lhat: { definitionRole: 'row' }, children: [
            { id: 'anchor-decl', x: 0, width: 80, lhat: { definitionRole: 'declaration' } },
        ] };
    const graph = { id: 'root', width: 1200, height: 500, children: [row, anchor] };
    assert(row.width < 884, 'reproduces the old width-only false negative');
    const stacked = stackWideDefinitions(graph, 884).children[0];
    assert.equal(stacked.lhat.stackedDefinition, true);
    assert.equal(stacked.children[1].y, 30);
    assert.equal(stacked.children[0], row.children[0]);
    assert.equal(stacked.children[1].children, row.children[1].children);
    assert.equal(stackWideDefinitions(graph, 1600), graph, 'actually visible values remain beside declarations');
    const exact = { ...graph, children: [{ ...row, x: 78 }, anchor] };
    assert.equal(stackWideDefinitions(exact, 884), exact, 'actual right edge exactly at the margin');
    assert.equal(stackWideDefinitions({ ...graph, children: [{ ...row, x: 79 }, anchor] }, 884)
        .children[0].lhat.stackedDefinition, true, 'one pixel of clipping enables scrolling');
});

test('errordef retains its name, every error kind and payload fields when unfolded or drilled into', async () => {
    const source = 'module^test\nerrordef^StockError {\nOutOfStock { sku = "", wanted = 0 },\nUnknownSku { sku = "" },\n}';
    const n = nodesFor(source);
    const unknownStart = source.indexOf('UnknownSku');
    const err = n('errordef', source.slice(source.indexOf('errordef^')), {
        name: n('ident', 'StockError'),
        members: [
            n('error-kind', 'OutOfStock { sku = "", wanted = 0 }', {
                name: n('ident', 'OutOfStock'), members: [
                    n('param', 'sku = ""', { name: n('ident', 'sku'), fallback: n('string', '""') }),
                    n('param', 'wanted = 0', { name: n('ident', 'wanted'), fallback: n('int', '0') }),
                ],
            }),
            n('error-kind', 'UnknownSku { sku = "" }', {
                name: n('ident', 'UnknownSku'), members: [
                    n('member-decl', 'sku = ""', {
                        name: n('ident', 'sku', undefined, unknownStart),
                        fallback: n('string', '""', undefined, unknownStart),
                    }, unknownStart),
                ],
            }),
        ],
    });
    const reply = { source, root: n('block', source, { items: [n('module', 'module^test'), err] }) };
    const folded = statements(toElk(reply, { collapse: true }))[1];
    assert.equal(folded.labels[0].text, 'errordef^StockError …');
    assert.equal(folded.children, undefined);
    assert.equal(titleOf(err, source), 'errordef^StockError');
    for (const options of [{ collapse: false }, { root: err, collapse: true, folds: { [err.start]: true } }]) {
        const laid = await new ELK().layout(toElk(reply, options));
        const box = options.root ? laid : statements(laid)[1];
        assert.deepEqual(elements(box).map(n => n.labels[0].text), ['OutOfStock', 'UnknownSku']);
        assertDefinition(box.children[0].children[0], source, ['sku', '""']);
        assertDefinition(box.children[0].children[1], source, ['wanted', '0']);
        assertDefinition(box.children[1].children[0], source, ['sku', '""']);
        assert(box.children[1].y >= box.children[0].y + box.children[0].height);
        assert.equal(flatten(box).some(n => n.lhat?.kind === 'ident'), false, 'names are titles, not separate children');
        assert((box.edges ?? []).every(e => !e.drawn), 'error kinds are not execution steps');
        if (!options.root) assert(box.width >= 'errordef^StockError'.length * 7.2 + 18 + 18);
    }
});

test('container minimum width includes its title and fold button at each font scale', async () => {
    const source = 'module^test\nlocalerrordef^LongStockErrorDefinitionName { Missing }';
    const n = nodesFor(source);
    const err = n('errordef', source.slice(source.indexOf('localerrordef^')), {
        name: n('ident', 'LongStockErrorDefinitionName'),
        members: [n('error-kind', 'Missing', { name: n('ident', 'Missing') })],
    });
    const reply = { source, root: n('block', source, { items: [n('module', 'module^test'), err] }) };
    for (const scale of [1, 1.5, 2]) {
        const graph = await new ELK().layout(toElk(reply, { collapse: false, scale }));
        const box = statements(graph)[1];
        const min = Math.round(box.labels[0].text.length * 7.2 * scale) + 2 * Math.round(18 * scale);
        assert(box.width >= min, 'small children must not shrink a long header');
        assert.equal(box.children[0].labels[0].text, 'Missing');
        assert.equal(box.children[0].labels[0].text, 'Missing', 'a payload-free kind remains visible');
        assert.equal(flatten(box.children[0]).filter(n => n.lhat?.synthetic === 'add').length, 1,
            'an empty error payload has its field insertion point');
    }
});

test('enum definitions fold by name and preserve every member and written initializer', async () => {
    const source = 'module^test\npublic^enum^Mode { Idle, Walk, Dash = 10, Label = "dash" }';
    const n = nodesFor(source);
    const enumeration = n('enumdef', source.slice(source.indexOf('public^')), {
        name: n('ident', 'Mode'),
        members: [
            n('enum-member', 'Idle', { name: n('ident', 'Idle') }),
            n('enum-member', 'Walk', { name: n('ident', 'Walk') }),
            n('enum-member', 'Dash = 10', { name: n('ident', 'Dash'), members: [n('int', '10')] }),
            n('enum-member', 'Label = "dash"', { name: n('ident', 'Label'), members: [n('string', '"dash"')] }),
        ],
    });
    const reply = { source, root: n('block', source, { items: [n('module', 'module^test'), enumeration] }) };
    const folded = statements(toElk(reply, { collapse: true }))[1];
    assert.equal(folded.labels[0].text, 'public^enum^Mode …');
    assert.equal(folded.lhat.collapsed, true);
    assert.equal(folded.children, undefined);
    assert.equal(titleOf(enumeration, source), 'public^enum^Mode');
    for (const options of [{ collapse: false }, { root: enumeration, collapse: true, folds: { [enumeration.start]: true } }]) {
        const graph = await new ELK().layout(toElk(reply, options));
        const box = options.root ? graph : statements(graph)[1];
        assert.deepEqual(box.children.slice(0, 2).map(n => n.labels[0].text), ['Idle', 'Walk']);
        assertDefinition(box.children[2], source, ['Dash', '10']);
        assertDefinition(box.children[3], source, ['Label', '"dash"']);
        assert.equal(box.layoutOptions['elk.direction'], 'DOWN');
        for (let i = 0; i < box.children.length; i++) {
            const member = box.children[i];
            if (i < 2) {
                assert.equal(member.children, undefined);
                assert.equal(source.slice(member.lhat.start, member.lhat.end), member.labels[0].text);
            }
            if (i > 0) assert(member.y >= box.children[i - 1].y + box.children[i - 1].height);
        }
        assert(!flatten(box).some(n => n.lhat?.kind === 'ident'), 'the enum name is a title, not a child');
        assert((box.edges ?? []).every(e => !e.drawn), 'members are not a statement execution chain');
    }
});
