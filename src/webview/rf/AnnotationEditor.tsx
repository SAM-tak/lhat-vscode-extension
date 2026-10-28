import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as l10n from "@vscode/l10n";
import type { AstReply, FromWebview, ToWebview } from "../../protocol";
import { annotationOwners, validAnnotation, type AnnotationOwner, type AnnotationSite } from "../../graphAnnotations";

type Host = { tree?: AstReply; version?: number; post: (message: FromWebview) => void;
    hide: (site: AnnotationSite) => void };
const Annotations = createContext({ owners: [] as AnnotationOwner[], version: undefined as number | undefined,
    edit: (_site: AnnotationSite, _add?: boolean) => {}, hide: (_site: AnnotationSite) => {} });
let serial = 0;
export function AnnotationProvider({ value, children }: { value: Host; children: React.ReactNode }) {
    const owners = useMemo(() => value.tree ? annotationOwners(value.tree) : [], [value.tree]);
    const [draft, setDraft] = useState<{ site: AnnotationSite; add?: boolean; version: number; id: string; value: string; saving?: boolean; error?: string }>();
    const current = useRef(draft); current.current = draft;
    const input = useRef<HTMLTextAreaElement>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const close = () => { setDraft(undefined); previousFocus.current?.focus({ preventScroll: true }); };
    useEffect(() => { setDraft(undefined); }, [value.version, value.tree?.source]);
    useEffect(() => { if (draft) input.current?.focus(); }, [draft?.id]);
    useEffect(() => {
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type !== "statementResult" || data.id !== current.current?.id) return;
            if (data.error) setDraft(d => d && ({ ...d, saving: false, error: data.error }));
            else close();
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    const edit = (site: AnnotationSite, add?: boolean) => {
        if (value.version === undefined) return;
        previousFocus.current = document.activeElement as HTMLElement;
        setDraft({ site, add, value: add ? "@" : site.text, id: `annotation-${++serial}`, version: value.version });
    };
    const save = (remove = false) => {
        if (!draft || draft.saving || value.version !== draft.version) return;
        const text = remove ? "" : draft.value.trim();
        if (!remove && !validAnnotation(text)) {
            setDraft({ ...draft, error: l10n.t("Enter @name or @name(arguments). Arguments must be literals or names.") }); return;
        }
        setDraft({ ...draft, saving: true, error: undefined });
        value.post({ type: "editAnnotation", id: draft.id, version: draft.version,
            ...draft.site, value: text, add: draft.add });
    };
    return <Annotations.Provider value={{ owners, version: value.version, edit, hide: value.hide }}>
        {children}
        {draft && createPortal(<div className="annotation-backdrop nodrag nopan nowheel nokey"
            onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget && !draft.saving) close(); }}>
            <form className="annotation-editor" role="dialog" aria-modal="true" aria-label={l10n.t("Edit annotation")}
                onSubmit={e => { e.preventDefault(); save(); }} onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === "Tab") {
                        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>("textarea:not(:disabled), button:not(:disabled)")];
                        const first = controls[0], last = controls[controls.length - 1];
                        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
                        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
                    }
                    if (e.key === "Escape" && !draft.saving) { e.preventDefault(); close(); }
                }}>
                <label htmlFor="annotation-source">{l10n.t("Annotation name and arguments")}</label>
                <textarea id="annotation-source" ref={input} value={draft.value} disabled={draft.saving}
                    onChange={e => setDraft({ ...draft, value: e.target.value, error: undefined })}
                    onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }} />
                <small>{l10n.t("Example: @export_range(0, 100). Edit the name and add, remove or change arguments here.")}</small>
                {draft.error && <div role="alert">{draft.error}</div>}
                <div className="annotation-editor-actions">
                    {!draft.add && <button type="button" disabled={draft.saving} onClick={() => save(true)}>{l10n.t("Delete annotation")}</button>}
                    <button type="button" disabled={draft.saving} onClick={close}>{l10n.t("Cancel")}</button>
                    <button type="submit" disabled={draft.saving}>{l10n.t("Save")}</button>
                </div>
            </form>
        </div>, document.body)}
    </Annotations.Provider>;
}

export function AnnotationActions({ site }: { site: AnnotationSite }) {
    const actions = useContext(Annotations);
    return <span className="annotation-actions nodrag nopan nokey" onPointerDown={e => e.stopPropagation()}>
        <button type="button" disabled={actions.version === undefined} title={l10n.t("Edit annotation")}
            aria-label={l10n.t("Edit annotation")} onClick={e => { e.stopPropagation(); actions.edit(site); }}>✎</button>
        <button type="button" title={l10n.t("Hide annotation")} aria-label={l10n.t("Hide annotation")}
            onClick={e => { e.stopPropagation(); actions.hide(site); }}>×</button>
    </span>;
}
export function AddAnnotation({ start, end, kind, unit = false }: { start?: number; end?: number; kind?: string; unit?: boolean }) {
    const actions = useContext(Annotations);
    const owner = unit ? actions.owners[0] : actions.owners.find(o => o.start === start && o.end === end && o.kind === kind);
    if (!owner || !owner.canAdd) return null;
    const title = unit ? l10n.t("Add unit annotation") : l10n.t("Add annotation");
    return <button type="button" className={unit ? undefined : "add-annotation nodrag nopan nokey"}
        title={title} aria-label={title} disabled={actions.version === undefined}
        onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); actions.edit({
            start: owner.start, end: owner.start, ownerStart: owner.start, ownerEnd: owner.end, ownerKind: owner.kind, text: "" }, true); }}>
        {unit ? title : "@+"}
    </button>;
}
