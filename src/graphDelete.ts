import type { AstNode, AstReply, SourceSpan } from "./protocol";
import type { SourceEdit } from "./graphReorder";
import { statementSites } from "./graphStatements";
import { commaLists, removeListItem as deleteItem, removeListElement, type CommaList } from "./graphLists";
import { canInsertBinding, hasCallInitializer } from "./graphCalls";
import { assignmentOperator } from "./graphAssignments";
import { syntaxTokens } from "./graphSyntax";
import { annotationOwners } from "./graphAnnotations";
import { structureTemplates, editStructure, type StructureSite } from "./graphStructure";

export interface DeleteSite extends SourceSpan { category: "statement" | "element" }

/** Use the same source-preserving operations as the structure menu. */
export function structuralDeletions(tree: AstReply): { site: DeleteSite; owner: StructureSite; action: string }[] {
    const result: { site: DeleteSite; owner: StructureSite; action: string }[] = [];
    const one = (node: AstNode, field: string) => {
        const value = node.fields?.[field]; return Array.isArray(value) ? value[0] : value;
    };
    const visit = (node: AstNode) => {
        if (node.kind === "disabled") return;
        if (["block", "func", "with", "if-stmt", "if-expr", "for", "repeat"].includes(node.kind)) {
            const body = one(node, "body");
            const scope = ["func", "for", "repeat"].includes(node.kind) ? body : node.kind === "with" ? one(node, "extra") : node, owner = { start: node.start, end: node.end, kind: node.kind };
            for (const choice of structureTemplates(tree, owner)) {
                let element: SourceSpan | undefined;
                const branch = /^remove-(?:branch|match):(\d+)$/.exec(choice.id);
                if (branch) {
                    const branches = (node.kind === "for" ? body : node)?.fields?.items;
                    if (Array.isArray(branches)) element = branches[Number(branch[1])];
                } else if (choice.id.startsWith("remove-catch:")) {
                    const arms = scope?.fields?.arms;
                    if (Array.isArray(arms)) element = arms[Number(choice.id.slice("remove-catch:".length))];
                } else if (choice.id === "remove-finally") {
                    const extra = scope?.fields?.extra;
                    element = (Array.isArray(extra) ? extra : extra ? [extra] : []).find(clause => syntaxTokens(tree.source, clause.start, clause.end)[0]?.text === "finally^");
                } else if (choice.id.startsWith("remove-section:")) {
                    const name = choice.id.slice("remove-section:".length), extra = body?.fields?.extra;
                    if (Array.isArray(extra)) element = extra.find(clause => syntaxTokens(tree.source, clause.start, clause.end)[0]?.text === name);
                    if (!element && name === "main^") {
                        const edit = editStructure(tree, owner, choice.id);
                        if (edit && edit.text.trim() !== tree.source.slice(edit.start, edit.end).trim()) element = edit;
                    }
                } else if (choice.id === "next:remove") {
                    const advance = node.fields?.advance, edit = editStructure(tree, owner, choice.id);
                    if (Array.isArray(advance) && advance.length && edit) element = { start: edit.start, end: advance[advance.length - 1].end };
                }
                if (element) result.push({ site: { start: element.start, end: element.end, category: "element" }, owner, action: choice.id });
            }
        }
        Object.values(node.fields ?? {}).flat().forEach(visit);
    };
    visit(tree.root); return result;
}

function removableLists(tree: AstReply) {
    const lists = commaLists(tree);
    return lists.filter(list => !["define", "reassign"].includes(list.node.kind)
        && (list.node.kind !== "pattern-list" || list.items.length > 1)
        && (list.node.kind !== "index" || list.items.length > 1)
        && !(list.node.kind === "for" && list.field === "focus" && list.items.length < 2)
        && !list.implicit && (!["type-tuple", "type-apply"].includes(list.node.kind) || list.items.length > 1)
        && !(list.node.kind === "tuple" && lists.some(parent => ["define", "reassign"].includes(parent.node.kind)
            && parent.field === "values" && parent.items[0] === list.node
            && Array.isArray(parent.node.fields?.targets) && parent.node.fields.targets.length > 1)));
}

function bindingPairs(tree: AstReply): [CommaList, CommaList][] {
    const lists = commaLists(tree);
    return lists.flatMap(list => {
        const operator = list.node.kind === "reassign" && assignmentOperator(list.node, tree.source);
        const compound = operator && operator.base !== ":=";
        if (list.field !== "targets" || list.items.length < 2 || !compound && !canInsertBinding(list.node, tree.source)) return [];
        let values = lists.find(other => other.node === list.node && other.field === "values");
        if (values?.items.length === 1 && values.items[0].kind === "tuple")
            values = lists.find(other => other.node === values!.items[0] && other.field === "items");
        return values && values.items.length === list.items.length ? [[list, values] as [CommaList, CommaList]] : [];
    });
}

/** Discard a result without shifting later bindings or evaluating the call again. */
function discardableBindings(tree: AstReply): AstNode[] {
    return commaLists(tree).filter(list => list.field === "targets" && hasCallInitializer(list.node, tree.source) &&
        (list.node.kind === "define" || list.node.kind === "reassign" && assignmentOperator(list.node, tree.source)?.base === ":="))
        .flatMap(list => list.items).filter(target => {
            const name = target.fields?.name;
            const node = name && !Array.isArray(name) ? name : target;
            return tree.source.slice(node.start, node.end) !== "_^";
        });
}

export function deleteSites(tree: AstReply): DeleteSite[] {
    return [...statementSites(tree).map(site => ({ start: site.start, end: site.end, category: "statement" as const })),
        ...[...removableLists(tree), ...bindingPairs(tree).flat()].flatMap(list => list.items.map(item => ({ start: item.start, end: item.end, category: "element" as const }))),
        ...structuralDeletions(tree).map(deletion => deletion.site),
        ...discardableBindings(tree).map(target => ({ start: target.start, end: target.end, category: "element" as const }))];
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
    const structural = structuralDeletions(tree).find(deletion => deletion.site.start === site.start && deletion.site.end === site.end);
    if (structural) return editStructure(tree, structural.owner, structural.action);
    const discarded = discardableBindings(tree).find(target => target.start === site.start && target.end === site.end);
    if (discarded) return { start: discarded.start, end: discarded.end, text: "_^" };
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
    if (list.node.kind === "for" && list.field === "advance" && list.items.length === 1)
        return editStructure(tree, list.node, "next:remove");
    return removeListElement(tree.source, list, index);
}
