import type { AstNode, SourceSpan, TypeSite } from "../protocol";
import { typeSites } from "../graphTypes";
import { HATS, type LabelCategory } from "./vocabulary";
import { ASSIGNMENT_LABELS, assignmentOperator } from "../graphAssignments";

export type LabelRole = "variableDefinition" | "mutableVariableDefinition" |
    "variableDeclaration" | "mutableVariableDeclaration" | "string" | "number";
export type Vocabulary = Record<LabelRole, string> & {
    hats?: Record<string, string>; outer?: string; levels?: string; tableDefinition?: string; table?: string;
    input?: string; output?: string; noOutput?: string; missingInput?: string; call?: string; methodCall?: string;
    condition?: string; conditionalBranch?: string; conditionalSelection?: string;
    pattern?: string; patternBranch?: string; patternSelection?: string;
    assignments?: Record<string, string>; nilCheckedAssignment?: string;
};
export const ENGLISH_VOCABULARY: Vocabulary = {
    variableDefinition: "Variable Definition", mutableVariableDefinition: "Mutable Variable Definition",
    variableDeclaration: "Variable Declaration", mutableVariableDeclaration: "Mutable Variable Declaration",
    string: "Text", number: "Number",
    hats: Object.fromEntries(Object.entries(HATS).map(([word, entry]) => [word, entry.text])),
    outer: "Outer {0}: {1}", levels: "{0} ({1} levels)",
    tableDefinition: "Table type definition",
    table: "Table",
    input: "Input", output: "Output", noOutput: "No output", missingInput: "Missing input", call: "Call", methodCall: "Method Call",
    condition: "Condition", conditionalBranch: "Conditional Branch", conditionalSelection: "Conditional Selection",
    pattern: "Pattern", patternBranch: "Pattern Matching Branch", patternSelection: "Pattern Matching Selection",
    assignments: ASSIGNMENT_LABELS, nilCheckedAssignment: "{0} (nil-checked)",
};
export interface RenameTarget { start: number; end: number; value: string }
export const renameTargetKey = (name: RenameTarget): string => `${name.start}:${name.end}`;
/** Shared by the input and graph layout so their minimum/Unicode widths agree. */
export const nameColumns = (value: string): number => Math.max(3, labelColumns(value));
export interface LabelPart { text: string; role?: string; category?: LabelCategory; source?: string; name?: RenameTarget; symbol?: SourceSpan; typeSite?: TypeSite; typeLabel?: string }
export interface DisplayLabel { text: string; parts: LabelPart[] }
interface Token {
    start: number; end: number; word?: string; depth?: number; name?: RenameTarget;
    tableDefinition?: boolean; symbol?: SourceSpan; definition?: boolean; typeSite?: TypeSite;
}

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
function semanticTokens(source: string, root: AstNode,
                        range: SourceSpan = { start: 0, end: source.length }, inheritedHats: ReadonlySet<string> = new Set()): Token[] {
    const tokens: Token[] = [];
    const protectedSpans: { start: number; end: number }[] = [];
    const declaredHats = new Set(inheritedHats);
    const disabled: AstNode[] = [];
    const tableDefinitions = new Set<number>();
    const bindings = new Map<number, boolean>();
    const symbols = new Map<number, SourceSpan>();
    const protectName = (node: AstNode | AstNode[] | undefined) => {
        if (node === undefined || Array.isArray(node)) return;
        protectedSpans.push(node);
        if (source.slice(node.start, node.end).endsWith("^")) declaredHats.add(source.slice(node.start, node.end));
    };
    const visit = (node: AstNode) => {
        // Disabled statements have their own parsed display context, not live bindings.
        if (node.kind === "disabled") { disabled.push(node); return; }
        if (node.kind === "ident" || node.kind === "hat-ident") {
            const text = source.slice(node.start, node.end);
            if (/^[\p{L}_][\p{L}\p{N}_]*\^*$/u.test(text) || /^`(?:[^`]|``)+`$/u.test(text)) {
                symbols.set(node.start, { start: node.start, end: node.end });
            }
        }
        // The definition's keyword starts a DEF node. References such as
        // def^.foo (even inside that definition) are separate HAT_IDENTs.
        if (node.kind === "def") tableDefinitions.add(node.start);
        if (node.kind === "define") bindings.set(node.start, !!node.fields?.values);
        if (node.kind === "string") { protectedSpans.push(node); return; }
        if (["table-entry", "param", "enumdef", "errordef", "error-kind"].includes(node.kind)) {
            const name = node.fields?.name ?? node.fields?.key;
            // A method's explicit receiver is a language-provided binding,
            // not a user declaration shadowing every self^ in this file.
            if (!(node.kind === "param" && name && !Array.isArray(name) &&
                /^self\^+$/.test(source.slice(name.start, name.end)))) protectName(name);
            if (node.kind === "param" && name && !Array.isArray(name) &&
                !/^self\^+$/.test(source.slice(name.start, name.end))) {
                tokens.push({ start: name.start, end: name.end,
                    name: { start: name.start, end: name.end, value: source.slice(name.start, name.end) } });
            }
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
    for (let i = range.start; i < range.end;) {
        while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].end <= i) protectedIndex++;
        const span = protectedSpans[protectedIndex];
        if (span !== undefined && span.start <= i) { i = span.end; continue; }
        if (source.startsWith("#[", i)) {
            let depth = 1;
            i += 2;
            while (i < range.end && depth > 0) {
                if (source.startsWith("#[", i)) { depth++; i += 2; }
                else if (source.startsWith("]#", i)) { depth--; i += 2; }
                else i++;
            }
        } else if (source[i] === "#") {
            while (i < range.end && source[i] !== "\n") i++;
        } else if (source.startsWith('"""', i)) {
            // Raw rest-of-line literal (including its opening delimiter).
            const end = source.indexOf("\n", i);
            i = end < 0 ? range.end : Math.min(end, range.end);
        } else if (['"', "'", "`"].includes(source[i])) {
            const quote = source[i++];
            while (i < range.end) {
                if (quote === '"' && source[i] === "\\") { i += 2; continue; }
                if (source[i++] === quote) {
                    if (quote !== '"' && source[i] === quote) { i++; continue; }
                    break;
                }
            }
        } else {
            const word = /^[\p{L}\p{N}_]+\^*/u.exec(source.slice(i, range.end))?.[0];
            const hat = word && /^(.+?)(\^+)$/.exec(word);
            if (hat && Object.prototype.hasOwnProperty.call(HATS, hat[1]) && !declaredHats.has(word!) &&
                (hat[2].length === 1 || ["break", "next", "skip", "continue", "it", "self", "def", "Self", "this"].includes(hat[1]))) {
                tokens.push({ start: i, end: i + word!.length, word: hat[1], depth: hat[2].length,
                    tableDefinition: hat[1] === "def" && tableDefinitions.has(i),
                    definition: (hat[1] === "let" || hat[1] === "var") ? bindings.get(i) : undefined });
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
    for (const region of disabled) {
        // The server parses only valid statement bodies inside #[~ ... ]#.
        // Keep original offsets, ordinary comments and literal/name protection.
        if (!children(region).length) continue;
        const body = { ...region, kind: "block", start: region.start + 3, end: region.end - 2 };
        tokens.push(...semanticTokens(source, body, body, declaredHats).map(({ name, symbol, ...token }) => token));
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

/** Full visual spelling for menus/tooltips, short structural captions for nodes. */
export function displayType(typeText: string, vocabulary: Vocabulary = ENGLISH_VOCABULARY, brief = false): string {
    if (brief) {
        const kind = /^[\s(]*([tfp])\^(?!\^)/.exec(typeText)?.[1];
        if (kind) return `${vocabulary.hats?.[kind] ?? HATS[kind].text}…`;
    }
    const node: AstNode = { kind: "graph-type", start: 0, end: typeText.length, line: 1, column: 1 };
    return labelText(createLabeler(typeText, node, vocabulary)(node, [], brief ? 64 : Infinity));
}

/** Source spans decide what may be localized; user text is never searched/replaced. */
export function createLabeler(source: string, root: AstNode, vocabulary: Vocabulary = ENGLISH_VOCABULARY) {
    const tokens = semanticTokens(source, root);
    const sites = typeSites({ source, root });
    return (node: AstNode, drawn: AstNode[], max = 48, typed = false): DisplayLabel => {
        if (node.kind === "reassign") {
            const operator = assignmentOperator(node, source), base = operator?.base ?? ":=";
            let text = vocabulary.assignments?.[base] ?? ASSIGNMENT_LABELS[base];
            if (operator?.nilChecked) text = (vocabulary.nilCheckedAssignment ?? ENGLISH_VOCABULARY.nilCheckedAssignment!).replace("{0}", text);
            return { text, parts: [{ text, role: "reassignment", category: "declaration", source: operator?.text ?? ":=" }] };
        }
        const body = node.fields?.body;
        if (node.kind === "for" && body && !Array.isArray(body) &&
            ((body.kind === "if-stmt" && source[body.start] === "{") ||
                (body.kind === "if-expr" && source[body.start] === ":"))) {
            const role = body.kind === "if-stmt" ? "patternBranch" : "patternSelection";
            const text = vocabulary[role] ?? ENGLISH_VOCABULARY[role]!;
            return { text, parts: [{ text, role, category: "control", source: "for^" }] };
        }
        if ((node.kind === "if-stmt" || node.kind === "if-expr") && source.startsWith("if^", node.start)) {
            const role = node.kind === "if-stmt" ? "conditionalBranch" : "conditionalSelection";
            const text = vocabulary[role] ?? ENGLISH_VOCABULARY[role]!;
            return { text, parts: [{ text, role, category: "control", source: "if^" }] };
        }
        if (node.kind === "table") return { text: "Table", parts: [
            { text: vocabulary.table ?? ENGLISH_VOCABULARY.table!, role: "table", category: "value" },
        ] };
        let pieces: (string | { start: number; end: number })[] = [];
        const shownSites = typed ? sites.filter(site => site.start >= node.start && site.end <= node.end) : [];
        const name = node.fields?.name;
        if (node.kind === "def" || node.kind === "self-table") {
            // The keyword identifies the container; braces and member holes
            // add no information in open, folded, or breadcrumb captions.
            const keywordLength = node.kind === "def" ? 4 : 5;
            pieces.push({ start: node.start, end: Math.min(node.start + keywordLength, node.end) });
        } else if (["errordef", "error-kind", "enumdef"].includes(node.kind) && name !== undefined && !Array.isArray(name)) {
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
            ...shownSites.map(site => {
                const anchor = site.anchor ?? site;
                return { ...tokens.find(token => token.start === anchor.start && token.end === anchor.end),
                    start: anchor.start, end: anchor.end, typeSite: site };
            }),
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
                    const role = word === "let"
                        ? token.definition === false ? "variableDeclaration" : "variableDefinition"
                        : word === "var"
                            ? token.definition === false ? "mutableVariableDeclaration" : "mutableVariableDefinition"
                            : word;
                    let text = token.tableDefinition
                        ? vocabulary.tableDefinition ?? ENGLISH_VOCABULARY.tableDefinition!
                        : (word === "let" || word === "var" ? vocabulary[role as LabelRole]
                            : vocabulary.hats?.[word]) ?? vocabulary[role as LabelRole] ?? entry.text;
                    // Braces already identify a structural table type. Keep
                    // def^ and named types distinct, but don't prefix t^{...}.
                    if (word === "t" && /^\s*\{/.test(source.slice(token.end))) text = "";
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
                if (token.typeSite) {
                    const part = parts[parts.length - 1];
                    part.typeSite = token.typeSite;
                    part.typeLabel = displayType(token.typeSite.typeText, vocabulary, true);
                }
                cursor = token.end;
            }
            parts.push({ text: source.slice(cursor, piece.end) });
        }
        return { text: raw.length > max ? raw.slice(0, max - 1) + "…" : raw,
            parts: compact(parts, node.kind, max) };
    };
}
