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
import { createRoot } from "react-dom/client";
import {
    Background, ConnectionLineType, Handle, MarkerType, MiniMap, PanOnScrollMode, Position,
    ReactFlow, addEdge, getSmoothStepPath, getStraightPath, useEdgesState, useReactFlow, ReactFlowProvider,
    useUpdateNodeInternals,
    type BuiltInEdge, type Connection, type ConnectionLineComponentProps,
    type Edge, type Node, type NodeProps, type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./rf.css";
import ELK from "elkjs/lib/elk.bundled.js";
import type { AstNode, AstReply, FromWebview, ToWebview } from "../../protocol";
import { graphViewportX, nodeAt, stackWideDefinitions, titleOf, toElk, type ElkNode } from "../map";

declare function acquireVsCodeApi(): {
    postMessage(message: FromWebview): void;
    setState(state: unknown): void;
    getState(): unknown;
};

const vscode = acquireVsCodeApi();
const elk = new ELK();
const DEFAULT_FONT_PX = 12;

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
    depth: number;
    isContainer: boolean;
    layoutOnly: boolean;
    slideOwner: boolean;
    isStart: boolean;
    isAdd: boolean;
    definitionRole?: "declaration" | "value";
    definitionHandleY?: number;
    collapsed: boolean;
    /** 01 の 6.5: written, but switched off. */
    disabled: boolean;
    start?: number;
    end?: number;
    /** Shared across boxes so touching another descendant stops the glide. */
    slideMotion: { current: (() => void) | null };
    onSlide: (key: string, dx: number, mode?: "drag" | "glide") => void;
    /** Return a stretched box to its nearest viewport edge. */
    onSpring: (key: string) => void;
    /**
     * 8.6: where the execution line crosses this box, in its own pixels.
     * Undefined means the middle. A base-left shift moves the box, not the
     * line: the handles stay on the chain's axis -- where the centre was
     * before the shift -- so the line stays vertical and only the box slid.
     */
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

const executionEdge = {
    type: "straight",
    className: "exec",
    // Lines between descendants must stay visible over their enclosing boxes.
    zIndex: 2000,
    markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 11,
        height: 11,
        color: "var(--lhat-exec)",
    },
} satisfies Partial<Edge>;

const definitionEdge = {
    ...executionEdge,
    type: "smoothstep",
    className: "definition",
    // Leave horizontal stubs at both side handles, even when the value
    // scrolls past the declaration. A short offset fits the 28px row gap.
    pathOptions: { borderRadius: 6, offset: 6 },
    markerEnd: { ...executionEdge.markerEnd, color: "var(--vscode-charts-blue, #58a)" },
} satisfies Partial<BuiltInEdge>;

const validConnection = (connection: Connection | Edge): boolean =>
    (connection.sourceHandle === "flow-out" && connection.targetHandle === "flow-in") ||
    (connection.sourceHandle === "definition-out" && connection.targetHandle === "definition-in");

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
): { nodes: BoxNodeType[]; exec: Edge[]; definitions: Edge[] } {
    const nodes: BoxNodeType[] = [];
    // 8.6: the execution lines. The layout's own order-pinning edges (6.3),
    // shown where the mapping marked them -- the statement sequences.
    const exec: Edge[] = [];
    const definitions: Edge[] = [];
    const endpoints = new Map<string, ElkNode>();
    const index = (node: ElkNode): void => {
        endpoints.set(node.id, node);
        for (const port of node.ports ?? []) endpoints.set(port.id, node);
        for (const child of node.children ?? []) index(child);
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
    ): void => {
        for (const c of parent.children ?? []) {
            const topLevel = parentId === undefined;
            const w = c.width ?? 0;
            const h = c.height ?? 0;
            const isContainer = (c.children ?? []).length > 0;
            const isStart = c.lhat?.synthetic === "start";
            const isAdd = c.lhat?.synthetic === "add";
            const synthetic = c.lhat?.synthetic !== undefined;
            const layoutOnly = c.lhat?.definitionRole === "row";
            const detachedValue = parent.lhat?.stackedDefinition === true &&
                c.lhat?.definitionRole === "value";
            let x = c.x ?? 0;
            let baseShift = 0;
            if (topLevel && !layoutOnly && !detachedValue && usable > 0 && w > usable) {
                const shift = baseAbs - x;
                if (shift > 0) {
                    x += shift;
                    baseShift = shift;
                }
            }
            // A wide definition's invisible row and declaration stay fixed;
            // only its lowered value owns the offset. Other wide top-level
            // containers still move as a whole. Deeper boxes never acquire
            // another offset; gestures there are routed to the same owner.
            const canSlide = detachedValue ||
                (topLevel && !layoutOnly && isContainer && usable > 0 && w > usable);
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
            const y = c.y ?? 0;
            nodes.push({
                id: c.id,
                type: "box",
                position: { x, y },
                parentId,
                // As first-class fields, not style: the minimap decides
                // whether a node exists to draw by nodeHasDimensions(), which
                // reads these and never the style -- with them only in style,
                // the canvas measures its DOM and works while the minimap
                // draws nothing at all.
                width: w,
                height: h,
                draggable: false,
                // Not for selection itself: React Flow turns a node's
                // pointer-events off entirely when it is neither selectable
                // nor draggable and no node-level handlers are installed
                // (hasPointerEvents in NodeWrapper) -- which would kill our
                // own pointer handlers, the hover that shows the handles,
                // and every click. Selectable is the cheapest way to keep
                // events flowing.
                selectable: !layoutOnly,
                ariaLabel: isStart ? "Execution start" : isAdd ? "Add element (not yet available)" : undefined,
                data: {
                    ...slide,
                    slideMotion,
                    label: c.labels?.[0]?.text ?? "",
                    depth,
                    isContainer,
                    isStart,
                    isAdd,
                    layoutOnly,
                    slideOwner: key !== undefined,
                    definitionRole: c.lhat?.definitionRole === "row"
                        ? undefined : c.lhat?.definitionRole,
                    definitionHandleY: c.lhat?.definitionHandleY,
                    collapsed: c.lhat?.collapsed === true,
                    disabled: c.lhat?.disabled === true,
                    start: synthetic ? undefined : c.lhat?.start,
                    end: synthetic ? undefined : c.lhat?.revealEnd ?? c.lhat?.end,
                    flashed: c.lhat !== undefined &&
                        slideKeyOf(c.lhat) === flashKey,
                    foldable: c.lhat?.foldable === true,
                    // The line does not follow the box: the handle counters
                    // both the base-left landing and the reader's own slide,
                    // staying on the chain's axis (clamped to the box, so a
                    // slide past the axis bends the line rather than
                    // detaching it).
                    flowHandleX: baseShift > 0 || ownDx !== 0
                        ? Math.min(Math.max(
                            (c.width ?? 0) / 2 - baseShift - ownDx, 6),
                            (c.width ?? 0) - 6)
                        : undefined,
                    onSlide,
                    onSpring,
                    onEnter,
                    onReveal,
                    onFold,
                },
            });

            if (isContainer) {
                walk(c, c.id, depth + (layoutOnly ? 0 : 1), slide, parentX + x);
            }
        }
        for (const e of parent.edges ?? []) {
            if (e.drawn !== true) continue;
            const source = endpoints.get(e.sources[0]);
            const target = endpoints.get(e.targets[0]);
            if (source === undefined || target === undefined) continue;
            const definition = e.definition === true;
            (definition ? definitions : exec).push({
                id: `${definition ? "d" : "x"}__${e.id}`,
                source: definition ? source.id : executionEnd(source, "Exit").id,
                target: definition ? target.id : executionEnd(target, "Entry").id,
                sourceHandle: definition ? "definition-out" : "flow-out",
                targetHandle: definition ? "definition-in" : "flow-in",
                ...(definition ? definitionEdge : executionEdge),
                selectable: false,
                focusable: false,
            });
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

function BoxNode({ id, data }: NodeProps<BoxNodeType>) {
    const { getZoom } = useReactFlow();
    const updateNodeInternals = useUpdateNodeInternals();
    // Moving a handle inside an unchanged-size box does not trigger React
    // Flow's ResizeObserver. Re-measure it so arrows follow the visible port.
    useEffect(() => {
        updateNodeInternals(id);
    }, [id, data.flowHandleX, data.definitionRole, data.definitionHandleY, updateNodeInternals]);
    const drag = useRef<{
        x: number; y: number; moved: boolean; samples: Sample[];
    } | null>(null);
    const flingStop = data.slideMotion;

    // A drag anywhere in a wide subtree moves its top-level box horizontally.
    // React Flow's flat DOM requires explicit routing via the inherited key.
    const onPointerDown = (event: React.PointerEvent) => {
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
        (event.target as Element).setPointerCapture(event.pointerId);
        drag.current = {
            x: event.clientX, y: event.clientY, moved: false,
            samples: [{
                t: performance.now(),
                p: event.clientX,
            }],
        };
    };
    const onPointerMove = (event: React.PointerEvent) => {
        const d = drag.current;
        if (d === null) return;
        const dx = event.clientX - d.x;
        const dy = event.clientY - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        d.moved = true;
        d.x = event.clientX;
        d.y = event.clientY;
        if (data.slideKey === undefined) return;
        const now = performance.now();
        d.samples.push({
            t: now,
            p: event.clientX,
        });
        trimSamples(d.samples, now);
        // Screen pixels over canvas zoom = graph units.
        const zoom = getZoom() || 1;
        data.onSlide(data.slideKey, dx / zoom, "drag");
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
        if (data.slideKey === undefined) return;
        const key = data.slideKey;
        const now = performance.now();
        dragged.samples.push({ t: now, p: event.clientX });
        trimSamples(dragged.samples, now);
        const velocity = releaseVelocity(dragged.samples);
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

    // Showing the text is the middle button's. On the left it kept firing
    // when a slide or a connection was what was meant -- the gestures start
    // the same way, and only the one that turns out not to be a drag can be
    // told apart, by which time the text has already been jumped to.
    const onAuxClick = (event: React.MouseEvent) => {
        if (event.button !== 1) return;
        event.preventDefault();
        data.onReveal(data);
    };

    if (data.layoutOnly) return null;

    const classes = ["box"];
    if (data.isStart) classes.push("start-node");
    if (data.isAdd) classes.push("add-node");
    if (data.flashed) classes.push("flash");
    if (data.collapsed) classes.push("folded");
    else if (data.isContainer) classes.push(`container d${Math.min(data.depth, 6)}`);
    else classes.push("leaf");
    if (data.disabled) classes.push("disabled");
    // No `nopan` here. It was what kept a slide from dragging the canvas with
    // it, back when a drag could pan; with panOnDrag off there is nothing left
    // to hold back -- and the class would cost us, since inside one React Flow
    // stops the wheel from scrolling too.

    return (
        <>
            <div
                className={classes.join(" ")}
                title={data.isStart ? "Execution start"
                    : data.isAdd ? "Add element (editing is not yet available)" : undefined}
                role={data.isStart ? "img" : data.isAdd ? "button" : undefined}
                aria-label={data.isStart ? "Execution start" : data.isAdd ? "Add element" : undefined}
                aria-disabled={data.isAdd ? true : undefined}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                    drag.current = null;
                    if (data.slideKey !== undefined) data.onSpring(data.slideKey);
                }}
                onAuxClick={onAuxClick}
            >
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
                ) : data.isAdd ? (
                    <svg className="add-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M 12 6 V 18 M 6 12 H 18" />
                    </svg>
                ) : <div className="boxlabel">{data.label}</div>}
            </div>
            {/* Use the execution lines' own endpoints as the visible ports:
                incoming at the top, outgoing at the bottom. flowHandleX
                keeps the ports and arrows together while the box slides. */}
            {!data.isAdd && data.definitionRole !== "value" && (
                <>
                    {!data.isStart && <Handle type="target" position={Position.Top} id="flow-in"
                            className="flowhandle" title="Execution input"
                            style={data.flowHandleX !== undefined
                                ? { left: data.flowHandleX } : undefined} />}
                    <Handle type="source" position={Position.Bottom} id="flow-out"
                            className="flowhandle" title="Execution output"
                            style={data.flowHandleX !== undefined
                                ? { left: data.flowHandleX } : undefined} />
                </>
            )}
            {data.definitionRole === "declaration" && (
                <Handle type="target" position={Position.Right} id="definition-in"
                        className="definitionhandle" title="Definition input"
                        style={{ top: data.definitionHandleY }} />
            )}
            {data.definitionRole === "value" && (
                <Handle type="source" position={Position.Left} id="definition-out"
                        className="definitionhandle" title="Definition output"
                        style={{ top: data.definitionHandleY }} />
            )}
        </>
    );
}

const nodeTypes: NodeTypes = { box: BoxNode };

/** Preview the same line shape as the connection being drawn. */
function ConnectionPreview({
    fromX, fromY, toX, toY, fromHandle, fromPosition, connectionLineStyle,
}: ConnectionLineComponentProps) {
    const endpoints = { sourceX: fromX, sourceY: fromY, targetX: toX, targetY: toY };
    const definition = fromHandle.id === "definition-out" || fromHandle.id === "definition-in";
    const [path] = definition ? getSmoothStepPath({
        ...endpoints,
        ...definitionEdge.pathOptions,
        sourcePosition: fromPosition,
        // Keep the free end horizontal too, including a drag begun at the
        // declaration's input handle rather than the value's output handle.
        targetPosition: fromPosition === Position.Left ? Position.Right : Position.Left,
    }) : getStraightPath(endpoints);
    return <path className={`react-flow__connection-path ${definition ? "definition" : "exec"}`} d={path}
                 style={connectionLineStyle} fill="none" />;
}

// ---------------------------------------------------------------------------
// The app

function countNodes(n: ElkNode, root = true): number {
    let total = root || n.lhat?.definitionRole === "row" ? 0 : 1;
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
    const [reply, setReply] = useState<AstReply>();
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
    const slideMotion = useRef<(() => void) | null>(null);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    // 8.6: zoom is the type size. The scale everything else derives from it.
    const [fontPx, setFontPx] = useState(DEFAULT_FONT_PX);
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
                case "tree":
                    setReply(message.reply);
                    break;
                case "pending":
                    setNote("waiting for the language server…");
                    break;
                case "error":
                    setNote(message.message);
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
        const graph = toElk(reply, {
            collapse: foldByDefault,
            folds,
            root: view.path.length > 0 ? view.root : undefined,
            scale,
            width: viewWidth - 16,
        });
        const started = performance.now();
        void elk.layout(graph).then((result) => {
            if (stale) return;
            const done = stackWideDefinitions(result as ElkNode, viewWidth - 16);
            setLaid(done);
            const folded = countFolded(done);
            setNote(`${countNodes(done)} nodes, ` +
                `${Math.round(performance.now() - started)}ms` +
                (folded > 0 ? `, ${folded} folded` : ""));
        });
        return () => { stale = true; };
    }, [reply, view, foldByDefault, folds, scale, viewWidth]);

    // What the bar's button says and does, both from the picture itself. One
    // definition still folded is enough to make the press an unfold: the way
    // out of a half-open view is a single press, whichever half it is in.
    const folded = useMemo(
        () => (laid === undefined ? 0 : countFolded(laid)), [laid]);

    // 8.6: there is no fitView in a document, and no free horizontal
    // position either. The view's x always holds the document's axis -- the
    // vertical centre line the execution line runs down -- at the middle of
    // the screen, re-derived from every layout, so a re-layout at another
    // type size cannot drift the picture sideways. Unclamped: with a
    // definition wider than the view the x goes negative, and that is right
    // -- the wide box hangs from the base left edge (toFlow) while
    // everything narrow stays centred.
    //
    // y is the one axis the reader owns. It resets to the top only when the
    // view is a different thing to look at (another definition, Fold/Unfold
    // All); a re-layout in place keeps it.
    const place = useRef(true);
    useEffect(() => {
        if (laid === undefined) return;
        const w = flowRef.current?.clientWidth ?? 0;
        const y = place.current ? 8 : getViewport().y;
        place.current = false;
        setViewport({ x: graphViewportX(laid, w), y, zoom: 1 });
    }, [laid, viewWidth, setViewport, getViewport]);

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

    const flow = useMemo(
        () => (laid !== undefined
            ? toFlow(laid, slides, viewWidth, flashKey,
                     onSlide, onEnter, onReveal, onFold, slideMotion, onSpring)
            : { nodes: [], exec: [], definitions: [] }),
        [laid, slides, viewWidth, flashKey,
            onSlide, onEnter, onReveal, onFold, onSpring]);
    const nodes = flow.nodes;
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
    const scrollBounds = useRef({ min: 8, max: 8 });
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
    const paneFling = useRef<(() => void) | null>(null);
    useEffect(() => {
        const el = flowRef.current;
        if (el === null) return;
        let dragging = false;
        let lastY = 0;
        let samples: Sample[] = [];
        const down = (event: PointerEvent) => {
            paneFling.current?.();
            paneFling.current = null;
            const target = event.target as Element;
            const over = target.closest("[data-id]")?.getAttribute("data-id");
            stopSlide(event.button === 0 && over != null &&
                target.closest("button, .react-flow__handle") === null
                ? slidablesRef.current.get(over) : undefined);
            if (event.button !== 0) return;
            if (target.closest(
                ".react-flow__node, .react-flow__handle," +
                " .react-flow__minimap, .react-flow__edge, button") !== null) {
                return;
            }
            dragging = true;
            lastY = event.clientY;
            samples = [{ t: performance.now(), p: event.clientY }];
            el.setPointerCapture(event.pointerId);
        };
        const readY = () => getViewport().y;
        const writeY = (y: number) => {
            const v = getViewport();
            setViewport({ ...v, y });
        };
        const spring = () => {
            const b = scrollBounds.current;
            const target = Math.min(Math.max(readY(), b.min), b.max);
            paneFling.current = springTo(readY, target, writeY);
        };
        const move = (event: PointerEvent) => {
            if (!dragging) return;
            let dy = event.clientY - lastY;
            lastY = event.clientY;
            const now = performance.now();
            samples.push({ t: now, p: event.clientY });
            trimSamples(samples, now);
            const y = readY();
            const b = scrollBounds.current;
            // Past either end the drag pulls against the band.
            if ((y > b.max && dy > 0) || (y < b.min && dy < 0)) dy /= 3;
            writeY(y + dy);
        };
        const up = () => {
            if (!dragging) return;
            dragging = false;
            const b = scrollBounds.current;
            const y = readY();
            if (y < b.min || y > b.max) {
                spring();
                return;
            }
            const velocity = releaseVelocity(samples);
            if (Math.abs(velocity) > 0.05) {
                paneFling.current = fling(velocity, (d) => {
                    const ny = readY() + d;
                    writeY(ny);
                    const bounds = scrollBounds.current;
                    if (ny < bounds.min || ny > bounds.max) {
                        spring();
                        return false;
                    }
                });
            }
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
    }, [getViewport, setViewport, stopSlide]);

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

    const onConnect = useCallback((connection: Connection) => {
        // Reconnecting an existing execution arrow must not draw a duplicate.
        if (!validConnection(connection)) return;
        if (flow.exec.concat(flow.definitions).some((edge) =>
            edge.source === connection.source && edge.target === connection.target &&
            edge.sourceHandle === connection.sourceHandle &&
            edge.targetHandle === connection.targetHandle)) return;
        // Edges render in an svg layer below the nodes unless told otherwise,
        // and a line that runs behind the boxes it connects says nothing.
        // Nesting gives a node z of parent+1 (depth ~13 here) and selection
        // adds 1000, so 2000 clears everything.
        setEdges((current) =>
            addEdge({ ...connection,
                ...(connection.sourceHandle === "definition-out" ? definitionEdge : executionEdge),
                zIndex: 2000 }, current));
    }, [flow.exec, flow.definitions, setEdges]);

    return (
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
                <span id="status">{note}</span>
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
                                {titleOf(step, reply.source)}
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
                    edges={flow.exec.concat(flow.definitions, edges)}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    isValidConnection={validConnection}
                    connectionLineType={ConnectionLineType.Straight}
                    connectionLineComponent={ConnectionPreview}
                    nodeTypes={nodeTypes}
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
                    {paneReady && <MiniMap pannable
                        nodeClassName={(node) => node.data.layoutOnly ? "layout-only"
                            : node.data.isStart ? "start-marker" : ""} />}
                </ReactFlow>
            </div>
        </div>
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
