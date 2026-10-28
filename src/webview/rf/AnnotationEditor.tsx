import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import { annotationPresentation, annotationParameterText, type AnnotationParameter } from "../annotations";
import { graphVocabulary } from "../localization";
import { labelColumns } from "../labels";
import { LiteralField } from "./LiteralInput";
import { TypeLabel } from "./TypeLabel";
import { InsertionIcon } from "./StatementMenu";
import type { AstReply, FromWebview, ToWebview } from "../../protocol";
import { annotationArguments, annotationChoiceText, annotationChoicesForOwner, annotationOwners, annotationOwnerKey, validAnnotation,
    type AnnotationOwner, type AnnotationSite } from "../../graphAnnotations";

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
    return <span className={`annotation-picker ${site ? "annotation-name" : unit ? "" : "annotation-add statement-button"}`}>
        {!site && !unit && <InsertionIcon />}
        <select className={`nodrag nopan nowheel nokey ${!site && !unit ? "annotation-add-select" : ""}`}
            style={site ? { width: `calc(${labelColumns(currentName) * 7.2 + 4}px * var(--lhat-scale))` } : undefined} aria-label={title} title={error || title} aria-invalid={!!error} value={currentName}
            disabled={actions.version === undefined || actions.busy || !choices.length}
            onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}
            onChange={e => {
                const choice = choices.find(c => c.name === e.target.value);
                if (choice) void actions.save(site ?? ownerSite(owner), annotationChoiceText(choice, site?.text), !site).then(setError);
            }}>
            {!site && <option value="" disabled>{unit ? title : <InsertionIcon />}</option>}
            {site && !choices.some(c => c.name === currentName) && <option value={currentName}>{currentName}</option>}
            {choices.map(choice => <option key={choice.name} value={choice.name}>
                {choice.name}
            </option>)}
        </select>
        {error && <small className="annotation-error" role="alert">{error}</small>}
    </span>;
}

function AnnotationParameterInput({ site, text, parameter, index, name }: {
    site: AnnotationSite; text: string; parameter: AnnotationParameter; index: number; name: string;
}) {
    const actions = useContext(Annotations);
    const [value, setValue] = useState(parameter.value);
    const [committed, setCommitted] = useState(parameter.value);
    const [error, setError] = useState<string>();
    const cancelled = useRef(false);
    const active = useRef(true);
    useEffect(() => () => { active.current = false; }, []);
    const commit = () => {
        if (cancelled.current) { cancelled.current = false; return; }
        if (actions.busy || value === committed) return;
        const source = annotationParameterText(text, parameter, value);
        if (!validAnnotation(source)) { setError(l10n.t("Annotation arguments must be literals or names.")); return; }
        void actions.save(site, source).then(reason => {
            if (!active.current) return;
            setError(reason); if (!reason) setCommitted(value);
        });
    };
    const inputProps = {
        className: `annotation-arguments ${parameter.kind === "name" ? "name-input" : "literal-input"} nodrag nopan nowheel nokey`,
        value, "aria-label": l10n.t("Annotation argument {0} of {1}", index + 1, name), "aria-invalid": !!error,
        title: error || l10n.t("Edit arguments. Enter saves; Escape cancels."), spellCheck: false, autoComplete: "off",
        readOnly: actions.version === undefined || actions.busy,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setValue(event.target.value); setError(undefined); },
        onFocus: () => { cancelled.current = false; }, onBlur: commit,
        onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
        onPointerUp: (event: React.PointerEvent) => event.stopPropagation(),
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            event.stopPropagation(); if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setValue(committed); setError(undefined); event.currentTarget.blur(); }
            else if (event.key === "Enter" && !(parameter.kind === "string" && event.shiftKey)) { event.preventDefault(); event.currentTarget.blur(); }
        },
    };
    return <span className="annotation-parameter" style={{ width: `calc(${parameter.width}px * var(--lhat-scale))`, height: `calc(${parameter.height}px * var(--lhat-scale))` }}>
        {parameter.kind === "name" ? <input {...inputProps} type="text" /> :
            <span className={`box literal-node literal-${parameter.kind}`}>
                <span className="literal-type-label"><TypeLabel label={parameter.typeLabel} /></span>
                <LiteralField kind={parameter.kind} modified={value !== committed} inputProps={inputProps} />
            </span>}
        {error && <small className="annotation-error" role="alert">{error}</small>}
    </span>;
}

function AnnotationRow({ owner, site }: { owner: AnnotationOwner; site: AnnotationSite }) {
    const actions = useContext(Annotations);
    const [error, setError] = useState<string>();
    const parsed = annotationArguments(site.text);
    const choice = actions.tree?.annotationChoices?.find(c => c.name === parsed.name);
    const presentation = annotationPresentation(site, choice, graphVocabulary());
    return <div className="annotation-row" role="listitem" data-annotation-start={site.start}
        style={{ height: `calc(${presentation.height}px * var(--lhat-scale))` }}>
        <AnnotationPicker owner={owner} site={site} />
        {presentation.parameters.length > 0 && <span className="annotation-parameters">
            {presentation.parameters.map((parameter, index) => <AnnotationParameterInput key={`${site.text}:${index}`}
                site={site} text={presentation.text} parameter={parameter} index={index} name={parsed.name} />)}
        </span>}
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
    return <button type="button" className={unit ? "annotation-unit-add" : "add-annotation statement-button nodrag nopan nokey"}
        title={title} aria-label={title} disabled={actions.version === undefined || actions.busy}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); actions.show(owner); }}>
        {unit ? title : <InsertionIcon />}
    </button>;
}
