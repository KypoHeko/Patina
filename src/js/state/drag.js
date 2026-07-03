// State of dragging files between panels — a single singleton with an explicit
// interface instead of a module-level mutable variable. Safe for future
// expansion (triple split, independent DnD per tab).
let current = null; // { paths: string[], sourceSide: 'left' | 'right' } | null

export function startDrag(paths, sourceSide) {
  current = { paths, sourceSide };
}

export function getDrag() {
  return current;
}

export function clearDrag() {
  current = null;
}
