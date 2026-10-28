/** The path uses layout coordinates relative to the comment, so it follows
 * folding, font scaling and the owner's display-only horizontal slide. */
export function CommentLink({ points }: { points?: { x: number; y: number }[] }) {
    if (!points?.length) return null;
    const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
    const width = Math.max(1, Math.max(...points.map(point => point.x)) - x);
    const height = Math.max(1, Math.max(...points.map(point => point.y)) - y);
    return <svg className="comment-link" aria-hidden="true" focusable="false"
        style={{ left: x, top: y, width, height }} viewBox={`${x} ${y} ${width} ${height}`}>
        <path d={points.map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ")} />
    </svg>;
}
