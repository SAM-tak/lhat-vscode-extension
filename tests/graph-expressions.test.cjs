const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const entry = path.resolve(__dirname, '../src/graphExpressions.ts'), mod = new Module(entry);
mod._compile(require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
const { expressionSites, replaceExpression, expressionTemplates } = mod.exports;
const { operatorExpression } = require('./operator-fixture.cjs');

test('value replacement preserves other expressions and wraps operators to preserve grouping', () => {
    const tree = operatorExpression();
    const site = expressionSites(tree).find(s => tree.source.slice(s.start, s.end) === '3');
    for (const template of ['number', 'string', 'true', 'false', 'nil', 'table', 'function', 'procedure', 'call', 'index', 'add', 'not', 'negative', 'reference:other']) {
        const edit = replaceExpression(tree, site, template);
        assert.equal(edit.start, site.start); assert.equal(edit.end, site.end);
        assert(edit.text.length);
    }
    const change = replaceExpression(tree, site, 'call');
    assert.equal(tree.source.slice(0, change.start) + change.text + tree.source.slice(change.end), '(1 + 2) * (3)(nil^) + f(4) + (5 - 6)');
    assert.equal(replaceExpression(tree, site, 'reference:x; print(1)'), undefined);
    assert.equal(replaceExpression(tree, { ...site, end: site.end + 1 }, 'nil'), undefined);
    assert(expressionTemplates(tree, site).some(c => c.id === 'reference:f'));
});

test('declaration names and member keys cannot be replaced but default values can', () => {
    const source = 'let^ x = f^a = 1 { a }';
    const node = (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
    const tree = { source, root: node('define', source, {
        targets: [node('ident', 'x')], values: [node('func', 'f^a = 1 { a }', {
            params: [node('param', 'a = 1', { name: node('ident', 'a'), value: node('int', '1') })],
            body: node('block', '{ a }', { items: [node('ident', 'a', undefined, source.indexOf('{'))] }),
        })],
    }) };
    const sites = expressionSites(tree);
    assert(!sites.some(s => s.start === source.indexOf('x')));
    assert(!sites.some(s => s.start === source.indexOf('a')));
    assert(sites.some(s => s.start === source.indexOf('1')));
    assert(sites.some(s => s.start === source.lastIndexOf('a')));
    assert.deepEqual(expressionSites({ ...tree, root: { ...tree.root, kind: 'disabled' } }), []);
});

test('quoted names keep dots, pipes and escaped backticks inside one reference segment', () => {
    const { validReference, validMember, validExpressionReference } = mod.exports;
    for (const name of ['`a b`','`a``b`','obj.`a.b`','`a|b`.`c,d`','self^.`count value`','$obj.`a b`'])
        assert(validReference(name), name);
    for (const name of ['``','`open','`a\nb`','`a`^','$`a b`','obj.','`a` ; print(1)','obj..`a b`'])
        assert(!validReference(name), name);
    assert(validMember('`a.b`'));
    assert(validExpressionReference({ errorName:true }, '`problem name`.`bad|state`'));
    assert(validExpressionReference({ delegateName:true }, 'self^.`field.name`'));
    assert(!validExpressionReference({ delegateName:true }, 'obj.`field.name`'));
    const tree = operatorExpression(), site = expressionSites(tree).find(s => tree.source.slice(s.start,s.end) === '3');
    assert.equal(replaceExpression(tree, site, 'reference:`a.b`').text, '`a.b`');
    assert.equal(replaceExpression(tree, site, 'reference:`a` ; print(1)'), undefined);
    const { quoteName, nameValue } = require('./graph-browser-host.cjs').load('graphNames.ts');
    for (const value of ['plain','a b','a`b','`a`','a.b','a|b','123']) assert.equal(nameValue(quoteName(value)), value);
    for (const value of ['', 'a\nb']) assert.equal(quoteName(value), undefined);

});
