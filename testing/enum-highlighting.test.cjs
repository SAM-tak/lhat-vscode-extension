const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Registry, INITIAL, parseRawGrammar } = require('vscode-textmate');
const { loadWASM, OnigScanner, OnigString } = require('vscode-oniguruma');

const grammarPath = path.resolve(__dirname, '../syntaxes/lhat.tmLanguage.json');
const grammar = (async () => {
    await loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')));
    const registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: patterns => new OnigScanner(patterns),
            createOnigString: source => new OnigString(source),
        }),
        loadGrammar: async scope => scope === 'source.lhat'
            ? parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath) : null,
    });
    return registry.loadGrammar('source.lhat');
})();

async function tokenize(source) {
    const syntax = await grammar;
    let stack = INITIAL;
    return source.split(/\r?\n/).flatMap((line, lineNumber) => {
        const result = syntax.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return result.tokens.map(t => ({
            text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes, line: lineNumber,
        }));
    });
}
const withScope = (tokens, scope) => tokens.filter(t => t.scopes.includes(scope)).map(t => t.text);

test('enum keyword, declaration name, members and values receive separate scopes', async () => {
    const tokens = await tokenize(fs.readFileSync(path.join(__dirname, 'enum.lh'), 'utf8'));
    assert(withScope(tokens, 'keyword.other.declaration.lhat').includes('enum'));
    assert(withScope(tokens, 'punctuation.definition.hat.lhat').includes('^'));
    assert.deepEqual(withScope(tokens, 'entity.name.type.enum.lhat'), ['Mode']);
    assert.deepEqual(withScope(tokens, 'variable.other.enummember.lhat'), ['Idle', 'Walk', 'Dash', 'Label', 'Data']);
    assert(withScope(tokens, 'constant.numeric.integer.lhat').includes('10'));
    assert(withScope(tokens, 'string.quoted.double.lhat').includes('dash'));
    assert(tokens.filter(t => t.line === 11).every(t => !t.scopes.includes('meta.enum.lhat')), 'enum context ends at its closing brace');
});

test('nested initializer groups, comments, strings and references are not enum declarations', async () => {
    const source = [
        'enum^Payload {',
        '  Nested = make({ key = "},fake", values = [first, second] }, (1, 2)),',
        '  #[ ignored enum^Ghost { Nope } ]#',
        '  Text = "enum^Fake { Hidden }",',
        '  Last, # a closing brace } in a comment',
        '}',
        'let^owner = Payload.Last.enum^',
        'let^next = 42',
        '# enum^Commented { Invisible }',
    ].join('\n');
    const tokens = await tokenize(source);
    assert.deepEqual(withScope(tokens, 'entity.name.type.enum.lhat'), ['Payload']);
    assert.deepEqual(withScope(tokens, 'variable.other.enummember.lhat'), ['Nested', 'Text', 'Last']);
    assert(tokens.filter(t => t.line >= 6).every(t => !t.scopes.includes('meta.enum.lhat')));
});

test('multiline headers, Unicode names and backtick names remain enum declarations', async () => {
    const tokens = await tokenize('public^enum^ # header comment\n状態 { 待機, `with space` = "x", }\nenum^`Other Enum` { Entry }');
    assert.deepEqual(withScope(tokens, 'entity.name.type.enum.lhat'), ['状態', '`Other Enum`']);
    assert.deepEqual(withScope(tokens, 'variable.other.enummember.lhat'), ['待機', '`with space`', 'Entry']);
});
