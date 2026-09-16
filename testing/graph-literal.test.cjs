const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
    const entry = path.resolve(__dirname, '../src/webview', file);
    const mod = new Module(entry);
    mod._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry);
    return mod.exports;
}
const { literalOf, isNumberLiteral } = load('literals.ts');
const { toElk } = load('map.ts');
const node = (kind, text, start = 0, fields) => ({ kind, start, end: start + text.length, line: 1, column: 1, fields });
const flatten = n => [n, ...(n.children ?? []).flatMap(flatten)];

test('numeric slots preserve precision, spelling, signs, bases, separators and exponents', () => {
    for (const text of ['0', '-0', '1234567890123456789', '1_000', '0xDEAD_BEEF', '-0b1010', '0o77', '1.25e-12', '+2E+4']) {
        assert(isNumberLiteral(text), text);
        assert.equal(literalOf(node(text[0] === '-' ? 'unary' : 'int', text), text).value, text);
    }
    for (const text of ['', '-', '.', '1.', '.5', '1e', 'NaN', 'Infinity', '0x', '0b2', '2 + 3', '12x', '1_.0', '1_', '_1']) {
        assert(!isNumberLiteral(text), text);
        assert.equal(literalOf(node('int', text), text), undefined);
    }
});

test('string slots show complete decoded content, including whitespace, raw strings, escapes and Unicode', () => {
    const cases = [
        ['""', ''], ['"  hello  "', '  hello  '], ['"日本語😀"', '日本語😀'],
        [String.raw`"a\n\t\r\0\"\\b"`, 'a\n\t\r\0"\\b'],
        [String.raw`"\u{1f600}\xE6\x97\xA5"`, '😀日'],
        [String.raw`"\u{feff}x"`, '\ufeffx'],
        ["'it''s C:\\temp'", "it's C:\\temp"], ["''''", "'"],
        ['"""raw \\n " text', 'raw \\n " text'],
        ['"first\r\nsecond"', 'first\nsecond'], ['"join\\\r\nlines"', 'joinlines'],
        ['"' + 'long '.repeat(40) + '"', 'long '.repeat(40)],
    ];
    for (const [source, value] of cases) assert.equal(literalOf(node('string', source), source)?.value, value, source);
});

test('nonliteral expressions, interpolations, names and undecodable binary strings stay labels', () => {
    for (const [kind, text] of [
        ['ident', '42'], ['binary', '1 + 2'], ['unary', '-value'], ['interp-string', '$"{x}"'],
        ['interp-text', 'hello'], ['string', 'id^name'], ['string', '"unterminated'],
        ['string', String.raw`"\q"`], ['string', String.raw`"\xFF"`], ['string', String.raw`"\u{d800}"`],
    ]) assert.equal(literalOf(node(kind, text), text), undefined, text);
});

test('literal slots are metadata on existing leaves; source, graph roles and full values are preserved', () => {
    const source = 'let^n = 42\nlet^s = "' + ' a  b '.repeat(20) + '"';
    const number = node('int', '42', source.indexOf('42'));
    const string = node('string', source.slice(source.indexOf('"')), source.indexOf('"'));
    const define = (name, value, start) => node('define', source.slice(start, value.end), start, {
        targets: [node('ident', name, start + 4)], values: [value],
    });
    const reply = { source, root: node('block', source, 0, { items: [define('n', number, 0), define('s', string, 11)] }) };
    const before = JSON.stringify(reply);
    for (const scale of [1, 2]) {
        const graph = toElk(reply, { collapse: false, scale });
        const slots = flatten(graph).filter(n => n.lhat?.literal);
        assert.equal(slots.length, 2);
        assert(slots.every(n => !n.children && n.lhat.definitionRole === 'value'));
        assert.equal(slots[1].lhat.literal.value, ' a  b '.repeat(20));
        assert.equal(slots[1].lhat.literal.key, `string:${string.start}:${string.end}`);
        assert(slots[1].width <= 400 * scale, 'long input stays inside a bounded box, with internal text scrolling');
    }
    assert.equal(JSON.stringify(reply), before, 'view edits must not modify the source AST');
});

test('multiline string leaves reserve bounded height while negative literals remain a single slot', () => {
    for (const source of ['"one\ntwo\nthree"', '-1.25']) {
        const kind = source[0] === '-' ? 'unary' : 'string';
        const graph = toElk({ source, root: node(kind, source) }, { scale: 1.5 });
        const slot = flatten(graph).find(n => n.lhat?.literal);
        assert(slot);
        assert.equal(slot.lhat.literal.kind, kind === 'unary' ? 'number' : 'string');
        assert.equal(slot.height, Math.round((kind === 'unary' ? 30 : 62) * 1.5));
    }
});
