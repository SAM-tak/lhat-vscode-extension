import { syntaxTokens } from "./graphSyntax";

const plain = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const quoted = /^`(?:[^`\r\n\0]|``)+`$/u;
export const validName = (text: string) => plain.test(text) || quoted.test(text);
export const validMemberName = (text: string) => /^[\p{L}_][\p{L}\p{N}_]*\^?$/u.test(text) || quoted.test(text);
export const validSymbolName = (text: string) => /^[\p{L}_][\p{L}\p{N}_]*\^*$/u.test(text) || quoted.test(text);

/** Dots inside a quoted name are content, not path separators. */
export function nameSegments(text: string): string[] | undefined {
    const tokens = syntaxTokens(text);
    if (!tokens.length || tokens.length % 2 === 0 || tokens.map(t => t.text).join("") !== text ||
        tokens.some((token, i) => i % 2 === 1 && token.text !== ".")) return;
    return tokens.filter((_, i) => i % 2 === 0).map(token => token.text);
}

export const validNamePath = (text: string) => nameSegments(text)?.every(validName) ?? false;
export function quoteName(value: string): string | undefined {
    if (!value || /[\r\n\0]/.test(value)) return;
    return plain.test(value) ? value : "`" + value.replace(/`/g, "``") + "`";
}

export const nameValue = (spelling: string) => quoted.test(spelling)
    ? spelling.slice(1, -1).replace(/``/g, "`") : spelling;

export const sourceNames = (source: string) => new Set(syntaxTokens(source).map(token => nameValue(token.text)));
export const sameName = (left: string, right: string) => validName(left) && validName(right)
    ? nameValue(left) === nameValue(right) : left === right;
