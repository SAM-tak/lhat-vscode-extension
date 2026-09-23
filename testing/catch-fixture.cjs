function catchFlow({ mainTerminal = false, handlerTerminal = false, callable = false } = {}) {
    const main = mainTerminal ? 'return^' : 'work()';
    const last = handlerTerminal ? 'return^' : 'print("other")';
    const block = `do^{\n${main}\ncatch^IOError.Eof:\nprint("eof")\ncatch^:\n${last}\n}`;
    const source = callable ? `p^{\n${block}\nafter()\n}` : `${block}\nafter()`;
    const n = (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: source.slice(0, start).split('\n').length,
            column: 1, fields };
    };
    const statement = (text, from = 0) => {
        if (text === 'return^') return n('return', text, { value: [] }, from);
        const start = source.indexOf(text, from), name = text.slice(0, text.indexOf('('));
        const argument = text.slice(text.indexOf('(') + 1, -1);
        const value = n('call', text, { target: n('ident', name, undefined, start),
            argument: argument ? [n('string', argument, undefined, start)] : [] }, start);
        value.callable = { inputs: argument ? [{ name: 'text', type: 'string^' }] : [], outputs: [] };
        return { ...value, kind: 'call-stmt', fields: { value }, callable: undefined };
    };
    const arms = [n('if-clause', 'catch^IOError.Eof:\nprint("eof")', {
        condition: n('member', 'IOError.Eof', { target: n('ident', 'IOError'), key: n('ident', 'Eof') }),
        body: n('block', 'print("eof")', { items: [statement('print("eof")')] }),
    }), n('if-clause', `catch^:\n${last}`, {
        body: n('block', last, { items: [statement(last, source.indexOf('catch^:'))] }, source.indexOf('catch^:')),
    })];
    const handled = n('block', block, { items: [statement(main)], arms });
    const items = [handled, statement('after()')];
    const root = callable ? n('func', source, { body: n('block', source.slice(2), { items }) })
        : n('block', source, { items });
    return { source, root };
}
module.exports = { catchFlow };
