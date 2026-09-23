const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { commaLists, listInsertions, listTemplates, insertListEdit, operatorSites, replaceOperatorEdit } = load('graphLists.ts');
const { toElk } = load('webview/map.ts');
const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
const apply = (source, edit) => source.slice(0, edit.start) + edit.text + source.slice(edit.end);
function fixture(source) {
    return (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from); assert(start >= 0, text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
}

function richFixture() {
    const source = 'let^ f = f^ a:number^, b:string^ -> number^, string^ { return^ a + 1, b }\n' +
        'let^ x = f(1, "s")\nlet^ t = {10, 20}';
    const n = fixture(source), fAt = source.indexOf('f^ a'), returnAt = source.indexOf('return^');
    const resultAt = source.indexOf('number^, string^', source.indexOf('->'));
    const binary = n('binary', 'a + 1', { left: n('ident', 'a', undefined, returnAt), right: n('int', '1', undefined, returnAt) }, returnAt, { inferredType: 'number^' });
    const fn = n('func', source.slice(fAt, source.indexOf('\n')), {
        params: [
            n('param', 'a:number^', { name: n('ident', 'a', undefined, fAt), type: n('type-name', 'number^', undefined, fAt) }, fAt),
            n('param', 'b:string^', { name: n('ident', 'b', undefined, source.indexOf('b:string^')), type: n('type-name', 'string^', undefined, fAt) }, fAt),
        ],
        return_type: n('type-tuple', 'number^, string^', { items: [n('type-name', 'number^', undefined, resultAt), n('type-name', 'string^', undefined, resultAt)] }, resultAt),
        body: n('block', '{ return^ a + 1, b }', { items: [n('return', 'return^ a + 1, b', {
            value: [binary, n('ident', 'b', undefined, returnAt)],
        }, returnAt)] }, fAt),
    }, fAt, { inferredReturnType: '(number^, string^)' });
    const callAt = source.indexOf('f(1');
    const call = n('call', 'f(1, "s")', { target: n('ident', 'f', undefined, callAt),
        argument: [n('int', '1', undefined, callAt), n('string', '"s"', undefined, callAt)] }, callAt,
        { callable: { inputs: [], outputs: ['number^', 'string^'], variadic: { type: 'number^' } } });
    const tableAt = source.indexOf('{10');
    const table = n('table', '{10, 20}', { items: [
        n('table-entry', '10', { value: n('int', '10', undefined, tableAt) }, tableAt),
        n('table-entry', '20', { value: n('int', '20', undefined, tableAt) }, tableAt),
    ] }, tableAt);
    const root = n('block', source, { items: [
        n('define', source.slice(0, source.indexOf('\n')), { targets: [n('ident', 'f')], values: [fn] }),
        n('define', 'let^ x = f(1, "s")', { targets: [n('ident', 'x')], values: [call] }),
        n('define', 'let^ t = {10, 20}', { targets: [n('ident', 't')], values: [table] }),
    ] });
    return { source, root, fn, call, table, binary };
}

test('parameters, results, returns, calls and table items share comma-list insertion sites', () => {
    const tree = richFixture(), lists = commaLists(tree);
    for (const [node, field, count] of [[tree.fn, 'params', 2], [tree.fn, 'return_type', 2],
        [tree.call, 'argument', 2], [tree.table, 'items', 2]]) {
        const list = lists.find(list => list.node === node && list.field === field);
        assert(list, `${node.kind}.${field}`); assert.equal(list.items.length, count);
        const sites = listInsertions(tree).filter(site => site.start === node.start && site.field === field);
        assert.equal(sites.length, count, 'one between-position plus one append position');
        assert.equal(sites.at(-1).before, undefined);
    }
    const returned = lists.find(list => list.node.kind === 'return' && list.field === 'value');
    assert.equal(returned.items.length, 2);
});

test('list edits preserve delimiters and can materialize optional or inferred lists', () => {
    const tree = richFixture(), sites = listInsertions(tree);
    const beforeSecond = sites.find(site => site.start === tree.call.start && site.field === 'argument' && site.before !== undefined);
    assert.equal(apply(tree.source, insertListEdit(tree, beforeSecond, 'default')).slice(tree.call.start, tree.call.end + 3), 'f(1, 0, "s")');
    const tableAppend = sites.find(site => site.start === tree.table.start && site.field === 'items' && site.before === undefined);
    assert(apply(tree.source, insertListEdit(tree, tableAppend, 'number')).includes('{10, 20, 0}'));

    const emptySource = 'let^ x = f()', n = fixture(emptySource), call = n('call', 'f()', { target: n('ident', 'f') });
    call.callable = { inputs: [{ type: 'string^' }], outputs: ['number^'] };
    const empty = { source: emptySource, root: n('define', emptySource, { targets: [n('ident', 'x')], values: [call] }) };
    const emptySite = listInsertions(empty).find(site => site.start === call.start && site.field === 'argument');
    assert.equal(apply(emptySource, insertListEdit(empty, emptySite, 'default')), 'let^ x = f("")');

    const errorSource = 'errordef^ E { Bad }', e = fixture(errorSource), kind = e('error-kind', 'Bad', { name: e('ident', 'Bad') });
    const errorTree = { source: errorSource, root: e('errordef', errorSource, { name: e('ident', 'E'), members: [kind] }) };
    const errorSite = listInsertions(errorTree).find(site => site.start === kind.start && site.field === 'members');
    assert.equal(apply(errorSource, insertListEdit(errorTree, errorSite, 'parameter')), 'errordef^ E { Bad { value: any^ } }');

    const implicitSource = 'f^{}', i = fixture(implicitSource), implicit = i('func', implicitSource,
        { body: i('block', '{}') }, 0, { inferredReturnType: '(number^, string^)' });
    const implicitTree = { source: implicitSource, root: implicit };
    const resultSite = listInsertions(implicitTree).find(site => site.field === 'return_type' && site.before === undefined);
    assert.equal(apply(implicitSource, insertListEdit(implicitTree, resultSite, 'boolean')), 'f^ -> number^, string^, bool^ {}');
});

test('binary expressions expose editable operators without expression insertion controls', () => {
    const tree = richFixture(), operator = operatorSites(tree).find(site => site.owner.start === tree.binary.start);
    assert(operator.choices.includes('*'));
    assert.equal(apply(tree.source, replaceOperatorEdit(tree, operator, '*')).slice(tree.binary.start, tree.binary.end), 'a * 1');
    const graph = toElk(tree, { root: tree.binary });
    assert(flatten(graph).some(node => node.lhat?.operator?.text === '+'));
    assert(!flatten(graph).some(node => node.lhat?.synthetic === 'add'), 'expressions change through their operator menu');
});

test('index rows retain insertion controls on simple cells, external holes and empty brackets', () => {
    const { indexExpression } = require('./index-fixture.cjs');
    for (const options of [{ simple: true }, {}, { multi: true }, { empty: true }]) {
        const tree = indexExpression(options), all = flatten(toElk(tree));
        const row = all.find(node => node.lhat?.kind === 'index');
        const append = row.children.find(node => node.lhat?.appendInsertion || node.lhat?.synthetic === 'add');
        assert(append);
        const site = append.lhat.appendInsertion ?? append.lhat.insertion;
        assert.equal(site.kind, 'index');
        assert.equal(site.field, 'argument');
        const edit = insertListEdit(tree, site, 'number');
        assert.equal(apply(tree.source, edit), tree.source.slice(0, -1) + (options.empty ? '0' : ', 0') + ']');
        if (options.multi) {
            const second = row.children.find(node => node.lhat?.insertion);
            assert(second);
            assert.equal(second.lhat.insertionAxis, 'horizontal');
            assert.equal(apply(tree.source, insertListEdit(tree, second.lhat.insertion, 'number')), 'dense[dense.length^ - 1, 0, 2]');
        }
    }
});

test('function drill layout keeps signature cells and horizontal/vertical insertion directions', () => {
    const tree = richFixture(), graph = toElk(tree, { root: tree.fn });
    const signature = flatten(graph).find(node => node.lhat?.kind === 'signature');
    assert(signature);
    const typed = flatten(signature).flatMap(node => node.lhat?.labelParts ?? []).filter(part => part.typeSite);
    assert.deepEqual(typed.map(part => part.typeLabel), ['Number', 'Text', 'Number', 'Text']);
    const horizontal = flatten(graph).filter(node => node.lhat?.insertionAxis === 'horizontal');
    assert(horizontal.length >= 2, 'between-position controls point down in horizontal lists');
    assert(flatten(signature).some(node => node.lhat?.appendInsertion), 'argument and result lists expose trailing add controls');
});
