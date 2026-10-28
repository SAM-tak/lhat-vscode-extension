function conditionalExpressions() {
    const source = 'if^check(value) = 1 { accept() }\nlet^choice = if^value > 0: 1 el^: 2 ;';
    const n = (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const checking = n('call', 'check(value)', { target: n('ident', 'check'), argument: [n('ident', 'value')] }, 0,
        { callable: { inputs: [{ name: 'value', type: 'number^' }], outputs: ['number^'] } });
    const condition = n('binary', 'check(value) = 1', { left: checking, right: n('int', '1') }, 0, { inferredType: 'bool^' });
    const accepted = n('call', 'accept()', { target: n('ident', 'accept'), argument: [] }, 0,
        { callable: { inputs: [], outputs: [] } });
    const statement = n('if-stmt', source.split('\n')[0], { items: [
        n('if-clause', 'check(value) = 1 { accept() }', { condition,
            body: n('block', '{ accept() }', { items: [{ ...accepted, kind: 'call-stmt', fields: { value: accepted } }] }) }),
    ] });
    const at = source.indexOf('if^value');
    const predicate = n('binary', 'value > 0', { left: n('ident', 'value', undefined, at), right: n('int', '0', undefined, at) }, at,
        { inferredType: 'bool^' });
    const expression = n('if-expr', source.slice(at), { items: [
        n('if-clause', 'if^value > 0: 1', { condition: predicate, body: n('int', '1', undefined, at) }, at),
        n('if-clause', 'el^: 2', { body: n('int', '2', undefined, at) }, at),
    ] }, at, { inferredType: 'number^' });
    const binding = n('define', source.split('\n')[1], { targets: [n('ident', 'choice')], values: [expression] });
    return { source, root: n('block', source, { items: [statement, binding] }) };
}
function branchFlow({ otherwise = false, next = false, empty = false } = {}) {
    const body = empty ? '{ }' : '{ print("ok") }';
    const branchText = `if^true^ ${body}` + (otherwise ? ' el^: { print("else") }' : '');
    const source = branchText + (next ? '\nprint("next")' : '');
    const n = (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
    const print = text => {
        const at = source.indexOf(text), value = n('call', text, {
            target: n('ident', 'print', undefined, at), argument: [n('string', text.slice(6, -1), undefined, at)],
        });
        value.callable = { inputs: [{ name: 'value', type: 'string^' }], outputs: [] };
        return { ...value, kind: 'call-stmt', fields: { value }, callable: undefined };
    };
    const clauses = [n('if-clause', `if^true^ ${body}`, {
        condition: n('hat-ident', 'true^'), body: n('block', body, { items: empty ? [] : [print('print("ok")')] }),
    })];
    if (otherwise) clauses.push(n('if-clause', 'el^: { print("else") }', {
        body: n('block', '{ print("else") }', { items: [print('print("else")')] }),
    }));
    const statement = n('if-stmt', branchText, { items: clauses });
    return { source, root: n('block', source, { items: [statement, ...next ? [print('print("next")')] : []] }) };
}
function terminalFlow({ panic = false, trailing = false, branch = 'none', disabled = false } = {}) {
    const ending = panic ? 'panic^"stop"' : 'return^1';
    const arm = `{ ${ending} }`;
    let text = branch === 'none' ? ending : `if^true^ ${arm}` + (branch === 'all' ? ` el^: ${arm}` : '');
    if (disabled) text = `#[~ ${text} ]#`;
    const source = `p^{ ${text}${trailing ? '\nprint("after")' : ''} }`;
    const n = (kind, text, fields, from = 0) => {
        const start = source.indexOf(text, from);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields };
    };
    const terminal = from => n(panic ? 'panic' : 'return', ending, {
        value: [n(panic ? 'string' : 'int', panic ? '"stop"' : '1', undefined, from)],
    }, from);
    let first = terminal(0);
    if (branch !== 'none') {
        const clauses = [n('if-clause', `if^true^ ${arm}`, {
            condition: n('hat-ident', 'true^'), body: n('block', arm, { items: [first] }),
        })];
        if (branch === 'all') {
            const from = source.indexOf('el^:');
            clauses.push(n('if-clause', `el^: ${arm}`, { body: n('block', arm, { items: [terminal(from)] }, from) }));
        }
        const branchText = `if^true^ ${arm}` + (branch === 'all' ? ` el^: ${arm}` : '');
        first = n('if-stmt', branchText, { items: clauses });
    }
    if (disabled) first = n('disabled', text, { items: [first] });
    const items = [first];
    if (trailing) {
        const value = n('call', 'print("after")', { target: n('ident', 'print'), argument: [n('string', '"after"')] });
        value.callable = { inputs: [{ name: 'value', type: 'string^' }], outputs: [] };
        items.push({ ...value, kind: 'call-stmt', fields: { value }, callable: undefined });
    }
    return { source, root: n('func', source, { body: n('block', source.slice(2), { items }) }) };
}
module.exports = { conditionalExpressions, branchFlow, terminalFlow };
