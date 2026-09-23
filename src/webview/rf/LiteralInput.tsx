import React, { createContext, useContext, useRef, useState } from "react";
import { isNumberLiteral, type LiteralValue } from "../literals";
import * as l10n from "@vscode/l10n";

interface Edits {
    sourceKey: string;
    values: Record<string, string>;
    change: (literal: LiteralValue, value: string) => void;
    commit: (literal: LiteralValue, value: string) => void;
}
const LiteralEdits = createContext<Edits>({ sourceKey: "", values: {}, change: () => {}, commit: () => {} });

/** Session-only values survive node unmounts (folding/drilling), not source changes. */
export function LiteralEditProvider({ sourceKey, children, onCommit }: {
    sourceKey: string; children: React.ReactNode; onCommit: (literal: LiteralValue, value: string) => void;
}) {
    const [state, setState] = useState({ sourceKey, values: {} as Record<string, string> });
    if (state.sourceKey !== sourceKey) setState({ sourceKey, values: {} });
    const values = state.sourceKey === sourceKey ? state.values : {};
    const change: Edits["change"] = (literal, value) => setState((previous) => {
        const next = { ...(previous.sourceKey === sourceKey ? previous.values : {}) };
        if (value === literal.value) delete next[literal.key];
        else next[literal.key] = value;
        return { sourceKey, values: next };
    });
    return <LiteralEdits.Provider value={{ sourceKey, values, change, commit: onCommit }}>{children}</LiteralEdits.Provider>;
}

export function LiteralEditStatus() {
    const { values } = useContext(LiteralEdits);
    const count = Object.keys(values).length;
    return count === 0 ? null : <span className="literal-edit-status" role="status"
        title={l10n.t("Graph-only edits. Not saved to source; cleared when source changes or this view reloads.")}>
        {l10n.t("Graph only · {0}", count)}
    </span>;
}

export function LiteralInput({ literal }: { literal: LiteralValue }) {
    const { sourceKey, values, change, commit } = useContext(LiteralEdits);
    const value = values[literal.key] ?? literal.value;
    const original = useRef({ sourceKey, value });
    if (original.current.sourceKey !== sourceKey) original.current = { sourceKey, value };
    const composing = useRef(false);
    const cancelled = useRef(false);
    const invalid = literal.kind === "number" && !isNumberLiteral(value);
    const props = {
        className: "literal-input nodrag nopan nowheel nokey",
        value,
        "aria-label": literal.kind === "number" ? l10n.t("Number literal") : l10n.t("Text literal"),
        "aria-invalid": invalid,
        title: invalid ? l10n.t("Enter a number (for example 42, -0.5, 1e3 or 0xFF). Escape cancels.")
            : l10n.t("Edit in graph only (not saved to source). Enter finishes; Escape cancels. Shift+Enter adds a text line."),
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
    return <div className={`literal-editor ${literal.kind}`} data-modified={value !== literal.value}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}>
        {literal.kind === "string" && <span className="literal-quote" aria-hidden="true">“</span>}
        {literal.kind === "number" ? <input {...props} type="text" inputMode="decimal" />
            : <textarea {...props} rows={1} wrap="soft" />}
        {literal.kind === "string" && <span className="literal-quote" aria-hidden="true">”</span>}
    </div>;
}
