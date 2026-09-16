import type { AstNode, SourceSpan, TypeSite } from "../protocol";
import { typeSites } from "../graphTypes";
import { HATS, type LabelCategory } from "./vocabulary";

export type LabelRole = "constant" | "variable" | "string" | "number";
export type Vocabulary = Record<LabelRole, string> & {
    hats?: Record<string, string>; outer?: string; levels?: string; tableDefinition?: string;
};
export const ENGLISH_VOCABULARY: Vocabulary = {
    constant: "Define constant", variable: "Define variable", string: "Text", number: "Number",
    hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, entry.text])),
    outer: "Outer {0}: {1}", levels: "{0} ({1} levels)",
    tableDefinition: "Table type definition",
};
export interface RenameTarget { start: number; end: number; value: string }
export const renameTargetKey = (name: RenameTarget): string => `${name.start}:${name.end}`;
/** Shared by the input and graph layout so their minimum/Unicode widths agree. */
export const nameColumns = (value: string): number => Math.max(3, labelColumns(value));
export interface LabelPart { text: string; role?: string; category?: LabelCategory; source?: string; name?: RenameTarget; symbol?: SourceSpan; typeSite?: TypeSite; typeLabel?: string }
export interface DisplayLabel { text: string; parts: LabelPart[] }
interface Token { start: number; end: number; word?: string; depth?: number; name?: RenameTarget; tableDefinition?: boolean; symbol?: SourceSpan }

/** Conservative monospace columns: CJK/full-width glyphs do not fit in one Latin cell. */
export function labelColumns(text: string): number {
    return Array.from(text).reduce((width, ch) => width + (
        /[\p{Mark}\u200d\ufe0f]/u.test(ch) ? 0
            : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6\p{Extended_Pictographic}]/u.test(ch) ? 2 : 1), 0);
}

function children(node: AstNode): AstNode[] {
    return Object.values(node.fields ?? {}).flatMap((child) => Array.isArray(child) ? child : [child]);
}

/** Lexical boundaries plus AST spans protect comments, literals and user names. */
function semanticTokens(source: string, root: AstNode): Token[] {
    const tokens: Token[] = [];
    const protectedSpans: { start: number; end: number }[] = [];
    const declaredHats = new Set<string>();
    const tableDefinitions = new Set<number>();
    const symbols = new Map<number, SourceSpan>();
    const protectName = (node: AstNode | AstNode[] | undefined) => {
        if (node === undefined || Array.isArray(node)) return;
        protectedSpans.push(node);
        if (source.slice(node.start, node.end).endsWith("^")) declaredHats.add(source.slice(node.start, node.end));
    };
    const visit = (node: AstNode) => {
        // Literal contents are not name uses. Disabled code has no live bindings.
        if (node.kind === "disabled") return;
        if (node.kind === "ident" || node.kind === "hat-ident") {
            const text = source.slice(node.start, node.end);
            if (/^[\p{L}_][\p{L}\p{N}_]*\^*$/u.test(text) || /^`(?:[^`]|``)+`$/u.test(text)) {
                symbols.set(node.start, { start: node.start, end: node.end });
            }
        }
        // The definition's keyword starts a DEF node. References such as
        // def^.foo (even inside that definition) are separate HAT_IDENTs.
        if (node.kind === "def") tableDefinitions.add(node.start);
        if (node.kind === "string") { protectedSpans.push(node); return; }
        if (["table-entry", "param", "enumdef", "errordef", "error-kind"].includes(node.kind)) {
            const name = node.fields?.name ?? node.fields?.key;
            // A method's explicit receiver is a language-provided binding,
            // not a user declaration shadowing every self^ in this file.
            if (!(node.kind === "param" && name && !Array.isArray(name) &&
                /^self\^+$/.test(source.slice(name.start, name.end)))) protectName(name);
        }
        if (node.kind === "define") {
            const targets = node.fields?.targets;
            for (const target of Array.isArray(targets) ? targets : targets ? [targets] : []) {
                const name = target.fields?.name ?? target;
                if (Array.isArray(name)) continue;
                const value = source.slice(name.start, name.end);
                if ((name.kind === "ident" || name.kind === "hat-ident") && /^[\p{L}_][\p{L}\p{N}_]*\^*$/u.test(value)) {
                    const span = { start: name.start, end: name.end, value };
                    tokens.push({ ...span, name: span });
                    protectName(name);
                }
            }
        }
        children(node).forEach(visit);
    };
    visit(root);
    protectedSpans.sort((a, b) => a.start - b.start);
    let protectedIndex = 0;
    for (let i = 0; i < source.length;) {
        while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].end <= i) protectedIndex++;
        const span = protectedSpans[protectedIndex];
        if (span !== undefined && span.start <= i) { i = span.end; continue; }
        if (source.startsWith("#[", i)) {
            let depth = 1;
            i += 2;
            while (i < source.length && depth > 0) {
                if (source.startsWith("#[", i)) { depth++; i += 2; }
                else if (source.startsWith("]#", i)) { depth--; i += 2; }
                else i++;
            }
        } else if (source[i] === "#") {
            while (i < source.length && source[i] !== "\n") i++;
        } else if (source.startsWith('"""', i)) {
            // Raw rest-of-line literal (including its opening delimiter).
            const end = source.indexOf("\n", i);
            i = end < 0 ? source.length : end;
        } else if (['"', "'", "`"].includes(source[i])) {
            const quote = source[i++];
            while (i < source.length) {
                if (quote === '"' && source[i] === "\\") { i += 2; continue; }
                if (source[i++] === quote) {
                    if (quote !== '"' && source[i] === quote) { i++; continue; }
                    break;
                }
            }
        } else {
            const word = /^[\p{L}\p{N}_]+\^*/u.exec(source.slice(i))?.[0];
            const hat = word && /^(.+?)(\^+)$/.exec(word);
            if (hat && Object.prototype.hasOwnProperty.call(HATS, hat[1]) && !declaredHats.has(word!) &&
                (hat[2].length === 1 || ["break", "next", "skip", "continue", "it", "self", "def", "Self", "this"].includes(hat[1]))) {
                tokens.push({ start: i, end: i + word!.length, word: hat[1], depth: hat[2].length,
                    tableDefinition: hat[1] === "def" && tableDefinitions.has(i) });
            }
            i += word?.length ?? 1;
        }
    }
    const byStart = new Map(tokens.map(token => [token.start, token]));
    for (const symbol of symbols.values()) {
        const token = byStart.get(symbol.start);
        if (token !== undefined && token.end === symbol.end) token.symbol = symbol;
        else if (token === undefined) tokens.push({ ...symbol, symbol });
    }
    return tokens.sort((a, b) => a.start - b.start);
}

/** Normalize/truncate display text without losing which runs are semantic labels. */
function compact(parts: LabelPart[], fallback: string, max: number): LabelPart[] {
    const chars: LabelPart[] = [];
    for (const part of parts) {
        for (const ch of part.text) {
            const text = /\s/u.test(ch) ? " " : ch;
            const last = chars[chars.length - 1]?.text;
            if (text === " " && (last === undefined || last === " ")) continue;
            if (text === "…" && (last === "…" || (last === " " && chars[chars.length - 2]?.text === "…"))) continue;
            chars.push({ ...part, text });
        }
    }
    if (chars[chars.length - 1]?.text === " ") chars.pop();
    if (chars.length === 0) return fallback ? [{ text: fallback }] : [];
    // A source-backed editable name must never become a truncated rename target.
    if (!parts.some(p => p.name || p.typeSite) && chars.length > max) chars.splice(max - 1, chars.length, { text: "…" });
    const result: LabelPart[] = [];
    for (const ch of chars) {
        const last = result[result.length - 1];
        if (last !== undefined && last.role === ch.role && last.name === ch.name && last.source === ch.source && last.symbol === ch.symbol && last.typeSite === ch.typeSite) last.text += ch.text;
        else result.push({ ...ch });
    }
    return result;
}

export const labelText = (label: DisplayLabel | string): string =>
    typeof label === "string" ? label : label.parts.map((p) => p.text).join("");

/** Source spans decide what may be localized; user text is never searched/replaced. */
export function createLabeler(source: string, root: AstNode, vocabulary: Vocabulary = ENGLISH_VOCABULARY) {
    const tokens = semanticTokens(source, root);
    const sites = typeSites({ source, root });
    return (node: AstNode, drawn: AstNode[], max = 48, typed = false): DisplayLabel => {
        let pieces: (string | { start: number; end: number })[] = [];
        const shownSites = typed ? sites.filter(site => site.start >= node.start && site.end <= node.end) : [];
        const name = node.fields?.name;
        if (["errordef", "error-kind", "enumdef"].includes(node.kind) && name !== undefined && !Array.isArray(name)) {
            pieces.push({ start: node.start, end: name.end });
        } else {
            let cursor = node.start;
            for (const child of [...drawn].sort((a, b) => a.start - b.start)) {
                if (child.start > cursor) pieces.push({ start: cursor, end: child.start });
                if (child.end > cursor) {
                    if (child.start > cursor || pieces.length > 0) pieces.push("…");
                    cursor = child.end;
                }
            }
            if (cursor < node.end) pieces.push({ start: cursor, end: node.end });
        }
        const raw = pieces.map((p) => typeof p === "string" ? p : source.slice(p.start, p.end)).join("")
            .replace(/\s+/g, " ").replace(/(…\s*)+/g, "… ").trim() || node.kind;
        for (const site of shownSites) {
            if (!site.annotation || site.colon === undefined) continue;
            const start = site.colon, end = site.annotation.end;
            pieces = pieces.flatMap(piece => typeof piece === "string" || piece.end <= start || piece.start >= end ? [piece]
                : [piece.start < start ? { start: piece.start, end: start } : undefined,
                    piece.end > end ? { start: end, end: piece.end } : undefined].filter((p): p is SourceSpan => !!p));
        }
        const shownTokens = shownSites.length ? [
            ...tokens.filter(token => !shownSites.some(site => token.start >= site.start && token.end <= site.end)),
            ...shownSites.map(site => ({ ...tokens.find(token => token.start === site.start && token.end === site.end), start: site.start, end: site.end })),
        ].sort((a, b) => a.start - b.start) : tokens;
        const parts: LabelPart[] = [];
        for (const piece of pieces) {
            if (typeof piece === "string") { parts.push({ text: piece }); continue; }
            let cursor = piece.start;
            for (const token of shownTokens) {
                if (token.start < cursor || token.end > piece.end) continue;
                parts.push({ text: source.slice(cursor, token.start) });
                if (token.name) parts.push({ text: token.name.value, name: token.name, symbol: token.symbol });
                else if (token.word === undefined) parts.push({ text: source.slice(token.start, token.end), symbol: token.symbol });
                else {
                    const word = token.word!;
                    const entry = HATS[word];
                    const role = word === "let" ? "constant" : word === "var" ? "variable" : word;
                    let text = token.tableDefinition
                        ? vocabulary.tableDefinition ?? ENGLISH_VOCABULARY.tableDefinition!
                        : vocabulary.hats?.[word] ?? vocabulary[role as LabelRole] ?? entry.text;
                    if (token.depth! > 1) {
                        const exit = ["break", "next", "skip", "continue"].includes(word);
                        const format = exit ? vocabulary.levels ?? ENGLISH_VOCABULARY.levels!
                            : vocabulary.outer ?? ENGLISH_VOCABULARY.outer!;
                        text = exit ? format.replace("{0}", text).replace("{1}", String(token.depth))
                            : format.replace("{0}", String(token.depth! - 1)).replace("{1}", text);
                    }
                    // Delimit translated words even where L^ allows glued tokens.
                    if (/[\p{L}\p{N}_]$/u.test(parts[parts.length - 1]?.text ?? "")) parts.push({ text: " " });
                    parts.push({ text, role, category: entry.category, source: source.slice(token.start, token.end), symbol: token.symbol });
                    if (/^[\p{L}\p{N}_]/u.test(source.slice(token.end, piece.end))) parts.push({ text: " " });
                }
                cursor = token.end;
                const site = shownSites.find(site => site.start === token.start && site.end === token.end);
                if (site) {
                    const part = parts[parts.length - 1];
                    part.typeSite = site;
                    const typeNode: AstNode = { kind: "graph-type", start: 0, end: site.typeText.length, line: 1, column: 1 };
                    part.typeLabel = labelText(createLabeler(site.typeText, typeNode, vocabulary)(typeNode, [], 64));
                }
            }
            parts.push({ text: source.slice(cursor, piece.end) });
        }
        return { text: raw.length > max ? raw.slice(0, max - 1) + "…" : raw,
            parts: compact(parts, node.kind, max) };
    };
}
