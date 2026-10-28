import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import type { StatementTemplate } from "./graphStatements";
import { syntaxTokens } from "./graphSyntax";

export interface StructureSite extends SourceSpan { kind: string }
interface Action extends StatementTemplate { edit: SourceEdit }
const array = (value: AstNode | AstNode[] | undefined): AstNode[] => value ? Array.isArray(value) ? value : [value] : [];
const one = (node: AstNode, field: string) => array(node.fields?.[field])[0];
export function structureSites(tree: AstReply): StructureSite[] {
    const sites: StructureSite[] = [];
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (["if-stmt", "if-expr", "repeat", "for"].includes(node.kind))
            sites.push({ start: node.start, end: node.end, kind: node.kind });
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root); return sites;
}

function actions(tree: AstReply, site: StructureSite): Action[] {
    let node: AstNode | undefined;
    const find = (candidate: AstNode) => {
        if (candidate.kind === "disabled") return;
        if (candidate.kind === site.kind && candidate.start === site.start && candidate.end === site.end) node = candidate;
        Object.values(candidate.fields ?? {}).flat().forEach(find);
    };
    find(tree.root);
    if (!node) return [];
    const source = tree.source, result: Action[] = [], newline = source.includes("\r\n") ? "\r\n" : "\n";
    const add = (id: string, label: string, edit: SourceEdit, preview = edit.text || label) => result.push({ id, label, text: preview, edit });
    const match = node.kind === "for" ? one(node, "body") : undefined;
    if (match && ["if-stmt", "if-expr"].includes(match.kind)) {
        const branches = array(match.fields?.items), expression = match.kind === "if-expr";
        const close = syntaxTokens(source, node.start, node.end).slice(-1)[0];
        if (!close || !["}", ";"].includes(close.text)) return [];
        const otherwise = branches.find(branch => !one(branch, "condition"));
        const at = otherwise?.start ?? close.start;
        add("match-branch", "Add pattern branch", { start: at, end: at, text: `${newline}when^0: ${expression ? "0 " : ""}${newline}` });
        if (!otherwise) add("match-other", "Add other branch", { start: close.start, end: close.start, text: `${newline}other^: ${expression ? "0 " : ""}${newline}` });
        branches.forEach((branch, index) => {
            if (branches.length > 1 && !(expression && branch === otherwise))
                add(`remove-match:${index}`, `Remove branch ${index + 1}`, { start: branch.start,
                    end: Math.min(branch.end, branches[index + 1]?.start ?? close.start), text: "" });
            const tokens = syntaxTokens(source, branch.start, branch.end);
            if (tokens[0]?.text !== "when^") return;
            let depth = 0;
            const colon = tokens.slice(1).find(token => {
                if (["(", "{", "["].includes(token.text)) depth++;
                if ([")", "}", "]"].includes(token.text)) depth--;
                return token.text === ":" && depth === 0;
            });
            if (!colon) return;
            for (const [id, label, text] of [
                ["number", "Number pattern", "0"], ["string", "String pattern", '""'],
                ["range", "Range pattern", "0 to^1"], ["choices", "Alternative patterns", "0, 1"],
                ["type", "Type pattern", "fits^number^"],
            ]) add(`pattern:${index}:${id}`, label, { start: tokens[0].end, end: colon.start, text }, `${index + 1}: ${text}`);
        });
        return result;
    }
    if (["if-stmt", "if-expr"].includes(node.kind)) {
        // Pattern matching uses generated if nodes with no written if^ keyword.
        if (syntaxTokens(source, node.start, node.end)[0]?.text !== "if^") return [];
        const branches = array(node.fields?.items), expression = node.kind === "if-expr";
        if (!branches.length) return [];
        const otherwise = branches.find(branch => !one(branch, "condition"));
        const close = syntaxTokens(source, node.start, node.end).slice(-1)[0];
        if (!close || close.text !== (expression ? ";" : "}")) return [];
        const handlers = [...array(node.fields?.arms), ...array(node.fields?.extra)];
        const end = Math.min(close.start, ...handlers.map(n => n.start));
        const at = otherwise?.start ?? end;
        add("branch", "Add conditional branch", { start: at, end: at, text: `${newline}el^false^: ${expression ? "0 " : ""}${newline}` });
        if (!otherwise) add("else", "Add else branch", { start: end, end, text: `${newline}el^: ${expression ? "0 " : ""}${newline}` });
        branches.forEach((branch, index) => {
            if (index === 0) {
                const next = branches[1], nextBody = next && one(next, "body"), condition = next && one(next, "condition");
                if (!next && !expression) add("remove-branch:0", "Remove first branch", { start: node!.start, end: node!.end, text: "" });
                else if (nextBody) {
                    if (expression && !condition) add("remove-branch:0", "Remove first branch",
                        { start: node!.start, end: node!.end, text: `(${source.slice(nextBody.start, nextBody.end)})` });
                    else add("remove-branch:0", "Remove first branch", { start: node!.start,
                        end: Math.min(nextBody.start, end),
                        text: `if^${condition ? source.slice(condition.start, condition.end) : "true^"}${expression ? ": " : " { "}` });
                }
                return;
            }
            if (expression && !one(branch, "condition")) return;
            add(`remove-branch:${index}`, `Remove branch ${index + 1}`, { start: branch.start, end: Math.min(branch.end, branches[index + 1]?.start ?? end), text: "" });
        });
    } else if (["repeat", "for"].includes(node.kind)) {
        const body = one(node, "body");
        if (body?.kind !== "block") return [];
        const tokens = syntaxTokens(source, body.start, body.end), open = tokens[0], close = tokens.slice(-1)[0];
        if (open?.text !== "{" || close?.text !== "}") return [];
        const header = syntaxTokens(source, node.start, body.start);
        const conditional = header.some(t => ["while^", "until^"].includes(t.text));
        const ranged = header.some(t => t.text === "from^");
        const bound = one(node, "bound"), focus = array(node.fields?.focus), advance = array(node.fields?.advance);
        const textOf = (n: AstNode | undefined, fallback: string) => n ? source.slice(n.start, n.end) : fallback;
        const used = new Set(syntaxTokens(source).map(t => t.text));
        let fresh = "i", serial = 2;
        while (used.has(fresh)) fresh = `i${serial++}`;
        const binding = focus[0], target = binding && array(binding.fields?.targets)[0];
        const name = textOf(target, fresh), initial = textOf(binding && array(binding.fields?.values)[0], "0");
        const focusText = ranged ? `var^${name} = ${initial}` : focus.map(n => textOf(n, "")).join(", ");
        const step = advance.length ? ` next^${advance.map(n => textOf(n, "")).join(", ")}`
            : ranged ? ` next^${name} += 1` : "";
        const mode = (id: string, label: string, text: string) => add(`mode:${id}`, label,
            { start: node!.start, end: body.start, text: `${text} ` });
        const prefix = node.kind === "for" ? `for^${focusText} ` : "repeat^";
        mode("while", "Use while loop", `${prefix}while^${conditional ? textOf(bound, "true^") : "true^"}${step}`);
        mode("until", "Use until loop", `${prefix}until^${conditional ? textOf(bound, "false^") : "false^"}${step}`);
        if (node.kind === "repeat") {
            mode("count", "Use counted loop", `repeat^${conditional ? "1" : textOf(bound, "1")}`);
            mode("forever", "Use infinite loop", "repeat^");
        }
        if (node.kind === "repeat" || focus.length === 1 && target?.kind === "ident")
            mode("range", "Use range loop", `for^${name} from^${initial} to^${ranged || !conditional && node.kind === "repeat" ? textOf(bound, "1") : "1"}`);
        const order = ["prolog^", "pre^", "first^", "main^", "last^", "epilog^", "finally^"];
        const headers: { name: string; start: number; end: number }[] = [];
        let depth = 0;
        tokens.forEach((token, index) => {
            if (token.text === "{") depth++;
            else if (token.text === "}") depth--;
            else if (depth === 1 && order.includes(token.text) && tokens[index + 1]?.text === ":")
                headers.push({ name: token.text, start: token.start, end: tokens[index + 1].end });
        });
        const implicit = !headers.some(h => h.name === "main^") && array(body.fields?.items).length > 0;
        for (const name of order.slice(0, -1)) {
            if (headers.some(h => h.name === name) || name === "main^" && implicit) continue;
            const next = headers.find(h => order.indexOf(h.name) > order.indexOf(name));
            let at = next?.start ?? close.start, text = `${newline}${name}:${newline}`;
            if (order.indexOf(name) < 3 && implicit) {
                at = open.end;
                text += `main^:${newline}`;
            } else if (!headers.length && !implicit && name !== "main^") text += `main^:${newline}`;
            add(`section:${name}`, `Add ${name} section`, { start: at, end: at, text });
        }
        headers.forEach((header, index) => {
            const end = headers[index + 1]?.start ?? close.start;
            // Retain a main heading when removing it would absorb following code into another section.
            const keepMain = header.name === "main^" && !headers.some(h => h !== header && ["pre^", "first^", "last^"].includes(h.name));
            const needsMain = !implicit && !headers.some(h => h !== header && ["pre^", "first^", "main^", "last^"].includes(h.name));
            const text = keepMain || needsMain ? `main^:${newline}` : "";
            add(`remove-section:${header.name}`, `${keepMain ? "Clear" : "Remove"} ${header.name} section`, { start: header.start, end, text });
        });
    }
    return result;
}

export const structureTemplates = (tree: AstReply, site: StructureSite): StatementTemplate[] => actions(tree, site);
export const editStructure = (tree: AstReply, site: StructureSite, action: string): SourceEdit | undefined =>
    actions(tree, site).find(choice => choice.id === action)?.edit;
