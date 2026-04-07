/**
 * Dirty-flag propagation for incremental rasterization.
 *
 * _dirty = true on a node means "this node OR a descendant changed."
 * propagateDirty walks UP from a changed node to the root so the
 * top-down rasterizer walk knows which subtrees to descend into.
 */
import type { TNode } from './nodes.js';

/**
 * Mark `node` and all its ancestors as dirty. Stops early when it
 * hits a node already marked dirty — its ancestors must already be
 * dirty from a prior propagation in this commit batch.
 */
export function propagateDirty(node: TNode): void {
  let cur: TNode | null = node;
  while (cur !== null) {
    if (cur._dirty) return; // ancestors already marked
    cur._dirty = true;
    cur = cur.parent;
  }
}

/**
 * Clear _dirty and _childWasDetached on every node in the tree.
 * Called AFTER the rasterizer completes a frame.
 */
export function clearAllDirty(root: TNode): void {
  root._dirty = false;
  root._childWasDetached = false;
  for (const child of root.children) {
    clearAllDirty(child);
  }
}

// --- Absolute-positioned removal flag ---

let absoluteDetached = false;

/** Signal that an absolute-positioned child was removed this frame. */
export function setAbsoluteFlag(): void {
  absoluteDetached = true;
}

/** Read and reset the absolute-detached flag. */
export function drainAbsoluteFlag(): boolean {
  const v = absoluteDetached;
  absoluteDetached = false;
  return v;
}
