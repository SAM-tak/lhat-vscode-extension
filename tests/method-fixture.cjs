function methodCall({ receiver = 'dense', explicit = false, plain = false, noArgs = false, legacy = false, procedure = false } = {}) {
    const args = noArgs ? '' : '-1';
    const source = explicit ? `remove(${receiver}${args ? ', ' + args : ''})` : `${receiver}.Remove(${args})`;
    const n = (kind, text, fields, extra = {}) => {
        const start = source.indexOf(text);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const value = receiver === 'make()' ? n('call', receiver, { target: n('ident', 'make'), argument: [] },
        { inferredType: 'Dense', callable: { inputs: [], outputs: ['Dense'], signature: 'f^ -> Dense;' } })
        : receiver === '(1 + 2)' ? n('binary', '1 + 2', { left: n('int', '1'), right: n('int', '2') }, { inferredType: 'number^' })
        : n(receiver.startsWith('"') ? 'string' : /^\d/.test(receiver) ? 'int' : receiver.endsWith('^') ? 'hat-ident' : 'ident', receiver,
            undefined, { inferredType: 'Dense' });
    const signature = `${procedure ? 'p^' : 'f^'}${plain ? '' : 'mutable^self^' + (args ? ', ' : '')}${args ? 'number^' : ''}${procedure ? '' : ' -> number^ | nil^'};`;
    const target = explicit ? n('ident', 'remove', undefined, { inferredType: signature })
        : n('member', `${receiver}.Remove`, { target: value, argument: n('ident', 'Remove') }, { inferredType: signature });
    const argument = [...explicit ? [value] : [], ...args ? [n('unary', '-1', undefined, { inferredType: 'number^' })] : []];
    const root = n('call', source, { target, argument }, { inferredType: procedure ? '-' : 'number^ | nil^' });
    if (!legacy) root.callable = { inputs: [...explicit && !plain ? [{ type: 'Dense', name: 'self^' }] : [],
        ...args ? [{ type: 'number^', name: 'index' }] : []], outputs: procedure ? [] : ['number^ | nil^'], signature };
    return { source, root };
}
function boundSlice() {
    const source = 'values.slice^(1, 2)';
    const n = (kind, text, fields, extra = {}) => ({ kind, start: source.indexOf(text),
        end: source.indexOf(text) + text.length, line: 1, column: 1, fields, ...extra });
    const type = 't^{...:number^}', signature = `f^number^, number^ -> fresh^${type};`;
    const target = n('member', 'values.slice^', { target: n('ident', 'values', undefined, { inferredType: type }),
        argument: n('hat-ident', 'slice^') }, { inferredType: signature });
    return { source, root: n('call', source, { target, argument: [n('int', '1'), n('int', '2')] }, {
        inferredType: type, callable: { inputs: [{ type: 'number^' }, { type: 'number^' }], outputs: [type], signature,
            receiver: { binding: 'member', type } },
    }) };
}
module.exports = { methodCall, boundSlice };
