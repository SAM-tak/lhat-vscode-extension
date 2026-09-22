import type { SourceSpan } from "./protocol";

export interface SyntaxToken extends SourceSpan { text: string }

/** Source punctuation, without mistaking strings or nested comments for separators. */
export function syntaxTokens(source: string, start = 0, end = source.length): SyntaxToken[] {
    const tokens: SyntaxToken[] = [];
    for (let i = start; i < end;) {
        if (/\s/u.test(source[i])) { i++; continue; }
        if (source.startsWith("#[", i)) {
            let depth = 1; i += 2;
            while (i < end && depth) {
                if (source.startsWith("#[", i)) { depth++; i += 2; }
                else if (source.startsWith("]#", i)) { depth--; i += 2; }
                else i++;
            }
            continue;
        }
        if (source[i] === "#") { while (i < end && source[i] !== "\n") i++; continue; }
        const from = i;
        if (source.startsWith('"""', i)) {
            while (i < end && source[i] !== "\n") i++;
        } else if ('"\'`'.includes(source[i])) {
            const quote = source[i++];
            while (i < end) {
                if (quote === '"' && source[i] === "\\") { i += 2; continue; }
                if (source[i++] === quote) {
                    if (quote !== '"' && source[i] === quote) { i++; continue; }
                    break;
                }
            }
        } else {
            const word = /^[\p{L}\p{N}_]+\^*|^(?:\??(?::=|(?:\.\.|\*\*|\/\/|[+\-*/%])=)|->|\.\.\.|\.\.|\*\*|\/\/|==|!=|<=|>=|&&|\|\||\?\?)/u.exec(source.slice(i, end))?.[0];
            i += word?.length ?? 1;
        }
        tokens.push({ start: from, end: i, text: source.slice(from, i) });
    }
    return tokens;
}

/** Type formatter tuples are parenthesized; callable signatures close at ';'. */
export function resultTypes(text: string | undefined): string[] {
    if (!text || text === "?" || text === "-") return text === "-" ? [] : ["?"];
    const tokens = syntaxTokens(text);
    let from = 0, to = text.length;
    if (tokens[0]?.text === "(") {
        let depth = 0, closes = -1;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text === "(") depth++;
            if (tokens[i].text === ")" && --depth === 0) { closes = i; break; }
        }
        if (closes === tokens.length - 1) { from = tokens[0].end; to = tokens[closes].start; }
    }
    const parts: string[] = [], stack: string[] = [];
    let at = from;
    for (const token of tokens.filter(t => t.start >= from && t.end <= to)) {
        if (["(", "{", "[", "f^", "p^"].includes(token.text)) stack.push(token.text);
        else if ([")", "}", "]", ";"].includes(token.text)) stack.pop();
        else if (token.text === "," && !stack.length) { parts.push(text.slice(at, token.start).trim()); at = token.end; }
    }
    parts.push(text.slice(at, to).trim());
    return parts;
}
