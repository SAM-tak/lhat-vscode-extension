function assignment(operator = ':=', { lowered = false, comments = false } = {}) {
    const source = `a, b ${comments ? '#[ := += 日本語 ]# ' : ''}${operator} 1, 2`;
    const n = (kind, text, from = 0) => {
        const start = source.indexOf(text, from);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, inferredType: 'number^' };
    };
    const targets = [n('ident', 'a'), n('ident', 'b')];
    const at = source.lastIndexOf(operator) + operator.length;
    const written = [n('int', '1', at), n('int', '2', at)];
    const values = lowered && !operator.endsWith(':=') ? written.map((right, i) => ({
        kind: 'binary', start: targets[i].start, end: right.end, line: 1, column: targets[i].column,
        inferredType: 'number^', fields: { left: { ...targets[i] }, right },
    })) : written;
    return { source, root: { kind: 'reassign', start: 0, end: source.length, line: 1, column: 1, fields: { targets, values } } };
}
module.exports = { assignment };
