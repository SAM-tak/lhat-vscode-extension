const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { withLhatServer } = require('./lhat-server.cjs');
function load(file) {
    const entry = path.resolve(__dirname, '../src', file), mod = new Module(entry);
    mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const api = load('graphStatements.ts'), expressions = load('graphExpressions.ts');
const flat = n => [n, ...Object.values(n.fields ?? {}).flat().flatMap(flat)];
const apply = (source, change) => source.slice(0, change.start) + change.text + source.slice(change.end);

test('new statement templates produce their intended real AST node kinds', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const empty = await parse(''), site = api.statementInsertions(empty)[0];
    const expected = { call: 'call-stmt', assign: 'reassign', with: 'with', handled: 'block', type: 'define',
        tableDefinition: 'define', enumeration: 'enumdef', error: 'errordef', module: 'module', import: 'import-stmt', require: 'require-stmt' };
    for (const [id, kind] of Object.entries(expected)) {
        const tree = await parse(apply('', api.insertStatementEdit(empty, site, id)));
        assert.equal(tree.root.fields.items.length, 1, id);
        assert.equal(tree.root.fields.items[0].kind, kind, id);
        assert(!flat(tree.root).some(n => n.kind === 'error'), id);
        if (id === 'handled') assert(tree.root.fields.items[0].fields.arms?.length, 'catch arm is present');
        if (id === 'module') assert(!api.statementTemplates(tree, api.statementInsertions(tree).slice(-1)[0]).some(c => c.id === 'module'));
    }
}));

test('procedure bodies create yield and await while ordinary functions do not offer them', { timeout: 30000 }, async () => withLhatServer(async parse => {
    for (const keyword of ['p^', 'f^']) {
        const tree = await parse(`let^ task = ${keyword}{}`), body = flat(tree.root).find(n => n.kind === 'func').fields.body;
        const site = api.statementInsertions(tree).find(s => s.start === body.start && s.end === body.end);
        const choices = api.statementTemplates(tree, site);
        assert.equal(choices.some(c => c.id === 'yield'), keyword === 'p^');
        if (keyword === 'p^') for (const id of ['yield', 'await']) {
            const updated = await parse(apply(tree.source, api.insertStatementEdit(tree, site, id)));
            assert(flat(updated.root).some(n => n.kind === id), id);
        }
    }
}));

test('assignment target replacement cannot replace a writable name with a literal', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const tree = await parse('var^a = 0\nvar^b = 1\na := 2');
    const site = expressions.expressionSites(tree).find(s => s.assignmentTarget);
    assert(site);
    assert.equal(expressions.replaceExpression(tree, { ...site, assignmentTarget: false }, 'number'), undefined);
    const change = expressions.replaceExpression(tree, site, 'reference:b');
    const updated = await parse(apply(tree.source, change));
    assert.equal(updated.source, 'var^a = 0\nvar^b = 1\nb := 2');
    assert.equal(updated.root.fields.items[2].kind, 'reassign');
}));


test('module, import, require and comment fields update real unsaved documents', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const api = load('graphTextFields.ts');
    let tree = await parse('# old\nmodule^example.old\nimport^std.io\nlet^m = require^"./old.lh"');
    for (const [kind, value] of [['module', 'example.changed'], ['import', 'std.thread'], ['require', './日本語.lh'], ['comment', 'new comment']]) {
        const field = api.textFields(tree).find(f => f.site.field === kind);
        assert(field, kind);
        const change = api.editTextField(tree, field.site, value);
        tree = await parse(apply(tree.source, change));
        assert.equal(api.textFields(tree).find(f => f.site.field === kind).value, value);
        assert.equal(tree.root.fields.items.length, 3);
    }
}));


test('operator edits use actual Lhat unary, equality, bitwise, fallback and vector tokens', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const api = load('graphLists.ts');
    for (const [source, before, after, expected] of [
        ['let^x = !true^', '!', 'bitnot^', 'let^x = bitnot^true^'],
        ['let^x = 1 = 2', '=', '!=', 'let^x = 1 != 2'],
        ['let^x = 1 <=> 2', '<=>', '+', 'let^x = 1 + 2'],
        ['let^x = 1 bitand^ 2', 'bitand^', 'bitxor^', 'let^x = 1 bitxor^ 2'],
        ['let^x = nil^ ?? 2', '??', 'catch^', 'let^x = nil^ catch^ 2'],
        ['let^x = a cross^ b', 'cross^', 'dot^', 'let^x = a dot^ b'],
    ]) {
        const tree = await parse(source), site = api.operatorSites(tree).find(s => s.text === before);
        assert(site, source); assert(site.choices.includes(after));
        const edit = api.replaceOperatorEdit(tree, site, after);
        assert.equal(apply(source, edit), expected);
        const updated = await parse(expected);
        assert(!flat(updated.root).some(n => n.kind === 'error'));
        assert(api.operatorSites(updated).some(s => s.text === after));
    }
    const tree = await parse('let^x = true^'), site = expressions.expressionSites(tree).find(s => s.kind === 'hat-ident');
    const change = expressions.replaceExpression(tree, site, 'not');
    const updated = await parse(apply(tree.source, change));
    assert(flat(updated.root).some(n => n.kind === 'unary'));
}));


test('qualified references, self members and computed receivers are constructed as real member ASTs', { timeout: 30000 }, async () => withLhatServer(async parse => {
    const tree = await parse('let^value = 0');
    const site = expressions.expressionSites(tree).find(s => s.kind === 'int');
    for (const reference of ['Item.new', 'self^.count', 'items.length^', 'values.0', '日本語.値']) {
        const change = expressions.replaceExpression(tree, site, `reference:${reference}`);
        assert(change, reference);
        const updated = await parse(apply(tree.source, change));
        assert.equal(updated.root.fields.items[0].fields.values[0].kind, 'member', reference);
    }
    for (const reference of ['a(); evil()', 'a\nb', 'a..b', 'if^', 'a[0]'])
        assert.equal(expressions.replaceExpression(tree, site, `reference:${reference}`), undefined);
    let updated = await parse('let^value = make()');
    const receiver = expressions.expressionSites(updated).find(s => s.kind === 'call');
    updated = await parse(apply(updated.source, expressions.replaceExpression(updated, receiver, 'member')));
    assert.equal(updated.source, 'let^value = (make()).value');
    const key = expressions.expressionSites(updated).find(s => s.memberKey);
    assert(key);
    const change = expressions.replaceExpression(updated, key, 'reference:count');
    updated = await parse(apply(updated.source, change));
    assert.equal(updated.source, 'let^value = (make()).count');
}));
