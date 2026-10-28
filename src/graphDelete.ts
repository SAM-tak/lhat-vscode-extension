import type { AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { statementSites } from "./graphStatements";
import { commaLists } from "./graphLists";
import { syntaxTokens } from "./graphSyntax";
import { annotationOwners } from "./graphAnnotations";

export interface DeleteSite extends SourceSpan { category: "statement" | "element" }

/** Definitions bind parallel lists; remove the whole declaration until paired deletion is supported. */
function removableLists(tree: AstReply) {
    return commaLists(tree).filter(list => !["define", "reassign"].includes(list.node.kind)
        && !list.implicit && list.field !== "return_type" && list.node.kind !== "type-tuple");
}

export function deleteSites(tree: AstReply): DeleteSite[] {
    return [...statementSites(tree).map(site => ({ start: site.start, end: site.end, category: "statement" as const })),
        ...removableLists(tree).flatMap(list => list.items.map(item => ({ start: item.start, end: item.end, category: "element" as const })))];
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
    const list = removableLists(tree).find(list => list.items.some(item => item.start === site.start && item.end === site.end))!;
    const index = list.items.findIndex(item => item.start === site.start && item.end === site.end);
    const next = list.items[index + 1], previous = list.items[index - 1];
    const after = syntaxTokens(tree.source, site.end, next?.start ?? list.end).find(t => t.text === ",");
    const before = previous && syntaxTokens(tree.source, previous.end, site.start).find(t => t.text === ",");
    const comma = after ?? before;
    if (!comma) return { start: site.start, end: site.end, text: "" };
    // Preserve comments and whitespace between the item and its separator.
    return comma.start >= site.end
        ? { start: site.start, end: comma.end, text: tree.source.slice(site.end, comma.start) }
        : { start: comma.start, end: site.end, text: tree.source.slice(comma.end, site.start) };
}
