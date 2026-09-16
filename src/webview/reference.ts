/** Screen-space geometry: reference lines never add graph nodes or handles. */
export interface ReferenceRect { left: number; top: number; right: number; bottom: number }
export function referencePath(source: ReferenceRect, target: ReferenceRect): string {
    const sx = (source.left + source.right) / 2, sy = (source.top + source.bottom) / 2;
    const tx = (target.left + target.right) / 2, ty = (target.top + target.bottom) / 2;
    if (source.top >= target.bottom || target.top >= source.bottom) {
        const direction = ty < sy ? -1 : 1;
        const y1 = direction < 0 ? source.top : source.bottom;
        const y2 = direction < 0 ? target.bottom : target.top;
        const bend = Math.min(160, Math.max(16, Math.abs(y2 - y1) * 0.5));
        return `M ${sx} ${y1} C ${sx} ${y1 + direction * bend}, ${tx} ${y2 - direction * bend}, ${tx} ${y2}`;
    }
    const direction = tx < sx ? -1 : 1;
    const x1 = direction < 0 ? source.left : source.right;
    const x2 = direction < 0 ? target.right : target.left;
    const bend = Math.min(160, Math.max(16, Math.abs(x2 - x1) * 0.5));
    return `M ${x1} ${sy} C ${x1 + direction * bend} ${sy}, ${x2 - direction * bend} ${ty}, ${x2} ${ty}`;
}
