function patternMatching({ expression = false, defaultArm = true } = {}) {
    const patterns = ['threshold(1) + 2', '3'];
    const values = expression ? ['10', '20', '30'] : ['print("first")', 'print("second")', 'print("other")'];
    const armTexts = patterns.map((pattern, i) => `when^ ${pattern}: ${values[i]}`);
    if (defaultArm) armTexts.push(`other^: ${values[2]}`);
    const bodyText = expression ? `: ${armTexts.join(' ')} ;` : `{ ${armTexts.join(' ')} }`;
    const source = `for^ subject${expression ? '' : ' '}${bodyText}`;
    const n = (kind, text, fields, from = 0, extra = {}) => {
        const start = source.indexOf(text, from);
        if (start < 0) throw Error(text);
        return { kind, start, end: start + text.length, line: 1, column: start + 1, fields, ...extra };
    };
    const call = n('call', 'threshold(1)', { target: n('ident', 'threshold'), argument: [n('int', '1')] }, 0,
        { callable: { inputs: [{ name: 'value', type: 'number^' }], outputs: ['number^'] } });
    const conditions = [n('binary', patterns[0], { left: call, right: n('int', '2', undefined, source.indexOf('+')) }, 0,
        { inferredType: 'number^' }), n('int', '3', undefined, source.indexOf('when^ 3'))];
    const arms = armTexts.map((text, i) => {
        const start = source.indexOf(text);
        let body;
        if (expression) body = n('int', values[i], undefined, start);
        else {
            const at = source.indexOf(values[i], start);
            const value = n('call', values[i], { target: n('ident', 'print', undefined, at),
                argument: [n('string', values[i].slice(6, -1), undefined, at)] }, at,
            { callable: { inputs: [{ name: 'value', type: 'string^' }], outputs: [] } });
            body = n('block', values[i], { items: [{ ...value, kind: 'call-stmt', fields: { value }, callable: undefined }] }, at);
        }
        return n('if-clause', text, { ...(i < conditions.length ? { condition: conditions[i] } : {}), body }, start);
    });
    const root = n('for', source, {
        focus: [n('define', 'subject', { targets: [n('focus (it^)', 'subject')], values: [n('ident', 'subject')] })],
        body: n(expression ? 'if-expr' : 'if-stmt', bodyText, { items: arms }),
    });
    return { source, root };
}
module.exports = { patternMatching };
