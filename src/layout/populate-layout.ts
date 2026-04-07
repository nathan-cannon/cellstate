/**
 * After Yoga's calculateLayout, extract computed positions and sizes onto
 * TNode.layout so the rasterizer can consume them unchanged.
 *
 * Also tracks whether any node's bounds changed from the previous frame
 * (movement detection for incremental rasterization).
 */
import type { TNode } from '../core/nodes.js';
import { propagateDirty } from '../core/dirty.js';

let movementDetected = false;

/** Returns true if any node's bounds changed during the last populateLayoutResults call. */
export function hadMovement(): boolean {
  return movementDetected;
}

/** Reset the movement flag. Call after the rasterizer has consumed it. */
export function clearMovement(): void {
  movementDetected = false;
}

/**
 * Walk the TNode tree and populate each node's layout field from its FlexNode.
 * Yoga returns positions relative to the parent, so we accumulate absolute
 * offsets as we recurse.
 */
export function populateLayoutResults(root: TNode): void {
  movementDetected = false;
  walkNode(root, 0, 0);
}

function walkNode(node: TNode, parentAbsX: number, parentAbsY: number): void {
  const fn = node.flexNode;
  if (!fn) return;

  const relX = fn.getComputedLeft();
  const relY = fn.getComputedTop();
  const w = fn.getComputedWidth();
  const h = fn.getComputedHeight();

  // Root node is at (0,0); children are relative to parent's border box
  const absX = parentAbsX + relX;
  const absY = parentAbsY + relY;

  // --- Bounds tracking ---
  const prev = node._prevBounds;
  if (prev) {
    if (prev.x !== absX || prev.y !== absY || prev.width !== w || prev.height !== h) {
      movementDetected = true;
      // Mark ancestors dirty so the top-down rasterizer walk descends
      // to this node and sees the bounds mismatch.
      propagateDirty(node);
    }
  }
  node._prevBounds = { x: absX, y: absY, width: w, height: h };

  if (node.type === 'text') {
    const cache = node._wrapCache;

    // Determine textAlign from parent's alignItems
    let textAlign: 'left' | 'center' | 'right' | undefined;
    const parentAlign = node.parent?.props.alignItems as string | undefined;
    if (parentAlign === 'center') {
      textAlign = 'center';
    } else if (parentAlign === 'flex-end') {
      textAlign = 'right';
    }

    node.layout = {
      x: absX,
      y: absY,
      width: w,
      height: h,
      wrappedLines: cache?.wrappedLines ?? [],
      hangingIndent: cache?.hangingIndent,
      textAlign,
    };
  } else {
    node.layout = {
      x: absX,
      y: absY,
      width: w,
      height: h,
    };
  }

  // Recurse into children. Yoga positions children relative to the parent's
  // content box (inside border+padding). But the computed left/top already
  // accounts for that — Yoga's getComputedLeft() on a child returns the offset
  // from the parent's border box origin, not the content box.
  // So we just pass the parent's absolute position.
  for (const child of node.children) {
    walkNode(child, absX, absY);
  }
}
