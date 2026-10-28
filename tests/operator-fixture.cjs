function operatorExpression() {
    const source = '(1 + 2) * 3 + f(4) + (5 - 6)';
    const n = (kind, text, fields) => {
        const start = source.indexOf(text);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, inferredType: 'number^' };
    };
    const number = text => n('int', text);
    const sum = n('binary', '1 + 2', { left: number('1'), right: number('2') });
    const product = n('binary', '(1 + 2) * 3', { left: sum, right: number('3') });
    const call = n('call', 'f(4)', { target: n('ident', 'f'), argument: [number('4')] });
    call.callable = { inputs: [{ name: 'x', type: 'number^' }], outputs: ['number^'] };
    const left = n('binary', '(1 + 2) * 3 + f(4)', { left: product, right: call });
    const right = n('binary', '5 - 6', { left: number('5'), right: number('6') });
    return { source, root: n('binary', source, { left, right }) };
}
module.exports = { operatorExpression };
