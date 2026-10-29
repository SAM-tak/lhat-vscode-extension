import type { AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { statementSites } from "./graphStatements";
import { commaLists, type CommaList } from "./graphLists";
import { canInsertBinding } from "./graphCalls";
import { syntaxTokens } from "./graphSyntax";
import { annotationOwners } from "./graphAnnotations";

export interface DeleteSite extends SourceSpan { category: "statement" | "element" }

function removableLists(tree: AstReply) {
    const lists = commaLists(tree);
    return lists.filter(list => !["define", "reassign"].includes(list.node.kind)
        && !list.implicit && list.field !== "return_type" && list.node.kind !== "type-tuple"
        && !(list.node.kind === "tuple" && lists.some(parent => ["define", "reassign"].includes(parent.node.kind)
            && parent.field === "values" && parent.items[0] === list.node
            && Array.isArray(parent.node.fields?.targets) && parent.node.fields.targets.length > 1)));
}

function bindingPairs(tree: AstReply): [CommaList, CommaList][] {
    const lists = commaLists(tree);
    return lists.flatMap(list => {
        if (list.field !== "targets" || list.items.length < 2 || !canInsertBinding(list.node, tree.source)) return [];
        let values = lists.find(other => other.node === list.node && other.field === "values");
        if (values?.items.length === 1 && values.items[0].kind === "tuple")
            values = lists.find(other => other.node === values!.items[0] && other.field === "items");
        return values && values.items.length === list.items.length ? [[list, values] as [CommaList, CommaList]] : [];
    });
}

export function deleteSites(tree: AstReply): DeleteSite[] {
    return [...statementSites(tree).map(site => ({ start: site.start, end: site.end, category: "statement" as const })),
        ...[...removableLists(tree), ...bindingPairs(tree).flat()].flatMap(list => list.items.map(item => ({ start: item.start, end: item.end, category: "element" as const })))];
}

export function deleteFromGraph(tree: AstReply, site: DeleteSite): SourceEdit | undefined {
    if (!deleteSites(tree).some(s => s.category === site.category && s.start === site.start && s.end === site.end)) return undefined;
    if (site.category === "statement") {
        const owner = annotationOwners(tree).find(owner => owner.start === site.start && owner.end === site.end && owner.target !== "unit");
        const start = Math.min(site.start, ...(owner?.annotations.map(a => a.start) ?? []));
        const next = syntaxTokens(tree.source, site.end)[0];
        const end = next?.text === ";" ? next.end : site.end;
        return { start, end, text: end > site.end ? tree.source.slice(site.end, end - 1) : "" };
    }
    const pair = bindingPairs(tree).find(pair => pair.some(list => list.items.some(item => item.start === site.start && item.end === site.end)));
    if (pair) {
        const index = pair.flatMap(list => list.items.map((item, index) => ({ item, index })))
            .find(({ item }) => item.start === site.start && item.end === site.end)!.index;
        const node = pair[0].node;
        let text = tree.source.slice(node.start, node.end);
        for (const edit of pair.map(list => deleteItem(tree.source, list, index)).sort((a, b) => b.start - a.start))
            text = text.slice(0, edit.start - node.start) + edit.text + text.slice(edit.end - node.start);
        return { start: node.start, end: node.end, text };
    }
    const list = removableLists(tree).find(list => list.items.some(item => item.start === site.start && item.end === site.end))!;
    const index = list.items.findIndex(item => item.start === site.start && item.end === site.end);
    return deleteItem(tree.source, list, index);
}

function deleteItem(source: string, list: CommaList, index: number): SourceEdit {
    const item = list.items[index];
    const next = list.items[index + 1], previous = list.items[index - 1];
    // AST spans omit grouping parentheses. Remove the written slot, including its groups.
    const leading = syntaxTokens(source, previous?.end ?? list.start, item.start);
    const trailing = syntaxTokens(source, item.end, next?.start ?? list.end);
    const before = leading.filter(t => t.text === ",").slice(-1)[0];
    const after = trailing.find(t => t.text === ",");
    let start = item.start, end = item.end;
    for (const token of leading.slice().reverse()) {
        if (token.text !== "(") break;
        start = token.start;
    }
    for (const token of trailing) {
        if (token.text !== ")") break;
        end = token.end;
    }
    const site = { start, end };
    const comma = after ?? before;
    if (!comma) return { start: site.start, end: site.end, text: "" };
    // Preserve comments and whitespace between the item and its separator.
    return comma.start >= site.end
        ? { start: site.start, end: comma.end, text: source.slice(site.end, comma.start) }
        : { start: comma.start, end: site.end, text: source.slice(comma.end, site.start) };
}
