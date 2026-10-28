import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { isNumberLiteral, type LiteralValue } from "../literals";
import * as l10n from "@vscode/l10n";

import type { FromWebview, ToWebview } from "../../protocol";

interface Edits {
    disabled: boolean;
    sourceKey: string;
    values: Record<string, string>;
    change: (literal: LiteralValue, value: string) => void;
    commit: (literal: LiteralValue, value: string) => void;
}
const LiteralEdits = createContext<Edits>({ disabled: true, sourceKey: "", values: {}, change: () => {}, commit: () => {} });

/** Drafts survive folding until a versioned source edit commits. */
export function LiteralEditProvider({ sourceKey, children, version, post }: {
    sourceKey: string; children: React.ReactNode; version?: number; post: (message: FromWebview) => void;
}) {
    const pending = useRef<string | undefined>(undefined);
    const sequence = useRef(0);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        pending.current = undefined;
        setSaving(false);
    }, [sourceKey, version]);
    useEffect(() => {
        const receive = ({ data }: MessageEvent<ToWebview>) => {
            if (data.type !== "statementResult" || data.id !== pending.current) return;
            pending.current = undefined;
            setSaving(false);
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
    }, []);
    const commit = (literal: LiteralValue, value: string) => {
        if (version === undefined || pending.current || value === literal.value) return;
        const id = `literal-${++sequence.current}`;
        pending.current = id;
        setSaving(true);
        post({ type: "editLiteral", id, key: literal.key, value, version });
    };
    const [state, setState] = useState({ sourceKey, values: {} as Record<string, string> });
    if (state.sourceKey !== sourceKey) setState({ sourceKey, values: {} });
    const values = state.sourceKey === sourceKey ? state.values : {};
    const change: Edits["change"] = (literal, value) => setState((previous) => {
        const next = { ...(previous.sourceKey === sourceKey ? previous.values : {}) };
        if (value === literal.value) delete next[literal.key];
        else next[literal.key] = value;
        return { sourceKey, values: next };
    });
    return <LiteralEdits.Provider value={{ disabled: version === undefined || saving, sourceKey, values, change, commit }}>{children}</LiteralEdits.Provider>;
}

export function LiteralFrame({ kind, modified, children }: {
    kind: LiteralValue["kind"]; modified: boolean; children: React.ReactNode;
}) {
    return <div className={`literal-editor ${kind}`} data-modified={modified}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}>
        {kind === "string" && <span className="literal-quote" aria-hidden="true">“</span>}
        {children}
        {kind === "string" && <span className="literal-quote" aria-hidden="true">”</span>}
    </div>;
}

/** Shared field/frame, with the caller choosing its source-commit behaviour. */
export function LiteralField({ kind, modified, inputProps }: {
    kind: LiteralValue["kind"]; modified: boolean;
    inputProps: React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}) {
    return <LiteralFrame kind={kind} modified={modified}>
        {kind === "number" ? <input {...inputProps} type="text" inputMode="decimal" />
            : <textarea {...inputProps} rows={1} wrap="soft" />}
    </LiteralFrame>;
}

export function LiteralInput({ literal }: { literal: LiteralValue }) {
    const { disabled, sourceKey, values, change, commit } = useContext(LiteralEdits);
    const value = values[literal.key] ?? literal.value;
    const original = useRef({ sourceKey, value });
    if (original.current.sourceKey !== sourceKey) original.current = { sourceKey, value };
    const composing = useRef(false);
    const cancelled = useRef(false);
    const invalid = literal.kind === "number" && !isNumberLiteral(value);
    const props = {
        className: "literal-input nodrag nopan nowheel nokey",
        value,
        disabled,
        "aria-label": literal.kind === "number" ? l10n.t("Number literal") : l10n.t("Text literal"),
        "aria-invalid": invalid,
        title: invalid ? l10n.t("Enter a number (for example 42, -0.5, 1e3 or 0xFF). Escape cancels.")
            : l10n.t("Enter saves to source; Escape cancels. Shift+Enter adds a text line."),
        spellCheck: false,
        autoComplete: "off",
        onFocus: () => { original.current = { sourceKey, value }; cancelled.current = false; },
        onBlur: () => {
            if (!cancelled.current && !invalid) commit(literal, value);
            cancelled.current = false;
        },
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(literal, event.target.value),
        onCompositionStart: () => { composing.current = true; },
        onCompositionEnd: () => { composing.current = false; },
        onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            event.stopPropagation();
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
                event.preventDefault();
                cancelled.current = true;
                change(literal, original.current.value);
                event.currentTarget.blur();
            } else if (event.key === "Enter" && !(literal.kind === "string" && event.shiftKey)) {
                event.preventDefault();
                if (!invalid) event.currentTarget.blur();
            }
        },
        onKeyUp: (event: React.KeyboardEvent) => event.stopPropagation(),
    };
    return <LiteralField kind={literal.kind} modified={value !== literal.value} inputProps={props} />;
}
