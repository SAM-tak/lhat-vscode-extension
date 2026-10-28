import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { AstReply, FromWebview, ToWebview } from "../../protocol";
import { annotationArguments, annotationChoiceText, annotationChoicesForOwner, annotationOwners, annotationOwnerKey, validAnnotation,
    type AnnotationChoice, type AnnotationOwner, type AnnotationSite } from "../../graphAnnotations";

type Host = { tree?: AstReply; version?: number; post: (message: FromWebview) => void; boxes: Record<string, boolean>; show: (owner: AnnotationOwner) => void };
type Actions = Host & { owners: AnnotationOwner[]; busy: boolean;
    save: (site: AnnotationSite, value: string, add?: boolean) => Promise<string | undefined> };
const Annotations = createContext<Actions>({ version: undefined, post: () => {}, boxes: {}, show: () => {}, owners: [], busy: false,
    save: async () => undefined });
let sequence = 0;

/** Source edits share a single outstanding transaction, like the host. */
export function AnnotationProvider({ value, children }: { value: Host; children: React.ReactNode }) {
    const owners = useMemo(() => value.tree ? annotationOwners(value.tree) : [], [value.tree]);
    const host = useRef(value); host.current = value;
    const [busy, setBusy] = useState(false);
    const request = useRef<{ id: string; resolve: (error?: string) => void } | undefined>(undefined);
    useEffect(() => {
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type !== "statementResult" || data.id !== request.current?.id) return;
            const active = request.current; request.current = undefined;
            setBusy(false); active.resolve(data.error);
        };
        window.addEventListener("message", receive);
        return () => {
            window.removeEventListener("message", receive);
            request.current?.resolve(l10n.t("The source changed. Try again in the updated graph."));
            request.current = undefined;
        };
    }, []);
    const transact = (build: (common: { id: string; version: number }) => FromWebview): Promise<string | undefined> => {
        const { version, post } = host.current;
        if (version === undefined || request.current) return Promise.resolve(l10n.t("The source changed. Try again in the updated graph."));
        const id = `annotation-${++sequence}`;
        setBusy(true);
        return new Promise(resolve => {
            request.current = { id, resolve };
            post(build({ id, version }));
        });
    };
    const save: Actions["save"] = (site, text, add) => {
        const value = text.trim();
        if (value && !validAnnotation(value)) return Promise.resolve(l10n.t("Annotation arguments must be literals or names."));
        return transact(common => ({ type: "editAnnotation", ...common, ...site, value, add }));
    };
    return <Annotations.Provider value={{ ...value, owners, busy, save }}>{children}</Annotations.Provider>;
}

function ownerSite(owner: AnnotationOwner): AnnotationSite {
    return { start: owner.start, end: owner.start, ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, text: "" };
}

function AnnotationPicker({ owner, site, unit = false }: { owner: AnnotationOwner; site?: AnnotationSite; unit?: boolean }) {
    const actions = useContext(Annotations);
    const [error, setError] = useState<string>();
    const choices = actions.tree ? annotationChoicesForOwner(actions.tree, owner, site) : [];
    const currentName = site ? annotationArguments(site.text).name : "";
    const title = site ? l10n.t("Change annotation") : unit ? l10n.t("Add unit annotation") : l10n.t("Add annotation");
    return <span className={`annotation-picker ${site ? "annotation-name" : unit ? "" : "annotation-add"}`}>
        <select className="nodrag nopan nowheel nokey" aria-label={title} title={error || title} aria-invalid={!!error} value={currentName}
            disabled={actions.version === undefined || actions.busy || !choices.length}
            onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
            onChange={e => {
                const choice = choices.find(c => c.name === e.target.value);
                if (choice) void actions.save(site ?? ownerSite(owner), annotationChoiceText(choice, site?.text), !site).then(setError);
            }}>
            {!site && <option value="" disabled>{unit ? title : "+"}</option>}
            {site && !choices.some(c => c.name === currentName) && <option value={currentName}>{currentName}</option>}
            {choices.map(choice => <option key={choice.name} value={choice.name}>
                {choice.name}
            </option>)}
        </select>
        {error && <small className="annotation-error" role="alert">{error}</small>}
    </span>;
}

function AnnotationParameters({ site, choice }: { site: AnnotationSite; choice?: AnnotationChoice }) {
    const actions = useContext(Annotations);
    const original = annotationArguments(site.text);
    const defaults = choice && annotationArguments(annotationChoiceText(choice, site.text)).arguments;
    const initial = original.arguments ?? defaults ?? "";
    const [value, setValue] = useState(initial);
    const [committed, setCommitted] = useState(initial);
    const [error, setError] = useState<string>();
    const cancelled = useRef(false);
    const active = useRef(true);
    useEffect(() => () => { active.current = false; }, []);
    const commit = () => {
        if (cancelled.current) { cancelled.current = false; return; }
        if (actions.busy || value === committed) return;
        const text = `@${original.name}(${value})`;
        if (!validAnnotation(text)) { setError(l10n.t("Annotation arguments must be literals or names.")); return; }
        void actions.save(site, text).then(reason => {
            if (!active.current) return;
            setError(reason); if (!reason) setCommitted(value);
        });
    };
    return <span className="annotation-parameters">
        <span aria-hidden="true">(</span>
        <input type="text" className="annotation-arguments nodrag nopan nowheel nokey" value={value}
            aria-label={l10n.t("Annotation arguments for {0}", original.name)} aria-invalid={!!error}
            title={error || l10n.t("Edit arguments. Enter saves; Escape cancels.")} spellCheck={false} autoComplete="off"
            readOnly={actions.version === undefined || actions.busy}
            onChange={e => { setValue(e.target.value); setError(undefined); }}
            onFocus={() => { cancelled.current = false; }} onBlur={commit}
            onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
            onKeyDown={e => {
                e.stopPropagation(); if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Escape") { e.preventDefault(); cancelled.current = true; setValue(committed); setError(undefined); e.currentTarget.blur(); }
                else if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
            }} />
        <span aria-hidden="true">)</span>
        {error && <small className="annotation-error" role="alert">{error}</small>}
    </span>;
}

function AnnotationRow({ owner, site }: { owner: AnnotationOwner; site: AnnotationSite }) {
    const actions = useContext(Annotations);
    const [error, setError] = useState<string>();
    const parsed = annotationArguments(site.text);
    const choice = actions.tree?.annotationChoices?.find(c => c.name === parsed.name);
    const parameters = parsed.arguments !== undefined || !!choice?.parameterTypes?.length || !!choice?.variadic;
    return <div className="annotation-row" role="listitem" data-annotation-start={site.start}>
        <AnnotationPicker owner={owner} site={site} />
        {parameters && <AnnotationParameters key={site.text} site={site} choice={choice} />}
        <button type="button" className="annotation-delete nodrag nopan nokey" title={error || l10n.t("Delete annotation")}
            aria-label={l10n.t("Delete annotation")} disabled={actions.version === undefined || actions.busy}
            onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); void actions.save(site, "").then(setError); }}>×</button>
        {error && <small className="annotation-error" role="alert">{error}</small>}
    </div>;
}

export function AnnotationList({ owner, collapsed, foldButton }: { owner: AnnotationOwner; collapsed: boolean; foldButton: React.ReactNode }) {
    return <>
        <div className="annotation-header"><span className="semantic-label" data-category="module">{l10n.t("Annotations")}</span>
            {foldButton}
        </div>
        {!collapsed && <>
            <div role="list" className="annotation-rows" aria-label={l10n.t("Annotations")}>
                {owner.annotations.map(site => <AnnotationRow key={`${site.start}:${site.end}:${site.text}`} owner={owner} site={site} />)}
            </div>
            {owner.canAdd && <div className="annotation-footer"><AnnotationPicker owner={owner} /></div>}
        </>}
    </>;
}

export function useAnnotationOwner(node: { start?: number; end?: number; kind?: string; owner?: AnnotationOwner; statement?: { start: number; end: number } }): AnnotationOwner | undefined {
    const actions = useContext(Annotations);
    return node.owner ?? actions.owners.find(o => o.start === node.start && o.end === node.end && o.kind === node.kind)
        ?? actions.owners.find(o => o.start === node.statement?.start && o.end === node.statement?.end && o.kind === "define");
}

export function AddAnnotation({ start, end, kind, unit = false }: { start?: number; end?: number; kind?: string; unit?: boolean }) {
    const actions = useContext(Annotations);
    const owner = unit ? actions.owners[0] : actions.owners.find(o => o.start === start && o.end === end && o.kind === kind);
    if (!owner || !owner.canAdd || (!unit && (owner.annotations.length || actions.boxes[annotationOwnerKey(owner)]))) return null;
    const title = unit ? l10n.t("Add unit annotation") : l10n.t("Add annotation");
    return <button type="button" className={unit ? "annotation-unit-add" : "add-annotation nodrag nopan nokey"}
        title={title} aria-label={title} disabled={actions.version === undefined || actions.busy}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.show(owner); }}>
        {unit ? title : "+"}
    </button>;
}
