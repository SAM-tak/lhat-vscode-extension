// L^ (lhat) -- the graph webview on React Flow (06 の 8.4, the V14 spike).
//
// What this exists to prove or disprove:
//   - ELK owns every position; React Flow only shows them. Static nodes,
//     `parentId` subflows, with a declaration-height offset for wide values
//   - parity with the SVG view: folding, drilling in, click-to-reveal
//   - wide top-level boxes slide horizontally with their whole subtree;
//     descendants keep ELK's parent-relative positions
//   - a wide declaration's value drops below it and slides independently;
//     the declaration and execution lines stay fixed
//   - execution and definition handles share their arrows' endpoints
//
// The mapping (map.ts) is shared with the SVG view untouched, which is the
// point of keeping it framework-free.

import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import * as l10n from "@vscode/l10n";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
    Background, BaseEdge, Handle, MarkerType, MiniMap, Panel, PanOnScrollMode, Position,
    ReactFlow, getSmoothStepPath, useReactFlow, ReactFlowProvider,
    useUpdateNodeInternals,
    type BuiltInEdge,
    type Edge, type EdgeProps, type EdgeTypes, type Node, type NodeProps, type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./rf.css";
import type { AstNode, AstReply, FromWebview, ToWebview } from "../../protocol";
import { graphViewportX, nodeAt, titleOf, type ElkNode } from "../map";
import type { LiteralValue } from "../literals";
import { LiteralEditProvider, LiteralEditStatus, LiteralInput } from "./LiteralInput";
import { NameInput, RenameProvider } from "./NameInput";
import { TypeLabel, TypeProvider } from "./TypeLabel";
import { StatementProvider, StatementButton, useStatementActions } from "./StatementMenu";
import type { InsertionSite, OperatorSite } from "../../graphLists";
import type { StatementSite, StatementInsertion } from "../../graphStatements";
import { ReferenceLine } from "./ReferenceLine";
import { DEFAULT_MINIMAP_SIZE, fitMinimapSize } from "../minimap";
import { MinimapResizeHandles } from "./MinimapResizeHandles";
import { SvgExport } from "./SvgExport";
import { changedHandles } from "./handleUpdates";
import { LayoutClient } from "./layoutClient";
import { createLayoutEngine } from "./layoutEngine";
import { renameTargetKey, type LabelPart, type RenameTarget } from "../labels";
import { configureLocalization, graphVocabulary } from "../localization";
import { dragAxis, ownsHorizontalSlide, type DragAxis } from "./gesture";
import type { ReorderSite } from "../../graphReorder";

declare function acquireVsCodeApi(): {
    postMessage(message: FromWebview): void;
    setState(state: unknown): void;
    getState(): unknown;
};

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);
const DEFAULT_FONT_PX = 12;
let reorderSequence = 0;

// ---------------------------------------------------------------------------
// Laid-out ELK graph -> React Flow nodes

// How far a scroll-owning box has been slid, keyed by what it was made from.
// ELK ids are regenerated every layout; the source span survives one.
// The same key is what *.lhl would store (06 の 9 章).
//
// The start alone will not do: a parent and its first child begin at the same
// place all the time (the root and the first statement of a file, for one), so
// a key of position alone is shared down a chain of containers and every one
// of them adds the same slide again -- the contents drift further the deeper
// they sit. Span and kind together are unique, since two nodes of one kind
// covering exactly one range would be the same node.
type SlideBounds = { min: number; max: number };
type Slides = Record<string, {
    dx: number; dy: number;
    /** Temporary stretch, valid only for the bounds it was pulled against. */
    elastic?: SlideBounds;
}>;

const clampSlide = (dx: number, min: number, max: number): number =>
    Math.min(Math.max(dx, min), max);

const slidePosition = (saved: Slides[string] | undefined, bounds: SlideBounds) =>
    saved?.elastic?.min === bounds.min && saved.elastic.max === bounds.max
        ? saved.dx : clampSlide(saved?.dx ?? 0, bounds.min, bounds.max);

/** Resist only the part of a drag beyond an edge, including the crossing. */
function rubberSlide(current: number, delta: number, bounds: SlideBounds): number {
    let next = current + delta;
    if (next > bounds.max && delta > 0) {
        const edge = Math.max(current, bounds.max);
        next = edge + (next - edge) / 3;
    } else if (next < bounds.min && delta < 0) {
        const edge = Math.min(current, bounds.min);
        next = edge + (next - edge) / 3;
    }
    // A long pull cannot move the box away indefinitely. Unused motion is
    // discarded, so changing direction takes effect immediately.
    return clampSlide(next, bounds.min - 96, bounds.max + 96);
}

const slideKeyOf = (lhat: NonNullable<ElkNode["lhat"]>) =>
    `${lhat.kind}:${lhat.start}:${lhat.end}`;

interface SlideData {
    /** The outermost visible box moved by a gesture in this subtree. */
    slideKey?: string;
    slideDx: number;
    slideMin?: number;
    slideMax?: number;
}

interface BoxData extends Record<string, unknown>, SlideData {
    label: string;
    labelParts?: LabelPart[];
    literal?: LiteralValue;
    literalTypeLabel?: string;
    depth: number;
    isContainer: boolean;
    layoutOnly: boolean;
    scrollSurface: boolean;
    slideOwner: boolean;
    isStart: boolean;
    isAdd: boolean;
    isReturn: boolean;
    isCondition: boolean;
    noExecutionHandles: boolean;
    branchOffset?: number;
    definitionBranchOffset?: number;
    definitionRole?: "declaration" | "value";
    ioGroup?: "input" | "output";
    isCall: boolean;
    definitionHandleY?: number;
    collapsed: boolean;
    /** 01 の 6.5: written, but switched off. */
    disabled: boolean;
    start?: number;
    end?: number;
    sourceEnd?: number;
    /** Shared across boxes so touching another descendant stops the glide. */
    slideMotion: { current: (() => void) | null };
    onSlide: (key: string, dx: number, mode?: "drag" | "glide") => void;
    /** Return a stretched box to its nearest viewport edge. */
    onSpring: (key: string) => void;
    /** The document's vertical drag, shared by the background and node bodies. */
    onDocumentStart: () => void;
    onDocumentSlide: (dy: number, mode?: "drag" | "glide") => number;
    onDocumentRelease: (velocity: number) => void;
    onDocumentSpring: () => void;
    /** Source sibling-list item which uses the common insertion D&D control. */
    reorder?: ReorderSite;
    statement?: StatementSite;
    insertion?: InsertionSite;
    appendInsertion?: InsertionSite;
    insertionAxis?: "horizontal" | "vertical";
    appendInsertionAxis?: "horizontal" | "vertical";
    operator?: OperatorSite;
    inline?: boolean;
    decoration?: boolean;
    onReorder: (source: ReorderSite, target: ReorderSite, before: boolean) => void;
    /** Execution ports counter the box's slide to stay on the document axis. */
    flowHandleX?: number;
    /** Left click: go into a folded definition. Nothing otherwise. */
    onEnter: (data: BoxData) => void;
    /** Middle click: show what this was made from, in the text. */
    onReveal: (data: BoxData) => void;
    /** Briefly marked, having just been picked in the outline. */
    flashed: boolean;
    /** Whether this one can be folded shut, which is what shows the button. */
    foldable: boolean;
    /** The button: fold this one node, or open it, whatever the bar says. */
    onFold: (data: BoxData) => void;
}

type BoxNodeType = Node<BoxData, "box">;

// React Flow adds the endpoint nodes' layers to an edge's z-index. Leave
// room for its selection lift (1000): an active scroll owner covers an
// unrelated execution line, while its own descendant edges stay above it.
const EXECUTION_Z = 2000;
const ACTIVE_SCROLL_Z = EXECUTION_Z * 2;
// Above internal edges (up to 7000 with selection).
// Conditions have no execution handles, so this lift cannot lift an edge too.
const CONDITION_Z = EXECUTION_Z * 5;

const executionEdge = {
    type: "smoothstep",
    selectable: false,
    focusable: false,
    deletable: false,
    reconnectable: false,
    className: "exec",
    zIndex: EXECUTION_Z,
    pathOptions: { borderRadius: 6, offset: 6 },
    markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 11,
        height: 11,
        color: "var(--lhat-exec)",
    },
} satisfies Partial<BuiltInEdge>;

const branchEdge = { ...executionEdge, type: "branch", className: "exec branch" };
const routedExecutionEdge = { ...executionEdge, type: "execution" };

const definitionEdge = {
    ...executionEdge,
    type: "smoothstep",
    className: "definition",
    // Leave horizontal stubs at both side handles, even when the value
    // scrolls past the declaration. A short offset fits the 28px row gap.
    pathOptions: { borderRadius: 6, offset: 6 },
    markerEnd: { ...executionEdge.markerEnd, color: "var(--vscode-charts-blue, #58a)" },
} satisfies Partial<BuiltInEdge>;

// Only the outward trunk has an arrowhead at the actual definition target.
const definitionBranchEdge = { ...definitionEdge, type: "definition-branch",
    className: "definition definition-branch", markerEnd: undefined };

function toFlow(
    laid: ElkNode,
    slides: Slides,
    viewWidth: number,
    flashKey: string | undefined,
    onSlide: BoxData["onSlide"],
    onEnter: BoxData["onEnter"],
    onReveal: BoxData["onReveal"],
    onFold: BoxData["onFold"],
    slideMotion: BoxData["slideMotion"],
    onSpring: BoxData["onSpring"],
    onDocumentStart: BoxData["onDocumentStart"],
    onDocumentSlide: BoxData["onDocumentSlide"],
    onDocumentRelease: BoxData["onDocumentRelease"],
    onDocumentSpring: BoxData["onDocumentSpring"],
    onReorder: BoxData["onReorder"],
): { nodes: BoxNodeType[]; exec: Edge[]; definitions: Edge[] } {
    const nodes: BoxNodeType[] = [];
    // 8.6: the execution lines. The layout's own order-pinning edges (6.3),
    // shown where the mapping marked them -- the statement sequences.
    const exec: Edge[] = [];
    const definitions: Edge[] = [];
    const endpoints = new Map<string, ElkNode>();
    const parents = new Map<string, ElkNode>();
    const index = (node: ElkNode, parent?: ElkNode): void => {
        endpoints.set(node.id, node);
        if (parent !== undefined) parents.set(node.id, parent);
        for (const port of node.ports ?? []) endpoints.set(port.id, node);
        for (const child of node.children ?? []) index(child, node);
    };
    index(laid);
    const executionEnd = (node: ElkNode, end: "Entry" | "Exit"): ElkNode => {
        const seen = new Set<string>();
        while (!seen.has(node.id)) {
            seen.add(node.id);
            const id = node.lhat?.executionNode ?? node.lhat?.[`execution${end}`];
            const child = id === undefined ? undefined : endpoints.get(id);
            if (child === undefined) break;
            node = child;
        }
        return node;
    };

    // 8.6: wide split rows keep their declaration column in view. Other
    // views are centred. Anything longer than the view cannot be centred -- its
    // start would fall off the left, which is the wrong end to lose -- so it
    // hangs from the base left edge instead: shifted right, display-only,
    // until its left edge sits where the view's left margin is. Computed
    // before the slide is added. Only the top-level box is aligned: shifting
    // children as well would move them outside the bounds ELK gave the parent.
    const usable = viewWidth - 16;
    const baseAbs = 8 - graphViewportX(laid, viewWidth);

    const walk = (
        parent: ElkNode,
        parentId: string | undefined,
        depth: number,
        inheritedSlide: SlideData,
        parentX: number,
        inheritedReorder?: ReorderSite,
        inheritedStatement?: StatementSite,
    ): void => {
        for (const c of parent.children ?? []) {
            const topLevel = parentId === undefined;
            const w = c.width ?? 0;
            const h = c.height ?? 0;
            const isContainer = (c.children ?? []).length > 0;
            const isStart = c.lhat?.synthetic === "start";
            const isAdd = c.lhat?.synthetic === "add";
            const isReturn = c.lhat?.pictogram === "return";
            const condition = c.lhat?.condition;
            const isCondition = condition !== undefined;
            const synthetic = c.lhat?.synthetic !== undefined;
            // Wrapping rows have no source node. Keep their parent-relative
            // coordinates, but do not draw an extra box or expose handles.
            const layoutOnly = c.lhat === undefined ||
                c.lhat.definitionRole === "row" || c.lhat.layoutOnly === true;
            // A definition row is a source item without a visible box. Its
            // two immediate visible halves share one reorder handle; a normal
            // item's descendants do not inherit that handle.
            const reorder = c.lhat?.reorder ?? inheritedReorder;
            const statement = c.lhat?.statement ?? inheritedStatement;
            const disabled = c.lhat?.disabled === true;
            const detachedValue = parent.lhat?.stackedDefinition === true &&
                c.lhat?.definitionRole === "value";
            let x = c.x ?? 0;
            let y = c.y ?? 0;
            if (condition !== undefined) {
                // Follow the actual statement endpoint (including split
                // declarations/returns and nested sequential groups). All
                // descendants share the owner's slide, so this stays local.
                const entry = condition.entry === undefined ? undefined : endpoints.get(condition.entry);
                const horizontal = condition.axis === "horizontal";
                let target = entry === undefined ? undefined : horizontal ? entry : executionEnd(entry, "Entry");
                let axis = horizontal ? target?.lhat?.definitionHandleY ?? (target?.height ?? 0) / 2
                    : (target?.width ?? 0) / 2;
                while (target !== undefined && target !== parent) {
                    axis += (horizontal ? target.y : target.x) ?? 0;
                    target = parents.get(target.id);
                }
                const size = horizontal ? h : w;
                const extent = (horizontal ? parent.height : parent.width) ?? size;
                if (target === undefined) axis = extent / 2;
                const min = condition.inset;
                const max = Math.max(min, extent - size - condition.inset);
                const aligned = Math.max(min, Math.min(max, axis - size / 2));
                if (horizontal) y = aligned;
                else x = aligned;
            }
            let baseShift = 0;
            if (topLevel && c.lhat?.callTree && !detachedValue && usable > 0 && w <= usable) {
                // Centre the complete statement, not only its execution card.
                baseShift = baseAbs + (usable - w) / 2 - parentX - x;
                x += baseShift;
            } else if (topLevel && (!layoutOnly || c.lhat?.callTree) && !detachedValue && usable > 0 &&
                (w > usable || parentX + x + w > baseAbs + usable)) {
                // Use the placed right edge, not width alone: an expression
                // can fit the viewport but overflow from the execution column.
                baseShift = baseAbs - parentX - x;
                x += baseShift;
            }
            // A wide definition's invisible row and declaration stay fixed;
            // only its lowered value owns the offset. Other wide top-level
            // containers still move as a whole. Deeper boxes never acquire
            // another offset; gestures there are routed to the same owner.
            const canSlide = ownsHorizontalSlide(
                detachedValue, topLevel, layoutOnly && !c.lhat?.callTree, isContainer, usable, w,
                parentX + x - baseAbs);
            const key = canSlide && c.lhat !== undefined ? slideKeyOf(c.lhat) : undefined;
            // Normal boxes stop at the viewport's side margins; a lowered
            // value stops at its initial x or at the viewport's right margin.
            // Only a live rubber-band stretch may go outside these bounds.
            // Saved offsets from a different layout are clamped as before.
            // A detached value starts beside the declaration as before; its
            // rightward stop keeps that initial gap for the definition line.
            const max = detachedValue ? 0 : baseAbs - parentX - x;
            const min = Math.min(max, baseAbs + usable - parentX - x - w);
            const ownDx = key !== undefined
                ? slidePosition(slides[key], { min, max }) : 0;
            const slide: SlideData = topLevel || detachedValue ? {
                slideKey: key,
                slideDx: ownDx,
                slideMin: key !== undefined ? min : undefined,
                slideMax: key !== undefined ? max : undefined,
            } : inheritedSlide;
            x += ownDx;
            // Horizontal only. Vertical is the document's own axis -- the
            // global scroll already covers what sticks out up or down, so a
            // per-node vertical slide would be a second way to do the same
            // thing, and one that bends the execution line for nothing.
            nodes.push({
                id: c.id,
                type: "box",
                position: { x, y },
                parentId,
                // Lift only scroll owners and individual condition boxes,
                // never a condition's whole arm. Disabled code stays behind
                // the execution line that skips it.
                zIndex: disabled ? undefined : isCondition ? CONDITION_Z
                    : key !== undefined ? ACTIVE_SCROLL_Z : undefined,
                // As first-class fields, not style: the minimap decides
                // whether a node exists to draw by nodeHasDimensions(), which
                // reads these and never the style -- with them only in style,
                // the canvas measures its DOM and works while the minimap
                // draws nothing at all.
                width: w,
                height: h,
                // These dimensions are fixed by ELK. Keep them on every
                // update: React Flow treats a missing `measured` as a request
                // to discard handle bounds, hiding ALL edges until the next
                // DOM measurement even when only a scroll offset changed.
                measured: { width: w, height: h },
                // ELK always owns positions. Source list items expose their
                // own insertion D&D control inside BoxNode instead.
                draggable: false,
                connectable: false,
                // Selection keeps pointer events alive for the reading and
                // source-edit gestures without giving React Flow any layout.
                selectable: !layoutOnly,
                focusable: !layoutOnly,
                ariaLabel: isStart ? "Execution start" : isReturn ? "Return"
                    : isAdd ? c.lhat?.insertion ? "Add statement" : "Add element (not yet available)" : undefined,
                data: {
                    ...slide,
                    slideMotion,
                    label: c.labels?.[0]?.text ?? "",
                    labelParts: c.lhat?.labelParts,
                    depth,
                    isContainer,
                    isStart,
                    isAdd,
                    isReturn,
                    isCondition,
                    noExecutionHandles: c.lhat?.noExecutionHandles === true,
                    literal: c.lhat?.literal,
                    literalTypeLabel: c.lhat?.literalTypeLabel,
                    inline: c.lhat?.inline,
                    operator: c.lhat?.operator,
                    decoration: ["signature-title", "signature-arrow", "delimiter", "binding-keyword"].includes(c.lhat?.kind ?? ""),
                    branchOffset: c.lhat?.branchOffset,
                    definitionBranchOffset: c.lhat?.definitionBranchOffset,
                    layoutOnly,
                    scrollSurface: topLevel && c.lhat?.callTree === true,
                    slideOwner: key !== undefined,
                    definitionRole: c.lhat?.definitionRole === "row"
                        ? undefined : c.lhat?.definitionRole,
                    definitionHandleY: c.lhat?.definitionHandleY,
                    ioGroup: c.lhat?.ioGroup,
                    isCall: c.lhat?.invocation === true,
                    collapsed: c.lhat?.collapsed === true,
                    disabled,
                    start: synthetic ? undefined : c.lhat?.start,
                    end: synthetic ? undefined : c.lhat?.revealEnd ?? c.lhat?.end,
                    sourceEnd: synthetic ? undefined : c.lhat?.end,
                    flashed: c.lhat !== undefined &&
                        slideKeyOf(c.lhat) === flashKey,
                    foldable: c.lhat?.foldable === true,
                    // Counter the base-left landing and horizontal slide,
                    // clamping to the frame if it moves past the line's axis.
                    flowHandleX: baseShift !== 0 || ownDx !== 0
                        ? Math.min(Math.max(w / 2 - baseShift - ownDx, 6), w - 6)
                        : undefined,
                    onSlide,
                    onSpring,
                    onDocumentStart,
                    onDocumentSlide,
                    onDocumentRelease,
                    onDocumentSpring,
                    reorder: !layoutOnly && !isStart && !isReturn && !isAdd ? reorder : undefined,
                    statement: synthetic ? undefined : statement,
                    insertion: c.lhat?.definitionRole === "row" && !c.lhat?.insertionAxis ? undefined : c.lhat?.insertion,
                    appendInsertion: c.lhat?.appendInsertion,
                    insertionAxis: c.lhat?.insertionAxis,
                    appendInsertionAxis: c.lhat?.appendInsertionAxis,
                    onReorder,
                    onEnter,
                    onReveal,
                    onFold,
                },
            });

            if (isContainer) {
                walk(c, c.id, depth + (layoutOnly ? 0 : 1), slide, parentX + x,
                    layoutOnly ? reorder : undefined, statement);
            }
        }
        for (const e of parent.edges ?? []) {
            if (e.drawn !== true) continue;
            const source = endpoints.get(e.sources[0]);
            const target = endpoints.get(e.targets[0]);
            if (source === undefined || target === undefined) continue;
            const definition = e.definition === true;
            if (definition && source.lhat?.definitionOutputs?.length === 0) continue;
            (definition ? definitions : exec).push({
                id: `${definition ? "d" : "x"}__${e.id}`,
                source: definition ? source.lhat?.definitionOutputs?.[0] ?? source.id : executionEnd(source, "Exit").id,
                target: definition ? target.id : executionEnd(target, "Entry").id,
                sourceHandle: definition ? "definition-out" : "flow-out",
                targetHandle: definition ? "definition-in" : "flow-in",
                ...(definition ? definitionEdge : routedExecutionEdge),
                selectable: false,
                focusable: false,
            });
        }
        for (const link of parent.lhat?.definitionLinks ?? []) {
            if (!endpoints.has(link.source) || !endpoints.has(link.target)) continue;
            definitions.push({ ...definitionEdge, id: `d__${parent.id}__${link.target}`,
                ...(link.laneOffset === undefined ? {} : { type: "call-definition", data: { laneOffset: link.laneOffset } }),
                source: link.source, target: link.target,
                sourceHandle: "definition-out", targetHandle: "definition-in",
                selectable: false, focusable: false });
        }
        if (parentId !== undefined && !parent.lhat?.disabled) {
            for (const entry of parent.lhat?.executionBranches ?? []) {
                const target = endpoints.get(entry);
                if (target === undefined) continue;
                exec.push({
                    ...branchEdge,
                    id: `x__${parent.id}__branch__${entry}`,
                    source: parent.id, target: executionEnd(target, "Entry").id,
                    sourceHandle: "flow-branch", targetHandle: "flow-in",
                    data: { branchOffset: parent.lhat?.branchOffset },
                    selectable: false, focusable: false,
                });
            }
        }
        if (parentId !== undefined) {
            for (const candidate of parent.lhat?.definitionBranches ?? []) {
                if (!endpoints.has(candidate)) continue;
                definitions.push({
                    ...definitionBranchEdge,
                    id: `d__${parent.id}__branch__${candidate}`,
                    source: candidate, target: parent.id,
                    sourceHandle: "definition-out", targetHandle: "definition-branch",
                    data: { definitionBranchOffset: parent.lhat?.definitionBranchOffset },
                    selectable: false, focusable: false,
                });
            }
        }
    };

    walk(laid, undefined, 1, { slideDx: 0 }, 0);
    return { nodes, exec, definitions };
}

/**
 * 8.6: inertia. Called with the release velocity (px/ms); keeps stepping
 * with exponential decay (0.998 per ms -- iOS's "normal" rate) until the
 * motion is too small to see. Returns the cancel, for the next touch.
 */
function fling(
    velocity: number, step: (d: number) => boolean | void,
): () => void {
    let last = performance.now();
    let vel = velocity;
    let raf = 0;
    const tick = (now: number) => {
        const dt = now - last;
        last = now;
        vel *= Math.pow(0.998, dt);
        if (Math.abs(vel) < 0.02) return;
        // false from the step ends the flight -- it hit a rubber band.
        if (step(vel * dt) === false) return;
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
}

/** The rubber band's return: an ease toward the bound, cancellable. */
function springTo(
    read: () => number, target: number, apply: (v: number) => void,
): () => void {
    let raf = 0;
    const tick = () => {
        const cur = read();
        const next = cur + (target - cur) * 0.18;
        if (Math.abs(target - next) < 0.5) {
            apply(target);
            return;
        }
        apply(next);
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
}

type Sample = { t: number; p: number };

/** Velocity in px/ms over the last stretch of samples, 0 if too brief. */
function releaseVelocity(samples: Sample[]): number {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (last === undefined || first === undefined) return 0;
    const dt = last.t - first.t;
    return dt > 20 ? (last.p - first.p) / dt : 0;
}

const trimSamples = (samples: Sample[], now: number): void => {
    while (samples.length > 1 && now - samples[0].t > 120) samples.shift();
};

/**
 * For every button here. A press with the pointer leaves the button focused,
 * and the browser then shows its focus ring at the next keystroke -- which,
 * over a graph where Shift is React Flow's multi-select, means a ring appears
 * around a button nobody is using and reads as some mode having been entered.
 *
 * Keeping mousedown's default off stops the focus from moving at all. The
 * click still fires. A button reached by Tab is untouched: it takes the focus
 * and keeps the ring, which is who the ring is for.
 */
const keepFocusOff = (event: React.MouseEvent) => event.preventDefault();

// ---------------------------------------------------------------------------
// One node

type ReorderCandidate = {
    site: ReorderSite;
    before: boolean;
    /** A vertical marker follows a horizontal list edge; otherwise horizontal. */
    vertical: boolean;
    rect: DOMRect;
};

type ReorderDrag = {
    pointer: number;
    x: number;
    y: number;
    width: number;
    height: number;
    moved: boolean;
    candidate?: ReorderCandidate;
};

function reorderCandidateAt(x: number, y: number, source: ReorderSite): ReorderCandidate | undefined {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-reorder-list]");
    if (target === null || target === undefined || target.dataset.reorderList !== source.list) return undefined;
    const start = Number(target.dataset.reorderStart), end = Number(target.dataset.reorderEnd);
    const kind = target.dataset.reorderKind as ReorderSite["kind"] | undefined;
    if (!Number.isInteger(start) || !Number.isInteger(end) || kind !== source.kind ||
        (start === source.start && end === source.end)) return undefined;
    const rect = target.getBoundingClientRect();
    // Statements are one vertical sequence. Wrapped element lists may be
    // approached through any side, so the nearer axis selects that edge.
    const vertical = kind === "element" && Math.abs(x - (rect.left + rect.width / 2)) >=
        Math.abs(y - (rect.top + rect.height / 2));
    const before = vertical ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
    return { site: { kind, list: source.list, start, end }, before, vertical, rect };
}

/** One common insertion D&D control, enabled solely by `data.reorder`. */
function ReorderHandle({ site, label, onDrop }: {
    site: ReorderSite;
    label: string;
    onDrop: (source: ReorderSite, target: ReorderSite, before: boolean) => void;
}) {
    const drag = useRef<ReorderDrag | null>(null);
    const [visual, setVisual] = useState<ReorderDrag | null>(null);
    const down = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        const box = event.currentTarget.parentElement?.getBoundingClientRect();
        drag.current = {
            pointer: event.pointerId, x: event.clientX, y: event.clientY,
            width: box?.width ?? 80, height: box?.height ?? 30, moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const move = (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current?.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!current.moved && Math.abs(event.clientX - current.x) + Math.abs(event.clientY - current.y) < 4) return;
        current.moved = true;
        current.x = event.clientX;
        current.y = event.clientY;
        current.candidate = reorderCandidateAt(event.clientX, event.clientY, site);
        setVisual({ ...current });
    };
    const finish = (event: React.PointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (current?.pointer !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = null;
        setVisual(null);
        if (current.moved && current.candidate !== undefined) {
            onDrop(site, current.candidate.site, current.candidate.before);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null;
        setVisual(null);
    };
    const insertion = visual?.candidate;
    return <>
        <div className="node-reorder node-reorder-top" aria-hidden="true"
            onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} />
        <div className="node-reorder node-reorder-right" aria-hidden="true"
            onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} />
        <div className="node-reorder node-reorder-bottom" aria-hidden="true"
            onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} />
        <div className="node-reorder node-reorder-left" aria-hidden="true"
            onPointerDown={down} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} />
        {visual !== null && createPortal(<>
            <div className="reorder-ghost" style={{
                left: visual.x + 12, top: visual.y + 12,
                width: visual.width, minHeight: visual.height,
            }}>{label}</div>
            {insertion !== undefined && <div className={`reorder-insertion ${insertion.vertical ? "vertical" : "horizontal"}`}
                style={insertion.vertical
                    ? { left: insertion.before ? insertion.rect.left - 1 : insertion.rect.right - 1,
                        top: insertion.rect.top, height: insertion.rect.height }
                    : { left: insertion.rect.left,
                        top: insertion.before ? insertion.rect.top - 1 : insertion.rect.bottom - 1,
                        width: insertion.rect.width }} />}
        </>, document.body)}
    </>;
}

function BoxNode({ id, data }: NodeProps<BoxNodeType>) {
    const statements = useStatementActions();
    const { getZoom } = useReactFlow();
    const drag = useRef<{
        x: number; y: number; moved: boolean; axis?: DragAxis; samples: Sample[];
    } | null>(null);
    const flingStop = data.slideMotion;

    // The body of a node belongs to reading. Wide subtrees route horizontal
    // pulls to their top-level box; the narrow vertical cone, and every pull
    // on a node that already fits, route to the document instead. Once chosen,
    // the axis is never changed during this press.
    const onPointerDown = (event: React.PointerEvent) => {
        // An insertion handle owns its frame press. The node body remains a
        // reading surface, so it must not start a partial/document scroll.
        if ((event.target as Element).closest(".node-reorder") !== null) return;
        // Middle press: the browser would start its own autoscroll here, and
        // the click that follows is what shows the text.
        if (event.button === 1) {
            event.preventDefault();
            return;
        }
        // The left button only. The middle one used to slide the contents as
        // well, which put a slide and a scroll on the same gesture.
        if (event.button !== 0) return;
        event.stopPropagation();
        flingStop.current?.();
        flingStop.current = null;
        data.onDocumentStart();
        (event.target as Element).setPointerCapture(event.pointerId);
        drag.current = {
            x: event.clientX, y: event.clientY, moved: false,
            samples: [],
        };
    };
    const onPointerMove = (event: React.PointerEvent) => {
        const d = drag.current;
        if (d === null) return;
        const dx = event.clientX - d.x;
        const dy = event.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        const now = performance.now();
        if (d.axis === undefined) {
            const horizontal = data.slideKey !== undefined &&
                data.slideMin !== undefined && data.slideMax !== undefined &&
                data.slideMin < data.slideMax;
            d.axis = dragAxis(dx, dy, horizontal);
            d.samples.push({
                t: performance.now(),
                p: d.axis === "horizontal" ? d.x : d.y,
            });
        }
        d.moved = true;
        d.x = event.clientX;
        d.y = event.clientY;
        d.samples.push({
            t: now,
            p: d.axis === "horizontal" ? event.clientX : event.clientY,
        });
        trimSamples(d.samples, now);
        if (d.axis === "vertical") {
            data.onDocumentSlide(dy, "drag");
        } else if (data.slideKey !== undefined) {
            // Screen pixels over canvas zoom = graph units.
            const zoom = getZoom() || 1;
            data.onSlide(data.slideKey, dx / zoom, "drag");
        }
    };
    const onPointerUp = (event: React.PointerEvent) => {
        if (event.button !== 0 || drag.current === null) return;
        const dragged = drag.current;
        const wasDrag = dragged.moved;
        drag.current = null;
        // A press that never moved was a click on the box, not a slide.
        if (!wasDrag) {
            if (data.slideKey !== undefined) data.onSpring(data.slideKey);
            data.onEnter(data);
            return;
        }
        const now = performance.now();
        dragged.samples.push({
            t: now,
            p: dragged.axis === "horizontal" ? event.clientX : event.clientY,
        });
        trimSamples(dragged.samples, now);
        const velocity = releaseVelocity(dragged.samples);
        if (dragged.axis === "vertical") {
            data.onDocumentRelease(velocity);
            return;
        }
        if (data.slideKey === undefined) return;
        const key = data.slideKey;
        const min = data.slideMin;
        const max = data.slideMax;
        if (min !== undefined && max !== undefined &&
            (data.slideDx < min || data.slideDx > max)) {
            data.onSpring(key);
            return;
        }
        // A fling can pull the band briefly; reaching an edge then gives
        // control to the same spring used when releasing a stretched drag.
        if (min !== undefined && max !== undefined &&
            Math.abs(velocity) > 0.05) {
            let acc = data.slideDx;
            flingStop.current = fling(velocity, (d) => {
                acc += d;
                data.onSlide(key, d, "glide");
                if (acc < min || acc > max) {
                    data.onSpring(key);
                    return false;
                }
            });
        }
    };
    const onPointerCancel = () => {
        const cancelled = drag.current;
        drag.current = null;
        if (cancelled?.axis === "vertical") data.onDocumentSpring();
        else if (data.slideKey !== undefined) data.onSpring(data.slideKey);
    };

    // Showing the text is the middle button's. On the left it kept firing
    // when a scroll was what was meant -- the gestures start
    // the same way, and only the one that turns out not to be a drag can be
    // told apart, by which time the text has already been jumped to.
    const onAuxClick = (event: React.MouseEvent) => {
        if (event.button !== 1) return;
        event.preventDefault();
        data.onReveal(data);
    };

    // Match arms share their FOR's box. The invisible grouping still owns
    // the branch junction, unlike a declaration row with no handles at all.
    if (data.layoutOnly && !data.scrollSurface && !data.insertion && data.definitionRole === undefined &&
        data.branchOffset === undefined && data.definitionBranchOffset === undefined) return null;

    const classes = ["box"];
    if (data.ioGroup) classes.push("io-group", `io-${data.ioGroup}`);
    if (data.isCall) classes.push("call-node");
    if (data.isStart) classes.push("start-node");
    if (data.isReturn) classes.push("return-node");
    if (data.isCondition) classes.push("condition-node");
    if (data.literal !== undefined) classes.push("literal-node", `literal-${data.literal.kind}`);
    if (data.isAdd) classes.push("add-node");
    if (data.flashed) classes.push("flash");
    if (data.collapsed) classes.push("folded");
    else if (data.isContainer) classes.push(`container d${Math.min(data.depth, 6)}`);
    else classes.push("leaf");
    if (data.disabled) classes.push("disabled");
    const visibleParts = data.labelParts?.filter(part => part.text.trim());
    const leafSymbol = !data.disabled && !data.isContainer && visibleParts?.length === 1
        ? visibleParts[0].symbol : undefined;
    // No `nopan` here. It was what kept a slide from dragging the canvas with
    // it, back when a drag could pan; with panOnDrag off there is nothing left
    // to hold back -- and the class would cost us, since inside one React Flow
    // stops the wheel from scrolling too.

    return (
        <>
            {data.scrollSurface && <div className="call-tree-surface"
                data-source-start={data.start} data-source-end={data.sourceEnd}
                data-vscode-context={statements.context(data.statement)}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
                onAuxClick={onAuxClick} />}
            {data.insertion && !data.isAdd && <StatementButton site={data.insertion}
                axis={data.insertionAxis}
                style={data.insertionAxis === "horizontal" ? { left: "calc(-18.7px * var(--lhat-scale))", top: "calc(50% - 7.7px * var(--lhat-scale))" }
                    : { left: data.insertionAxis ? "calc(50% - 7.7px * var(--lhat-scale))"
                        : data.flowHandleX === undefined ? "calc(50% - 24px * var(--lhat-scale))"
                        : `calc(${data.flowHandleX}px - 24px * var(--lhat-scale))` }} />}
            {data.appendInsertion && <StatementButton site={data.appendInsertion} append floating
                axis={data.appendInsertionAxis ?? data.insertionAxis ?? "horizontal"}
                style={(data.appendInsertionAxis ?? data.insertionAxis) === "vertical"
                    ? { right: "auto", left: "calc(50% - 7.7px * var(--lhat-scale))",
                        top: "calc(100% + 4px * var(--lhat-scale))" } : undefined} />}
            {!data.layoutOnly && <div
                className={[...classes, data.inline ? "inline-box" : "", data.operator ? "operator-box" : "", data.decoration ? "decoration" : ""].join(" ")}
                data-source-start={data.start} data-source-end={data.sourceEnd}
                data-vscode-context={statements.context(data.statement)}
                data-reference-start={leafSymbol?.start} data-reference-end={leafSymbol?.end}
                data-reorder-list={data.reorder?.list}
                data-reorder-kind={data.reorder?.kind}
                data-reorder-start={data.reorder?.start}
                data-reorder-end={data.reorder?.end}
                title={data.isStart ? "Execution start"
                    : data.isReturn ? "Return"
                    : data.isAdd && !data.insertion ? "Add element (editing is not yet available)" : undefined}
                role={data.isStart || data.isReturn ? "img" : data.isAdd && !data.insertion ? "button" : undefined}
                aria-label={data.isStart ? "Execution start" : data.isReturn ? "Return"
                    : data.isAdd ? "Add element" : undefined}
                aria-disabled={data.isAdd && !data.insertion ? true : undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onAuxClick={onAuxClick}
                onContextMenu={data.operator ? event => { event.preventDefault(); event.stopPropagation(); statements.operator(data.operator!, event.currentTarget); } : undefined}
                tabIndex={data.operator ? 0 : undefined}
                onKeyDown={data.operator ? event => {
                    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                        event.preventDefault(); event.stopPropagation(); statements.operator(data.operator!, event.currentTarget);
                    }
                } : undefined}
            >
                {data.reorder !== undefined && <ReorderHandle site={data.reorder} label={data.label}
                    onDrop={data.onReorder} />}
                {data.foldable && (
                    // Its own gestures, kept off the box's: a press here must
                    // not start a slide, and the click must not be read as
                    // going into the definition.
                    <button
                        type="button"
                        className="foldbtn"
                        title={data.collapsed
                            ? "Unfold this definition"
                            : "Fold this definition shut"}
                        onMouseDown={keepFocusOff}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            data.onFold(data);
                        }}
                    >{data.collapsed ? "▸" : "▾"}</button>
                )}
                {data.isStart ? (
                    <svg className="start-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M 6.5 8 L 17.5 8 L 12 17 Z" />
                    </svg>
                ) : data.isReturn ? (
                    <svg className="return-icon" viewBox="0 0 24 24" aria-hidden="true">
                        {/* ↵ rotated clockwise: the bent arrow points up. */}
                        <path d="M 18 17 H 9 V 6 M 5 10 L 9 6 L 13 10" />
                    </svg>
                ) : data.isAdd && data.insertion ? <StatementButton site={data.insertion} append /> : data.isAdd ? (
                    <svg className="add-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M 12 6 V 18 M 6 12 H 18" />
                    </svg>
                ) : data.operator ? <div className="operator-cell"><span>{l10n.t("Operator")}</span><span>{data.operator.text}</span></div>
                : data.ioGroup ? <fieldset className="io-frame"><legend>{data.label}</legend></fieldset>
                : data.inline && data.isContainer ? null : data.literal !== undefined ? <>
                    <div className="literal-type-label"><TypeLabel label={data.literalTypeLabel ?? "?"} /></div>
                    <LiteralInput key={data.literal.key} literal={data.literal} />
                </> : <div className="boxlabel"><span>{data.labelParts?.map((part, i) => part.typeSite !== undefined || part.typeLabel !== undefined
                    ? <span key={i} className="typed-name">
                        <TypeLabel site={part.typeSite} label={part.typeLabel ?? "?"} />
                        {part.name ? <NameInput name={part.name} /> : <span data-reference-start={part.symbol?.start}
                            data-reference-end={part.symbol?.end}>{part.text}</span>}
                      </span> : part.name !== undefined
                    ? <NameInput key={i} name={part.name} /> : part.role === undefined
                    ? <span key={i} data-reference-start={part.symbol?.start} data-reference-end={part.symbol?.end}>{part.text}</span>
                    : <span key={i} className="semantic-label" data-role={part.role} data-category={part.category}
                        data-reference-start={part.symbol?.start} data-reference-end={part.symbol?.end}
                        title={part.source}>{part.text}</span>) ?? data.label}</span></div>}
            </div>}
            {/* Execution ports counter the box's horizontal slide, keeping
                the outer execution chain on the document's axis. */}
            {!data.isAdd && !data.isCondition && !data.noExecutionHandles && data.definitionRole !== "value" &&
                data.definitionBranchOffset === undefined && (
                <>
                    {!data.isStart && <Handle type="target" position={Position.Top} id="flow-in"
                            className="flowhandle" isConnectable={false}
                            style={data.flowHandleX !== undefined
                                ? { left: data.flowHandleX } : undefined} />}
                    {data.branchOffset !== undefined && (
                        <Handle type="source" position={Position.Top} id="flow-branch"
                                className="flowhandle" isConnectable={false}
                                style={data.flowHandleX !== undefined
                                    ? { left: data.flowHandleX } : undefined} />
                    )}
                    <Handle type="source" position={Position.Bottom} id="flow-out"
                            className="flowhandle" isConnectable={false}
                            style={data.flowHandleX !== undefined
                                ? { left: data.flowHandleX } : undefined} />
                </>
            )}
            {data.definitionRole === "declaration" && (
                <Handle type="target" position={Position.Right} id="definition-in"
                        className="definitionhandle" isConnectable={false}
                        style={{ top: data.definitionHandleY }} />
            )}
            {data.definitionBranchOffset !== undefined && (
                <Handle type="target" position={Position.Left} id="definition-branch"
                        className="definitionhandle" isConnectable={false}
                        style={{ top: data.definitionHandleY }} />
            )}
            {(data.definitionRole === "value" || data.definitionBranchOffset !== undefined) && (
                <Handle type="source" position={Position.Left} id="definition-out"
                        className="definitionhandle" isConnectable={false}
                        style={{ top: data.definitionHandleY }} />
            )}
        </>
    );
}

const nodeTypes: NodeTypes = { box: BoxNode };

function ExecutionEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd }: EdgeProps) {
    // A statement's output can be on a short leading card while its argument
    // tree extends far below it. Cross horizontally only near the next entry,
    // in the inter-statement gap, rather than through that argument tree.
    const clearance = Math.min(12, Math.max(0, (targetY - sourceY) / 2));
    const [path] = getSmoothStepPath({
        sourceX, sourceY, targetX, targetY,
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        ...executionEdge.pathOptions,
        ...(targetY > sourceY ? { centerY: targetY - clearance } : {}),
    });
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

// The branch output shares its top input position, but heads down into
// the box. Every arm uses one header lane, regardless of its target's depth.
function BranchEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps) {
    const offset = typeof data?.branchOffset === "number" ? data.branchOffset : 18;
    const [path] = getSmoothStepPath({
        sourceX, sourceY, targetX, targetY,
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        ...executionEdge.pathOptions, centerY: sourceY + offset,
    });
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

function DefinitionBranchEdge({ id, sourceX, sourceY, targetX, targetY, style, data }: EdgeProps) {
    const offset = typeof data?.definitionBranchOffset === "number" ? data.definitionBranchOffset : 18;
    const [path] = getSmoothStepPath({
        sourceX, sourceY, targetX, targetY,
        sourcePosition: Position.Left, targetPosition: Position.Right,
        ...definitionEdge.pathOptions, centerX: targetX + offset,
    });
    return <BaseEdge id={id} path={path} style={style} />;
}

function CallDefinitionEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps) {
    const offset = typeof data?.laneOffset === "number" ? data.laneOffset : (sourceX - targetX) / 2;
    const [path] = getSmoothStepPath({
        sourceX, sourceY, targetX, targetY,
        sourcePosition: Position.Left, targetPosition: Position.Right,
        ...definitionEdge.pathOptions, centerX: targetX + offset,
    });
    return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

const edgeTypes: EdgeTypes = { execution: ExecutionEdge, branch: BranchEdge, "definition-branch": DefinitionBranchEdge, "call-definition": CallDefinitionEdge };

// ---------------------------------------------------------------------------
// The app

function countNodes(n: ElkNode, root = true): number {
    let total = root || n.lhat === undefined || n.lhat.definitionRole === "row" || n.lhat.layoutOnly ? 0 : 1;
    for (const c of n.children ?? []) total += countNodes(c, false);
    return total;
}

/**
 * How many of what this view shows are folded shut. Read off the laid-out
 * graph rather than kept alongside it: the state is the picture, and a flag
 * held next to it would have to be right about the default, every fold set by
 * hand, and what drilling in leaves out of the view. A folded node has no
 * children in the graph, so what is inside one is not counted -- which is
 * what makes this "shown", not "in the file".
 */
function countFolded(n: ElkNode): number {
    let total = n.lhat?.collapsed === true ? 1 : 0;
    for (const c of n.children ?? []) total += countFolded(c);
    return total;
}

function App() {
    const { setViewport, getViewport } = useReactFlow();
    const layoutClient = useMemo(() => new LayoutClient(() => {
        const url = document.getElementById("root")?.dataset.layoutWorker;
        if (!url) return Promise.reject(new Error("Graph layout worker URL is missing."));
        return createLayoutEngine(url);
    }), []);
    useEffect(() => () => layoutClient.dispose(), [layoutClient]);
    const [vocabulary, setVocabulary] = useState(graphVocabulary);
    const [reply, setReply] = useState<AstReply>();
    const [uri, setUri] = useState("");
    const [version, setVersion] = useState<number>();
    const sourceKey = `${uri}\0${reply?.source ?? ""}`;
    const [literalSizes, setLiteralSizes] = useState({ sourceKey: "", values: {} as Record<string, string> });
    if (literalSizes.sourceKey !== sourceKey) setLiteralSizes({ sourceKey, values: {} });
    const commitLiteral = useCallback((literal: LiteralValue, value: string) => {
        setLiteralSizes(previous => {
            const values = previous.sourceKey === sourceKey ? previous.values : {};
            if ((values[literal.key] ?? literal.value) === value) return previous;
            const next = { ...values };
            if (value === literal.value) delete next[literal.key];
            else next[literal.key] = value;
            return { sourceKey, values: next };
        });
    }, [sourceKey]);
    const [nameSizes, setNameSizes] = useState({ sourceKey: "", values: {} as Record<string, string> });
    if (nameSizes.sourceKey !== sourceKey) setNameSizes({ sourceKey, values: {} });
    const resizeName = useCallback((name: RenameTarget, value: string) => {
        setNameSizes(previous => {
            const values = previous.sourceKey === sourceKey ? previous.values : {};
            const key = renameTargetKey(name);
            if ((values[key] ?? name.value) === value) return previous;
            const next = { ...values };
            if (value === name.value) delete next[key];
            else next[key] = value;
            return { sourceKey, values: next };
        });
    }, [sourceKey]);
    const [note, setNote] = useState("waiting for the language server…");
    // V15: what a node with nothing said about it does. Not the state of the
    // bar's button -- that is read off the graph (countFolded) -- and not
    // something to reason from: after one press of the button and a few of the
    // node's own, this alone says nothing about what is on screen.
    const [foldByDefault, setFoldByDefault] = useState(true);
    // What the reader folded or unfolded one at a time, over that default.
    const [folds, setFolds] = useState<Record<number, boolean>>({});
    const [trail, setTrail] = useState<number[]>([]);
    const [slides, setSlides] = useState<Slides>({});
    const slidesRef = useRef(slides);
    slidesRef.current = slides;
    const [laid, setLaid] = useState<ElkNode>();
    const [laidSourceKey, setLaidSourceKey] = useState("");
    const [layoutPending, setLayoutPending] = useState(true);
    const slideMotion = useRef<(() => void) | null>(null);
    const paneFling = useRef<(() => void) | null>(null);
    // The document's vertical rubber band is also used by node-body drags.
    const scrollBounds = useRef({ min: 8, max: 8 });
    // 8.6: zoom is the type size. The scale everything else derives from it.
    const [fontPx, setFontPx] = useState(DEFAULT_FONT_PX);
    const [minimapCollapsed, setMinimapCollapsed] = useState(false);
    const [preferredMinimapSize, setPreferredMinimapSize] = useState(DEFAULT_MINIMAP_SIZE);
    const scale = fontPx / DEFAULT_FONT_PX;
    // 8.6: the width the view has -- a ceiling for wrapping, re-measured on
    // resize. Zero until first measured; nothing lays out before that.
    const [viewWidth, setViewWidth] = useState(0);
    const [viewHeight, setViewHeight] = useState(0);
    const flowRef = useRef<HTMLDivElement | null>(null);
    // What the outline last asked to be shown, and the box it landed on.
    const [wanted, setWanted] = useState<{ start: number; end: number }>();
    const [flashKey, setFlashKey] = useState<string>();
    const flashTimer = useRef<number | undefined>(undefined);
    const reorderRequest = useRef<string | undefined>(undefined);

    useEffect(() => {
        const el = flowRef.current;
        if (el === null) return;
        let timer: number | undefined;
        const ro = new ResizeObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                setViewWidth(el.clientWidth);
                setViewHeight(el.clientHeight);
            }, 150);
        });
        ro.observe(el);
        setViewWidth(el.clientWidth);
        setViewHeight(el.clientHeight);
        return () => { window.clearTimeout(timer); ro.disconnect(); };
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent<ToWebview>) => {
            const message = event.data;
            switch (message.type) {
                case "localization":
                    configureLocalization(message.bundle);
                    document.documentElement.lang = message.language;
                    setVocabulary(graphVocabulary());
                    break;
                case "tree":
                    setReply(message.reply);
                    setUri(message.uri);
                    setVersion(message.version);
                    break;
                case "pending":
                    setNote("waiting for the language server…");
                    break;
                case "error":
                    setNote(message.message);
                    break;
                case "renameResult":
                case "statementResult":
                    if (message.error) setNote(message.error);
                    break;
                case "reorderResult":
                    if (message.id === reorderRequest.current) {
                        reorderRequest.current = undefined;
                        if (message.error) setNote(message.error);
                    }
                    break;
                case "focus":
                    setWanted({ start: message.start, end: message.end });
                    break;
            }
        };
        window.addEventListener("message", onMessage);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    }, []);

    // 8.2: the trail, resolved against the current tree -- positions rather
    // than nodes, so it survives the tree being replaced after an edit.
    const view = useMemo(() => {
        if (reply === undefined) return undefined;
        const path: AstNode[] = [];
        let root = reply.root;
        for (const start of trail) {
            const found = nodeAt(reply.root, start);
            if (found === undefined) break;
            path.push(found);
            root = found;
        }
        return { root, path };
    }, [reply, trail]);

    useEffect(() => {
        if (reply === undefined || view === undefined) return;
        if (viewWidth === 0) return;
        let stale = false;
        setLayoutPending(true);
        const request = layoutClient.layout(reply, {
            vocabulary,
            literalValues: literalSizes.sourceKey === sourceKey ? literalSizes.values : undefined,
            nameValues: nameSizes.sourceKey === sourceKey ? nameSizes.values : undefined,
            collapse: foldByDefault,
            folds,
            root: view.path.length > 0 ? view.root : undefined,
            scale,
            width: viewWidth - 16,
        });
        void request.promise.then((result) => {
            if (stale || !result) return;
            const done = result.graph;
            setLaid(done);
            setLaidSourceKey(sourceKey);
            setLayoutPending(false);
            const folded = countFolded(done);
            setNote(`${countNodes(done)} nodes, ` +
                `${Math.round(result.elapsed)}ms` +
                (folded > 0 ? `, ${folded} folded` : ""));
        }, (reason: unknown) => {
            if (!stale) setNote(l10n.t("Graph layout failed: {0}", reason instanceof Error ? reason.message : String(reason)));
        });
        return () => { stale = true; request.cancel(); };
    }, [reply, view, foldByDefault, folds, scale, viewWidth, vocabulary, literalSizes, nameSizes, sourceKey, layoutClient]);

    // What the bar's button says and does, both from the picture itself. One
    // definition still folded is enough to make the press an unfold: the way
    // out of a half-open view is a single press, whichever half it is in.
    const folded = useMemo(
        () => (laid === undefined ? 0 : countFolded(laid)), [laid]);

    // 8.6: there is no fitView in a document, and no free horizontal
    // position either. The view's x always holds the document's axis -- the
    // vertical centre line the execution line runs down -- at the middle of
    // the screen, re-derived from every layout, so a re-layout at another
    // type size cannot drift the picture sideways. Split declarations limit
    // this centring only if their actual left edge would leave the view.
    // Negative x is valid: a wide box hangs from the base left edge (toFlow)
    // while narrow statements retain their central position.
    //
    // y is the one axis the reader owns. It resets to the top only when the
    // view is a different thing to look at (another definition, Fold/Unfold
    // All); a re-layout in place keeps it.
    const place = useRef(true);
    const viewportHomeX = useRef<number | undefined>(undefined);
    const horizontalReturn = useRef<(() => void) | null>(null);
    const minimapPointer = useRef<number | undefined>(undefined);
    const stopHorizontalReturn = useCallback(() => {
        horizontalReturn.current?.();
        horizontalReturn.current = null;
    }, []);
    const returnHorizontal = useCallback(() => {
        const target = viewportHomeX.current;
        // MiniMap pans via programmatic viewport changes, so onMoveEnd fires
        // for every drag step too. Wait for release, and ignore our own frames.
        if (target === undefined || minimapPointer.current !== undefined ||
            horizontalReturn.current !== null || Math.abs(getViewport().x - target) < 0.01) return;
        horizontalReturn.current = springTo(() => getViewport().x, target, (x) => {
            // Read y on every frame: vertical scrolling remains independent.
            void setViewport({ ...getViewport(), x });
            if (x === target) horizontalReturn.current = null;
        });
    }, [getViewport, setViewport]);
    const onMinimapPointerDown = useCallback((event: React.PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary ||
            (event.target as Element).closest(".react-flow__minimap") === null) return;
        stopHorizontalReturn();
        minimapPointer.current = event.pointerId;
    }, [stopHorizontalReturn]);
    useEffect(() => {
        const release = (event: PointerEvent) => {
            if (minimapPointer.current !== event.pointerId) return;
            minimapPointer.current = undefined;
            returnHorizontal();
        };
        const blur = () => {
            minimapPointer.current = undefined;
            returnHorizontal();
        };
        // Release can occur outside the small map. Capture precedes d3's
        // mouse handlers; the return starts on the next animation frame.
        window.addEventListener("pointerup", release, true);
        window.addEventListener("pointercancel", release, true);
        window.addEventListener("blur", blur);
        return () => {
            stopHorizontalReturn();
            window.removeEventListener("pointerup", release, true);
            window.removeEventListener("pointercancel", release, true);
            window.removeEventListener("blur", blur);
        };
    }, [returnHorizontal, stopHorizontalReturn]);
    useEffect(() => stopHorizontalReturn, [trail, stopHorizontalReturn]);
    useEffect(() => {
        if (laid === undefined) return;
        const w = flowRef.current?.clientWidth ?? 0;
        const y = place.current ? 8 : getViewport().y;
        place.current = false;
        stopHorizontalReturn();
        viewportHomeX.current = graphViewportX(laid, w);
        setViewport({ x: viewportHomeX.current, y, zoom: 1 });
    }, [laid, viewWidth, setViewport, getViewport, stopHorizontalReturn]);

    const slideBounds = useRef(new Map<string, SlideBounds>());
    const onSlide = useCallback((key: string, dx: number, mode?: "drag" | "glide") => {
        setSlides((s) => {
            const bounds = slideBounds.current.get(key);
            if (bounds === undefined) return s;
            // Start from the displayed position, even if the saved offset is
            // outside newly resized bounds. Excess input must not accumulate:
            // reversing direction at an edge should move the box immediately.
            const current = slidePosition(s[key], bounds);
            const next = mode === "drag" ? rubberSlide(current, dx, bounds)
                : mode === "glide"
                    ? clampSlide(current + dx, bounds.min - 96, bounds.max + 96)
                    : clampSlide(clampSlide(current, bounds.min, bounds.max) + dx,
                                 bounds.min, bounds.max);
            const elastic = next < bounds.min || next > bounds.max ? bounds : undefined;
            if (next === s[key]?.dx && elastic === s[key]?.elastic) return s;
            return { ...s, [key]: { dx: next, dy: 0, elastic } };
        });
    }, []);
    const onSlideRef = useRef(onSlide);
    onSlideRef.current = onSlide;

    const onSpring = useCallback((key: string) => {
        slideMotion.current?.();
        const bounds = slideBounds.current.get(key);
        if (bounds === undefined) return;
        // Start reading on the first animation frame: a fling may have just
        // queued the last movement and React has not rendered it yet.
        const read = () => slidePosition(slidesRef.current[key], bounds);
        const apply = (dx: number) => {
            setSlides((s) => ({ ...s, [key]: {
                dx, dy: 0,
                elastic: dx < bounds.min || dx > bounds.max ? bounds : undefined,
            } }));
        };
        let cancel = () => cancelAnimationFrame(frame);
        const frame = requestAnimationFrame(() => {
            const target = clampSlide(read(), bounds.min, bounds.max);
            cancel = springTo(read, target, apply);
        });
        slideMotion.current = () => cancel();
    }, []);

    const onDocumentStart = useCallback(() => {
        paneFling.current?.();
        paneFling.current = null;
    }, []);
    const onDocumentSlide = useCallback((dy: number, mode?: "drag" | "glide") => {
        const viewport = getViewport();
        const bounds = scrollBounds.current;
        const y = mode === "drag" ? rubberSlide(viewport.y, dy, bounds)
            : mode === "glide"
                ? clampSlide(viewport.y + dy, bounds.min - 96, bounds.max + 96)
                : clampSlide(viewport.y + dy, bounds.min, bounds.max);
        setViewport({ ...viewport, y });
        return y;
    }, [getViewport, setViewport]);
    const onDocumentSpring = useCallback(() => {
        paneFling.current?.();
        const bounds = scrollBounds.current;
        const read = () => getViewport().y;
        const apply = (y: number) => {
            const viewport = getViewport();
            setViewport({ ...viewport, y });
        };
        paneFling.current = springTo(read,
            clampSlide(read(), bounds.min, bounds.max), apply);
    }, [getViewport, setViewport]);
    const onDocumentRelease = useCallback((velocity: number) => {
        const bounds = scrollBounds.current;
        const y = getViewport().y;
        if (y < bounds.min || y > bounds.max) {
            onDocumentSpring();
            return;
        }
        if (Math.abs(velocity) <= 0.05) return;
        paneFling.current = fling(velocity, (d) => {
            const next = onDocumentSlide(d, "glide");
            const currentBounds = scrollBounds.current;
            if (next < currentBounds.min || next > currentBounds.max) {
                onDocumentSpring();
                return false;
            }
        });
    }, [getViewport, onDocumentSlide, onDocumentSpring]);

    // Re-grabbing the same box takes over from its current spring position.
    // Switching to another box or using the wheel ends any old stretch.
    const stopSlide = useCallback((keepKey?: string) => {
        slideMotion.current?.();
        slideMotion.current = null;
        setSlides((s) => {
            let next = s;
            for (const [key, saved] of Object.entries(s)) {
                if (saved.elastic === undefined || key === keepKey) continue;
                const bounds = slideBounds.current.get(key) ?? saved.elastic;
                if (next === s) next = { ...s };
                next[key] = { dx: clampSlide(saved.dx, bounds.min, bounds.max), dy: 0 };
            }
            return next;
        });
    }, []);
    // A fold, resize or change of view replaces the boxes and their bounds.
    useEffect(() => {
        stopSlide();
        return () => { slideMotion.current?.(); };
    }, [laid, viewWidth, stopSlide]);

    // 8.2: a folded definition is a way in. Anything else does nothing on the
    // left button, which is what leaves it free for sliding and connecting.
    const onEnter = useCallback((data: BoxData) => {
        if (reply === undefined || data.start === undefined) return;
        if (!data.collapsed) return;
        const start = data.start;
        if (nodeAt(reply.root, start) !== undefined) {
            setTrail((t) => [...t, start]);
        }
    }, [reply]);

    const onReveal = useCallback((data: BoxData) => {
        if (data.start === undefined || data.end === undefined) return;
        vscode.postMessage({
            type: "reveal", start: data.start, end: data.end,
        });
    }, []);

    // One node's own fold. Written down rather than toggled in place: what it
    // is now comes from the bar's default as often as from an earlier press,
    // so the entry records the state asked for, not a flip of one held here.
    const onFold = useCallback((data: BoxData) => {
        if (data.start === undefined) return;
        const start = data.start;
        setFolds((f) => ({ ...f, [start]: !data.collapsed }));
    }, []);

    // The visual gesture never carries a coordinate. It names two source
    // siblings and an insertion side; the host rewrites that one list and
    // the next AST/ELK pass chooses every displayed position again.
    const onReorder = useCallback((source: ReorderSite, target: ReorderSite, before: boolean) => {
        const editableVersion = laidSourceKey === sourceKey ? version : undefined;
        if (editableVersion === undefined || reorderRequest.current !== undefined ||
            source.list !== target.list || source.kind !== target.kind) return;
        const id = `reorder-${++reorderSequence}`;
        reorderRequest.current = id;
        vscode.postMessage({ type: "reorder", id,
            sourceStart: source.start, sourceEnd: source.end,
            targetStart: target.start, targetEnd: target.end,
            before, version: editableVersion });
    }, [laidSourceKey, sourceKey, version]);

    const flow = useMemo(
        () => (laid !== undefined
            ? toFlow(laid, slides, viewWidth, flashKey,
                     onSlide, onEnter, onReveal, onFold, slideMotion, onSpring,
                     onDocumentStart, onDocumentSlide, onDocumentRelease, onDocumentSpring, onReorder)
            : { nodes: [], exec: [], definitions: [] }),
        [laid, slides, viewWidth, flashKey,
            onSlide, onEnter, onReveal, onFold, onSpring,
            onDocumentStart, onDocumentSlide, onDocumentRelease, onDocumentSpring, onReorder]);
    const nodes = flow.nodes;
    const updateNodeInternals = useUpdateNodeInternals();
    const handleGeometry = useRef(new Map<string, string>());
    useEffect(() => {
        const { changed, geometry } = changedHandles(nodes, handleGeometry.current);
        handleGeometry.current = geometry;
        // Each call updates all absolute positions and notifies every store
        // subscriber. A per-BoxNode call made graph initialization quadratic.
        if (changed.length) updateNodeInternals(changed);
    }, [nodes, updateNodeInternals]);
    slideBounds.current = new Map(nodes.flatMap(({ data }) =>
        data.slideOwner && data.slideKey !== undefined &&
            data.slideMin !== undefined && data.slideMax !== undefined
            ? [[data.slideKey, { min: data.slideMin, max: data.slideMax }]]
            : []));

    // What the wheel needs to know about the node under the pointer, by node
    // id. A ref because the wheel listener is native (below) and must not be
    // re-installed per render.
    const slidables = useMemo(() => {
        const m = new Map<string, string>();
        for (const n of nodes) {
            const d = n.data;
            if (d.slideKey !== undefined) {
                m.set(n.id, d.slideKey);
            }
        }
        return m;
    }, [nodes]);
    const slidablesRef = useRef(slidables);
    slidablesRef.current = slidables;

    // 8.6: how far the document may scroll -- the rubber band's home range.
    // Top of the document at the top margin down to its bottom at the
    // bottom edge; a document shorter than the view just sits at the top.
    useEffect(() => {
        const gh = laid?.height ?? 0;
        scrollBounds.current = {
            min: Math.min(8, viewHeight - gh - 8),
            max: 8,
        };
    }, [laid, viewHeight]);

    // 8.6: dragging the background scrolls the document -- vertically only,
    // like everything global here -- and keeps its momentum when let go.
    //
    // Not React Flow's panOnDrag: that is a d3 listener on the pane, which
    // fires before React's handlers, so turning it on would drag the canvas
    // along with every slide of a box (the trap 8.4 records). This is our own
    // listener on the wrapper instead, taking only presses that began on the
    // background -- a native listener here fires before React's synthetic
    // ones, so it filters by target rather than trusting stopPropagation.
    useEffect(() => {
        const el = flowRef.current;
        if (el === null) return;
        let dragging = false;
        let lastY = 0;
        let samples: Sample[] = [];
        const down = (event: PointerEvent) => {
            onDocumentStart();
            const target = event.target as Element;
            const over = target.closest("[data-id]")?.getAttribute("data-id");
            stopSlide(event.button === 0 && over != null &&
                target.closest("button, input, textarea, .react-flow__handle") === null
                ? slidablesRef.current.get(over) : undefined);
            if (event.button !== 0) return;
            if (target.closest(
                ".react-flow__node, .react-flow__handle," +
                " .document-minimap-panel, .react-flow__minimap, .react-flow__edge, button") !== null) {
                return;
            }
            dragging = true;
            lastY = event.clientY;
            samples = [{ t: performance.now(), p: event.clientY }];
            el.setPointerCapture(event.pointerId);
        };
        const move = (event: PointerEvent) => {
            if (!dragging) return;
            const dy = event.clientY - lastY;
            lastY = event.clientY;
            const now = performance.now();
            samples.push({ t: now, p: event.clientY });
            trimSamples(samples, now);
            onDocumentSlide(dy, "drag");
        };
        const up = () => {
            if (!dragging) return;
            dragging = false;
            onDocumentRelease(releaseVelocity(samples));
        };
        el.addEventListener("pointerdown", down);
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
        return () => {
            paneFling.current?.();
            el.removeEventListener("pointerdown", down);
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
        };
    }, [onDocumentRelease, onDocumentSlide, onDocumentStart, stopSlide]);

    // 8.6's wheel, ahead of React Flow's own: Ctrl resizes the type, Shift
    // scrolls the top-level box containing the node under the pointer.
    // Native and capturing -- React
    // Flow's pan is a d3 listener on a descendant, so only a capture on the
    // ancestor runs first; passive listeners cannot preventDefault, so not
    // that either.
    useEffect(() => {
        const el = flowRef.current;
        if (el === null) return;
        const onWheel = (event: WheelEvent) => {
            if ((event.target as Element).closest?.(".literal-editor, .name-input, .type-label") != null) return;
            paneFling.current?.();
            paneFling.current = null;
            stopSlide();
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                event.stopPropagation();
                const step = event.deltaY > 0 ? -1 : 1;
                setFontPx((v) => Math.min(28, Math.max(7, v + step)));
                return;
            }
            if (!event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            const over = (event.target as Element)
                .closest?.("[data-id]")?.getAttribute("data-id");
            const key = over != null
                ? slidablesRef.current.get(over) : undefined;
            if (key === undefined) return;
            const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
            if (delta !== 0) onSlideRef.current(key, delta > 0 ? -24 : 24);
        };
        el.addEventListener("wheel", onWheel,
            { capture: true, passive: false });
        return () => el.removeEventListener("wheel", onWheel,
            { capture: true });
    }, [stopSlide]);

    // The map is mounted one render after the pane it belongs to.
    //
    // React Flow's MiniMap builds its drag handling in an effect keyed on the
    // pane's panZoom, but installs it in a *second* effect keyed on size and
    // the pannable flags -- nothing that changes when the first one finally
    // runs. Mounted in the same pass as the pane, the map sees panZoom still
    // null, builds nothing, and its installer no-ops on an instance that is
    // not there yet. The instance arrives a render later and is never
    // installed, so the map does not answer the pointer until something
    // resizes it -- which is why leaving the tab and coming back woke it up.
    //
    // A render behind the pane, panZoom is already there and both effects run
    // on the map's own first pass. Keyed to flowKey so a remount of the pane
    // (see the ReactFlow key below) puts the map a render behind again.
    const flowKey = trail.join(",");
    const [readyKey, setReadyKey] = useState<string>();
    useEffect(() => {
        setReadyKey(flowKey);
        place.current = true;
    }, [flowKey]);
    const paneReady = readyKey === flowKey;
    // Numeric dimensions are needed by MiniMap's SVG viewBox calculation.
    // Remember the user's independent width/height even in a smaller split.
    const minimapAvailable = { width: Math.max(0, viewWidth - 24), height: Math.max(0, viewHeight - 24) };
    const minimapSize = fitMinimapSize(preferredMinimapSize, minimapAvailable);

    // The outline picked something: scroll to the box that covers it and mark
    // it. Not necessarily the box for that node -- what the outline names may
    // be inside a folded definition, and a folded box covers the whole span it
    // stands for. The deepest box whose span contains the target is therefore
    // always the right one to show, whatever is open.
    useEffect(() => {
        if (wanted === undefined || laid === undefined) return;
        setWanted(undefined);
        let best: { key: string; y: number; span: number } | undefined;
        const walk = (n: ElkNode, absY: number): void => {
            for (const c of n.children ?? []) {
                const y = absY + (c.y ?? 0);
                const l = c.lhat;
                if (l !== undefined && l.synthetic === undefined && l.definitionRole !== "row" &&
                    l.start <= wanted.start && wanted.end <= l.end) {
                    const span = l.end - l.start;
                    if (best === undefined || span <= best.span) {
                        best = { key: slideKeyOf(l), y, span };
                    }
                }
                walk(c, y);
            }
        };
        walk(laid, 0);
        if (best === undefined) return;
        const found = best;
        // A third of the way down rather than at the very top: what comes
        // before a definition is part of reading it.
        const height = flowRef.current?.clientHeight ?? 0;
        paneFling.current?.();
        paneFling.current = null;
        const b = scrollBounds.current;
        const v = getViewport();
        setViewport({
            ...v,
            y: Math.min(Math.max(-found.y + height / 3, b.min), b.max),
        });
        setFlashKey(found.key);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(
            () => setFlashKey(undefined), 1600);
    }, [wanted, laid, getViewport, setViewport]);

    return (
        <RenameProvider value={{ sourceKey, version: laidSourceKey === sourceKey ? version : undefined,
            sizes: nameSizes.sourceKey === sourceKey ? nameSizes.values : {}, resize: resizeName,
            post: message => vscode.postMessage(message) }}>
        <LiteralEditProvider sourceKey={sourceKey} onCommit={commitLiteral}>
        <TypeProvider value={{ version: laidSourceKey === sourceKey ? version : undefined, post }}>
        <StatementProvider value={{ tree: reply, uri, version: laidSourceKey === sourceKey ? version : undefined, post }}>
        <div id="app">
            <div id="bar">
                <button
                    type="button"
                    className={trail.length > 0 ? "active" : undefined}
                    title={trail.length === 0
                        ? "Not inside a definition"
                        : "Leave this definition"}
                    disabled={trail.length === 0}
                    onMouseDown={keepFocusOff}
                    onClick={() => setTrail((t) => t.slice(0, -1))}
                >▲</button>
                {/* Says what pressing it does, not what state the view is in
                    -- the boxes show that themselves. "All" is meant: it drops
                    every fold set on a single node, so one press puts the whole
                    view in one state again. */}
                <button
                    type="button"
                    className={folded > 0 ? "active" : undefined}
                    title={folded > 0
                        ? "Open every definition"
                        : "Fold every definition shut"}
                    onMouseDown={keepFocusOff}
                    onClick={() => {
                        setFoldByDefault(folded === 0);
                        setFolds({});
                        place.current = true;
                    }}
                >{folded > 0 ? "Unfold All" : "Fold All"}</button>
                <button
                    type="button"
                    title="Smaller text"
                    disabled={fontPx <= 7}
                    onMouseDown={keepFocusOff}
                    onClick={() => setFontPx((v) => Math.max(7, v - 1))}
                >A−</button>
                <button
                    type="button"
                    title={`Larger text (now ${fontPx}px)`}
                    disabled={fontPx >= 28}
                    onMouseDown={keepFocusOff}
                    onClick={() => setFontPx((v) => Math.min(28, v + 1))}
                >A+</button>
                <button
                    type="button"
                    title={`Reset text size (${DEFAULT_FONT_PX}px)`}
                    aria-label="Reset text size to default"
                    disabled={fontPx === DEFAULT_FONT_PX}
                    onMouseDown={keepFocusOff}
                    onClick={() => setFontPx(DEFAULT_FONT_PX)}
                >A↺</button>
                <SvgExport flow={flowRef} disabled={!laid || layoutPending || laidSourceKey !== sourceKey}
                    title={view?.path.map(step => titleOf(step, reply?.source ?? "", vocabulary)).join(" / ") || uri}
                    post={post} />
                <span id="status">{note}</span>
                <LiteralEditStatus />
            </div>
            {view !== undefined && view.path.length > 0 && reply !== undefined && (
                <div id="trail">
                    <button type="button" className="crumb"
                        onMouseDown={keepFocusOff}
                        onClick={() => setTrail([])}>(file)</button>
                    {view.path.map((step, index) => (
                        <React.Fragment key={step.start}>
                            <span className="sep">›</span>
                            <button type="button" className="crumb"
                                onMouseDown={keepFocusOff}
                                onClick={() => setTrail(trail.slice(0, index + 1))}>
                                {titleOf(step, reply.source, vocabulary)}
                            </button>
                        </React.Fragment>
                    ))}
                </div>
            )}
            <div
                id="flow"
                ref={flowRef}
                style={{ "--lhat-scale": String(scale) } as React.CSSProperties}
            >
                <ReactFlow
                    // Remounting is what refits the viewport, so it is done
                    // only when the view is a different thing to look at --
                    // moving into or out of a definition. Folding is not:
                    // shutting a definition leaves the rest of the picture
                    // where it was, and re-zooming to whatever is left throws
                    // the reader off a diagram they had not finished reading.
                    key={flowKey}
                    nodes={nodes}
                    edges={flow.exec.concat(flow.definitions)}
                    nodesConnectable={false}
                    edgesReconnectable={false}
                    edgesFocusable={false}
                    deleteKeyCode={null}
                    onMoveEnd={returnHorizontal}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    // 8.6: a document, not a canvas. The zoom is locked at 1
                    // -- growing the picture is the type-size buttons' job,
                    // a re-layout rather than a transform -- and the only
                    // global movement is vertical. What overflows sideways is
                    // handled by each top-level box with its entire subtree.
                    minZoom={1}
                    maxZoom={1}
                    zoomOnScroll={false}
                    zoomOnPinch={false}
                    zoomOnDoubleClick={false}
                    zoomActivationKeyCode={null}
                    // Dragging never moves the view: a drag on a box slides
                    // its contents (8.3) and nothing else.
                    panOnDrag={false}
                    panOnScroll
                    panOnScrollMode={PanOnScrollMode.Vertical}
                    // The wheel is React Flow's own pan, which no spring of
                    // ours can catch -- so it is clamped hard to the same
                    // range the rubber band comes home to. Programmatic
                    // setViewport bypasses this, which is what lets the
                    // band overshoot at all.
                    translateExtent={[
                        [-1e9, -8],
                        [1e9, Math.max(
                            (laid?.height ?? 0) + 8, viewHeight - 8)],
                    ]}
                >
                    <Background />
                    {paneReady && <Panel position="bottom-right"
                        className={`document-minimap-panel${minimapCollapsed ? " collapsed" : ""}`}
                        onPointerDownCapture={onMinimapPointerDown}>
                        {!minimapCollapsed && minimapSize.width > 0 && minimapSize.height > 0 && <>
                            <MiniMap pannable
                                style={minimapSize}
                                ariaLabel="Document overview"
                                nodeClassName={(node) => node.data.layoutOnly ? "layout-only"
                                    : node.data.isStart || node.data.isReturn ? "start-marker" : ""} />
                            <MinimapResizeHandles size={minimapSize} preferredSize={preferredMinimapSize}
                                available={minimapAvailable} onResize={setPreferredMinimapSize} />
                        </>}
                        <button type="button" className="minimap-toggle"
                            title={minimapCollapsed ? "Expand minimap" : "Collapse minimap"}
                            aria-label={minimapCollapsed ? "Expand minimap" : "Collapse minimap"}
                            aria-expanded={!minimapCollapsed}
                            onMouseDown={keepFocusOff}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => setMinimapCollapsed((value) => !value)}>
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                {minimapCollapsed ? <>
                                    <rect x="5" y="3" width="14" height="18" rx="2" />
                                    <path d="M 8 7 H 16 M 8 11 H 13 M 8 15 H 16" />
                                </> : <path d="M 6 9 L 12 15 L 18 9" />}
                            </svg>
                        </button>
                    </Panel>}
                </ReactFlow>
                <ReferenceLine flow={flowRef} source={reply?.source ?? ""}
                    version={laidSourceKey === sourceKey ? version : undefined} post={post} />
            </div>
        </div>
        </StatementProvider>
        </TypeProvider>
        </LiteralEditProvider>
        </RenameProvider>
    );
}

const root = document.getElementById("root");
if (root !== null) {
    createRoot(root).render(
        <ReactFlowProvider>
            <App />
        </ReactFlowProvider>,
    );
}
