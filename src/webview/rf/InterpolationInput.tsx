import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { FromWebview, ToWebview } from "../../protocol";
import type { InterpolationField } from "../../graphInterpolation";
import { LiteralFrame } from "./LiteralInput";
import { InsertionButton, useStatementActions } from "./StatementMenu";

const Edits = createContext<{ sourceKey: string; version?: number; post: (message: FromWebview) => void }>({
    sourceKey: "", post: () => {},
});
export const InterpolationProvider = Edits.Provider;
let sequence = 0;

export function InterpolationInput({ field }: { field: InterpolationField }) {
    const context = useContext(Edits);
    return <Editor key={`${context.sourceKey}:${field.site.start}:${field.site.part?.start}:${field.site.field}`}
        field={field} context={context} />;
}

function Editor({ field, context }: { field: InterpolationField; context: React.ContextType<typeof Edits> }) {
    const actions = useStatementActions();
    const [value, setValue] = useState(field.value), [focused, setFocused] = useState(false);
    const [pending, setPending] = useState(false), [error, setError] = useState("");
    const request = useRef<string | undefined>(undefined), cancelled = useRef(false), composing = useRef(false);
    useEffect(() => {
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type !== "statementResult" || data.id !== request.current) return;
            request.current = undefined; setPending(false); setError(data.error ?? "");
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    const send = (next: string) => {
        if (request.current || context.version === undefined) return;
        const id = `interpolation-${++sequence}`;
        request.current = id; setPending(true); setError("");
        context.post({ type: "editInterpolation", id, site: field.site, value: next, version: context.version });
    };
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    const kind = field.site.field;
    const label = kind === "text" ? l10n.t("Text fragment") : kind === "format" ? l10n.t("Format specifier") : l10n.t("Interpolation expression");
    if (kind === "append") return <InsertionButton title={l10n.t("Add interpolation part")}
        style={{ width: "calc(15.4px * var(--lhat-scale, 1))", height: "calc(15.4px * var(--lhat-scale, 1))" }}
        disabled={context.version === undefined} onOpen={anchor => actions.interpolation(field.site, anchor)} />;
    const input = <textarea className={`${kind === "text" ? "literal-input " : ""}interpolation-input nodrag nopan nowheel nokey`} rows={1}
            value={field.compact && !focused && value === field.value ? "⋯" : value}
            placeholder={kind === "format" ? l10n.t("None") : undefined} aria-label={label}
            readOnly={pending || context.version === undefined} aria-invalid={!!error} aria-busy={pending}
            title={error || l10n.t("Edit source on Enter or leaving the field. Escape cancels; Shift+Enter adds a line.")}
            spellCheck={false} onChange={event => { setValue(event.target.value); setError(""); }}
            onFocus={() => { setFocused(true); cancelled.current = false; }}
            onBlur={() => {
                setFocused(false);
                if (!cancelled.current && value !== field.value) send(value);
                cancelled.current = false;
            }}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
                event.stopPropagation();
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Escape") { event.preventDefault(); cancelled.current = true; setValue(field.value); setError(""); event.currentTarget.blur(); }
                else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); }
            }} onKeyUp={stop} />;
    return <div className={`interpolation-field ${kind}`} onPointerDown={stop} onPointerUp={stop} onClick={stop} onDoubleClick={stop}>
        {kind === "format" && <span className="interpolation-field-title">{l10n.t("Format:")}</span>}
        {kind === "text" ? <LiteralFrame kind="string" modified={value !== field.value}>{input}</LiteralFrame> : input}
        {error && <span className="interpolation-error" role="alert">{error}</span>}
    </div>;
}
