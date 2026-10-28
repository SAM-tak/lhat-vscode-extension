function branchedCalls() {
    const source = 'expect(left(a), right(b), "a wider trailing label")\ndone()';
    const node = (kind, text, fields, extra = {}) => {
        const start = source.indexOf(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const call = (name, text, args, outputs, inputs) => node('call', text,
        { target: node('ident', name), argument: args },
        { callable: { inputs: inputs ?? args.map(() => ({ type: 'number^', name: 'x' })), outputs } });
    const first = call('expect', source.split('\n')[0], [
        call('left', 'left(a)', [node('ident', 'a)', undefined, { inferredType: 'number^' })], ['number^']),
        call('right', 'right(b)', [node('ident', 'b)', undefined, { inferredType: 'number^' })], ['number^']),
        node('string', '"a wider trailing label"', undefined, { inferredType: 'string^' }),
    ], [], [{ name: 'condition', type: 'number^' }, { name: 'other', type: 'number^' }, { name: 'label', type: 'string^' }]);
    // The closing parenthesis disambiguates these letters from function names.
    first.fields.argument.slice(0, 2).forEach(call => call.fields.argument[0].end--);
    const last = call('done', 'done()', [], []);
    const statement = value => ({ ...value, kind: 'call-stmt', fields: { value }, callable: undefined });
    return { source, root: node('block', source, { items: [statement(first), statement(last)] }) };
}
module.exports = { branchedCalls };
