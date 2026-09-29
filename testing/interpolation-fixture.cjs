function interpolation() {
    const source = '$"text1{v1 + 2}text2{v2}"';
    const n = (kind, text, fields, inferredType) => {
        const start = source.indexOf(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, inferredType };
    };
    const left = n('ident', 'v1', undefined, 'number^'), right = n('int', '2', undefined, 'number^');
    const sum = n('binary', 'v1 + 2', { left, right }, 'number^');
    const root = n('interp', source, { items: [n('interp-text', 'text1'),
        n('interp-hole', '{v1 + 2}', { value: sum }), n('interp-text', 'text2'),
        n('interp-hole', '{v2}', { value: n('ident', 'v2', undefined, 'number^') })] }, 'string^');
    return { source, root };
}
function nestedInterpolation() {
    const source = '$"{caps[0] ?? ""}: {caps[1] ?? ""}"';
    const n = (kind, start, end, fields, inferredType) => ({ kind, start, end, fields, inferredType, line: 1, column: start + 1 });
    const hole = index => {
        const start = source.indexOf(`{caps[${index}]`), at = start + 1;
        const end = source.indexOf('}', start) + 1;
        const value = n('index', at, at + 7, { target: n('ident', at, at + 4, undefined, 't^'),
            argument: [n('int', at + 5, at + 6, undefined, 'number^')] }, 'string^ or^ nil^');
        return n('interp-hole', start, end, { value: n('binary', at, end - 1,
            { left: value, right: n('string', end - 3, end - 1, undefined, 'string^') }, 'string^') });
    };
    const first = hole(0), second = hole(1);
    return { source, root: n('interp', 0, source.length, { items: [first,
        n('interp-text', first.end, second.start), second] }, 'string^') };
}
module.exports = { interpolation, nestedInterpolation };
