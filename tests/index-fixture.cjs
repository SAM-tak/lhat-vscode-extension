function indexExpression({ targetCall = false, indexCall = false, simple = false, optional = false, empty = false, multi = false } = {}) {
    const targetText = targetCall ? 'make()' : 'dense';
    const argumentText = empty ? '' : indexCall ? 'position()' : simple ? 'i' : 'dense.length^ - 1';
    const source = `${targetText}${optional ? '?' : ''}[${argumentText}${multi ? ', 2' : ''}]`;
    const from = source.indexOf('[') + 1;
    const n = (kind, text, fields, at = 0, extra = {}) => {
        const start = source.indexOf(text, at);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const call = (name, type) => n('call', `${name}()`, { target: n('ident', name), argument: [] }, 0,
        { inferredType: type, callable: { inputs: [], outputs: [type] } });
    const target = targetCall ? call('make', 't^{...:number^}') : n('ident', 'dense', undefined, 0, { inferredType: 't^{...:number^}' });
    let argument;
    if (!empty) argument = indexCall ? call('position', 'number^') : simple ? n('ident', 'i', undefined, from, { inferredType: 'number^' })
        : n('binary', argumentText, {
            left: n('member', 'dense.length^', { target: n('ident', 'dense', undefined, from), argument: n('hat-ident', 'length^') }, from, { inferredType: 'number^' }),
            right: n('int', '1', undefined, from, { inferredType: 'number^' }),
        }, from, { inferredType: 'number^' });
    return { source, root: n('index', source, { target, argument: [...argument ? [argument] : [],
        ...multi ? [n('int', '2', undefined, from, { inferredType: 'number^' })] : []] }, 0, { inferredType: 'number^' }) };
}
module.exports = { indexExpression };
