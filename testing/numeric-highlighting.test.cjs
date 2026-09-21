const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Registry, parseRawGrammar } = require('vscode-textmate');
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

async function tokens(source) {
    return (await grammar).tokenizeLine(source).tokens.map(token => ({
        text: source.slice(token.startIndex, token.endIndex), scopes: token.scopes,
    }));
}
const scoped = (tokens, scope) => tokens.filter(token => token.scopes.includes(scope)).map(token => token.text);

test('zero-based dot members stay integer keys, including chained and optional access', async () => {
    for (const source of ['a.0.0', 'a. 0 . 0', 'a?.0.0', '$"{a.0.0}"']) {
        const result = await tokens(source);
        assert.deepEqual(scoped(result, 'constant.numeric.integer.lhat'), ['0', '0'], source);
        assert.deepEqual(scoped(result, 'constant.numeric.float.lhat'), [], source);
    }
    const optional = await tokens('a?.0.0');
    assert.deepEqual(scoped(optional, 'keyword.operator.nil-propagation.lhat'), ['?.']);
    assert.deepEqual(scoped(optional, 'punctuation.accessor.lhat'), ['.']);
});

test('dot member recognition preserves decimals, concatenation, varargs and type counts', async () => {
    const result = await tokens('0.25 1.0e-3 1..2.5 ...[0] t[-1] t.length^ - 1 number^[9]');
    assert.deepEqual(scoped(result, 'constant.numeric.float.lhat'), ['0.25', '1.0e-3', '2.5']);
    assert.deepEqual(scoped(result, 'constant.numeric.integer.lhat'), ['1', '0', '1', '1', '9']);
    assert.deepEqual(scoped(result, 'keyword.operator.concat.lhat'), ['..']);
    assert.deepEqual(scoped(result, 'keyword.operator.spread.lhat'), ['...']);
    assert.deepEqual(scoped(await tokens('"a.0.0" # a.0.0'), 'constant.numeric.integer.lhat'), []);
});
