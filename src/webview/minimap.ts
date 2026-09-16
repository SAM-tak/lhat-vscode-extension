export interface MinimapSize { width: number; height: number }
export type MinimapResizeEdge = "left" | "top" | "top-left";
export interface MinimapResizeDelta { x: number; y: number }

export const DEFAULT_MINIMAP_SIZE: MinimapSize = { width: 140, height: 220 };
export const MIN_MINIMAP_SIZE = 80;

/** Clamp the displayed size, not the user's remembered preference. */
export function fitMinimapSize(size: MinimapSize, available: MinimapSize): MinimapSize {
    const fit = (value: number, limit: number) => {
        const max = Math.max(0, limit);
        return Math.min(max, Math.max(Math.min(MIN_MINIMAP_SIZE, max), value));
    };
    return { width: fit(size.width, available.width), height: fit(size.height, available.height) };
}

/** The bottom/right stay anchored: dragging left/up increases the size. */
export function resizeMinimap(size: MinimapSize, edge: MinimapResizeEdge, delta: MinimapResizeDelta,
                              available: MinimapSize): MinimapSize {
    return fitMinimapSize({
        width: size.width - (edge !== "top" ? delta.x : 0),
        height: size.height - (edge !== "left" ? delta.y : 0),
    }, available);
}
