import { describe, it, expect } from 'bun:test';
import { createNode, appendChild } from '../../src/core/nodes.js';
import { propagateDirty, clearAllDirty } from '../../src/core/dirty.js';

function buildTree() {
  const root = createNode('root');
  const box = createNode('box');
  const child = createNode('box');
  const leaf = createNode('text');
  appendChild(root, box);
  appendChild(box, child);
  appendChild(child, leaf);
  // Clear any dirty state from appendChild
  clearAllDirty(root);
  return { root, box, child, leaf };
}

describe('propagateDirty', () => {
  it('marks the node and all ancestors dirty', () => {
    const { root, box, child, leaf } = buildTree();
    propagateDirty(leaf);

    expect(leaf._dirty).toBe(true);
    expect(child._dirty).toBe(true);
    expect(box._dirty).toBe(true);
    expect(root._dirty).toBe(true);
  });

  it('stops early when an ancestor is already dirty', () => {
    const { root, box, child, leaf } = buildTree();
    // Pre-dirty box
    box._dirty = true;
    root._dirty = true;

    propagateDirty(leaf);

    expect(leaf._dirty).toBe(true);
    expect(child._dirty).toBe(true);
    // These were already set — propagation stopped at box
    expect(box._dirty).toBe(true);
    expect(root._dirty).toBe(true);
  });

  it('after propagateDirty on a deeply nested leaf, root._dirty is true', () => {
    const root = createNode('root');
    let cur = root;
    for (let i = 0; i < 10; i++) {
      const next = createNode('box');
      appendChild(cur, next);
      cur = next;
    }
    clearAllDirty(root);

    propagateDirty(cur);
    expect(root._dirty).toBe(true);
  });
});

describe('clearAllDirty', () => {
  it('clears _dirty and _childWasDetached on the entire tree', () => {
    const { root, box, child, leaf } = buildTree();
    propagateDirty(leaf);
    root._childWasDetached = true;
    box._childWasDetached = true;

    clearAllDirty(root);

    expect(root._dirty).toBe(false);
    expect(box._dirty).toBe(false);
    expect(child._dirty).toBe(false);
    expect(leaf._dirty).toBe(false);
    expect(root._childWasDetached).toBe(false);
    expect(box._childWasDetached).toBe(false);
  });

  it('after clearAllDirty, every node has _dirty = false', () => {
    const { root, box, child, leaf } = buildTree();
    propagateDirty(leaf);
    clearAllDirty(root);

    for (const n of [root, box, child, leaf]) {
      expect(n._dirty).toBe(false);
    }
  });
});

describe('clean tree', () => {
  it('freshly created nodes have _dirty as false/undefined', () => {
    const node = createNode('box');
    expect(node._dirty).toBeFalsy();
  });
});
