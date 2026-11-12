export const FILMSTRIP_DURATION = 160;
export const FILMSTRIP_PITCH = 72;

export function wrapPage(index: number, count: number): number {
  return count > 0 ? ((index % count) + count) % count : 0;
}

// Keep an unbounded position so the last -> first page crosses the same one
// card distance as any other turn instead of sliding back through the book.
export function nearestPosition(position: number, index: number, count: number, direction = 0): number {
  if (count < 2) return 0;
  const current = wrapPage(position, count);
  let delta = wrapPage(index - current, count);
  if (delta > count / 2 || (delta === count / 2 && direction < 0)) delta -= count;
  return position + delta;
}

export function visibleSlots(position: number, width: number, count: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [0];
  const radius = Math.ceil(width / FILMSTRIP_PITCH / 2) + 2;
  return Array.from({ length: radius * 2 + 1 }, (_, n) => position - radius + n);
}
