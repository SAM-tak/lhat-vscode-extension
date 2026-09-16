import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import * as l10n from "@vscode/l10n";
import type { FromWebview, ToWebview } from "../../protocol";
import { nameColumns, renameTargetKey, type RenameTarget } from "../labels";

interface RenameContext {
    sourceKey: string;
    version?: number;
    post: (message: FromWebview) => void;
    sizes: Record<string, string>;
    resize: (name: RenameTarget, value: string) => void;
}
const Rename = createContext<RenameContext>({ sourceKey: "", post: () => {}, sizes: {}, resize: () => {} });
export const RenameProvider = Rename.Provider;
let requestId = 0;

export function NameInput({ name }: { name: RenameTarget }) {
    const context = useContext(Rename);
    return <NameEditor key={`${context.sourceKey}:${name.start}:${name.end}:${name.value}`} name={name} context={context} />;
}

function NameEditor({ name, context }: { name: RenameTarget; context: RenameContext }) {
    const [value, setValue] = useState(context.sizes[renameTargetKey(name)] ?? name.value);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const request = useRef<string | undefined>(undefined);
    const composing = useRef(false);
    const cancelled = useRef(false);
    useEffect(() => {
        const receive = (event: MessageEvent<ToWebview>) => {
            if (event.data.type !== "renameResult" || event.data.id !== request.current) return;
            request.current = undefined;
            setPending(false);
            setError(event.data.error ?? "");
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    const commit = () => {
        if (cancelled.current) { cancelled.current = false; return; }
        if (request.current || context.version === undefined) return;
        if (!value) { setError(l10n.t("Enter a name.")); return; }
        // Size the committed draft now, independently of the LSP/AST round trip.
        // This changes geometry only; the source-backed target stays untouched.
        context.resize(name, value);
        if (value === name.value) { setError(""); return; }
        const id = `rename-${++requestId}`;
        request.current = id;
        setPending(true);
        setError("");
        context.post({ type: "rename", id, start: name.start, end: name.end,
            oldName: name.value, newName: value, version: context.version });
    };
    return <input className="name-input nodrag nopan nowheel nokey" type="text" value={value}
        data-reference-start={name.start} data-reference-end={name.end}
        style={{ width: `calc(${nameColumns(context.sizes[renameTargetKey(name)] ?? name.value)}ch + 8px * var(--lhat-scale))` }}
        readOnly={pending || context.version === undefined} spellCheck={false} autoComplete="off"
        aria-label={l10n.t("Declaration name")} aria-invalid={!!error} aria-busy={pending}
        title={error || l10n.t("Rename in source and references on Enter or leaving the field. Escape cancels.")}
        onChange={event => { setValue(event.target.value); setError(""); }}
        onBlur={commit}
        onFocus={() => { cancelled.current = false; }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
            event.stopPropagation();
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") {
                event.preventDefault(); cancelled.current = true; setValue(name.value); setError(""); event.currentTarget.blur();
                context.resize(name, name.value);
            }
        }}
        onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} />;
}
