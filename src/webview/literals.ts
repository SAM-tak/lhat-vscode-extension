import type { AstNode } from "../protocol";

/** An editable display value, not a serializer or an AST mutation. */
export interface LiteralValue {
    key: string;
    kind: "number" | "string";
    value: string;
}

// Keep the spelling: Number() would lose large integers, bases and separators.
const digits = "[0-9](?:[0-9_]*[0-9])?";
const numberPattern = new RegExp(`^[+-]?(?:0[xX][0-9a-fA-F](?:[0-9a-fA-F_]*[0-9a-fA-F])?` +
    `|0[bB][01](?:[01_]*[01])?|0[oO][0-7](?:[0-7_]*[0-7])?` +
    `|${digits}(?:\\.${digits})?(?:[eE][+-]?${digits})?)$`);

export const isNumberLiteral = (value: string): boolean => numberPattern.test(value);

/** Read only whole string literals, never interpolation fragments or id^ names. */
function stringValue(source: string): string | undefined {
    const text = source.replace(/\r\n?/g, "\n");
    if (text.startsWith('"""')) return text.slice(3);
    if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
    if (!text.startsWith('"') || !text.endsWith('"')) return undefined;
    const body = text.slice(1, -1);
    const encoder = new TextEncoder();
    const bytes: number[] = [];
    const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "0": "\0", "\\": "\\", '"': '"' };
    for (let i = 0; i < body.length;) {
        if (body[i] === '"') return undefined;
        if (body[i] !== "\\") {
            const character = String.fromCodePoint(body.codePointAt(i)!);
            bytes.push(...encoder.encode(character));
            i += character.length;
            continue;
        }
        const escape = body[++i];
        if (escape === "\n") { i++; continue; }
        if (escapes[escape] !== undefined) {
            bytes.push(...encoder.encode(escapes[escape]));
            i++;
        } else if (escape === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
            bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
            i += 3;
        } else if (escape === "u") {
            const match = /^u\{([0-9a-fA-F]+)\}/.exec(body.slice(i));
            if (match === null) return undefined;
            const code = parseInt(match[1], 16);
            if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
            bytes.push(...encoder.encode(String.fromCodePoint(code)));
            i += match[0].length;
        } else return undefined;
    }
    // Arbitrary binary strings cannot be represented losslessly in a textbox.
    // Leave those as source labels instead of silently replacing bad bytes.
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes)); }
    catch { return undefined; }
}

export function literalOf(node: AstNode, source: string): LiteralValue | undefined {
    const text = source.slice(node.start, node.end);
    const numeric = node.kind === "int" || node.kind === "float" || node.kind === "unary";
    const value = numeric ? isNumberLiteral(text) ? text : undefined
        : node.kind === "string" ? stringValue(text) : undefined;
    if (value === undefined) return undefined;
    return { key: `${node.kind}:${node.start}:${node.end}`, kind: numeric ? "number" : "string", value };
}
