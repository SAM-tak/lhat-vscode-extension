/** The one axis a node-body drag is allowed to control. */
export type DragAxis = "horizontal" | "vertical";

/**
 * A gesture near the document axis belongs to the document.  Thirty degrees
 * either side of vertical is deliberately narrower than the usual 45-degree
 * split, so a diagonal pull through a wide node still exposes its sides.
 */
export const VERTICAL_DRAG_CONE_DEGREES = 30;
const verticalSlope = Math.tan((90 - VERTICAL_DRAG_CONE_DEGREES) * Math.PI / 180);

/**
 * Decide a node-body drag's axis once, from its displacement since press.
 * A node that has no horizontal overflow is the same as the background: every
 * drag scrolls the document vertically.
 */
export function dragAxis(dx: number, dy: number, canScrollHorizontally: boolean): DragAxis {
    if (!canScrollHorizontally) return "vertical";
    return Math.abs(dy) >= Math.abs(dx) * verticalSlope ? "vertical" : "horizontal";
}

/**
 * Decide whether this layout box owns horizontal motion. A detached value may
 * override the owner inside its own subtree; that does not disqualify its wide
 * top-level ancestor from owning the rest of the visible box.
 */
export function ownsHorizontalSlide(
    detachedValue: boolean,
    topLevel: boolean,
    layoutOnly: boolean,
    isContainer: boolean,
    usableWidth: number,
    width: number,
): boolean {
    return detachedValue ||
        (topLevel && !layoutOnly && isContainer && usableWidth > 0 && width > usableWidth);
}
