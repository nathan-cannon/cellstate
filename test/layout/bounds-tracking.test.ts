import { describe, it, expect } from 'bun:test';
import { createNode, appendChild } from '../../src/core/nodes.js';
import type { TNode } from '../../src/core/nodes.js';
import {
  populateLayoutResults,
  hadMovement,
  clearMovement,
} from '../../src/layout/populate-layout.js';

/**
 * Minimal FlexNode stub that returns configurable computed values.
 */
function stubFlexNode(opts: {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
} = {}) {
  return {
    getComputedLeft: () => opts.left ?? 0,
    getComputedTop: () => opts.top ?? 0,
    getComputedWidth: () => opts.width ?? 10,
    getComputedHeight: () => opts.height ?? 5,
    // Stubs for methods called by nodes.ts appendChild/removeChild
    insertChild: () => {},
    removeChild: () => {},
    setMeasureFunc: () => {},
    setWidth: () => {},
    setHeight: () => {},
    calculateLayout: () => {},
    markDirty: () => {},
  } as any;
}

function buildTree() {
  const root = createNode('root', {}, stubFlexNode({ width: 80, height: 24 }));
  const child = createNode('box', {}, stubFlexNode({ left: 2, top: 3, width: 20, height: 5 }));
  appendChild(root, child);
  return { root, child };
}

describe('bounds tracking in populateLayoutResults', () => {
  it('every node with a flexNode has _prevBounds set after populateLayoutResults', () => {
    const { root, child } = buildTree();
    populateLayoutResults(root);

    expect(root._prevBounds).toEqual({ x: 0, y: 0, width: 80, height: 24 });
    expect(child._prevBounds).toEqual({ x: 2, y: 3, width: 20, height: 5 });
  });

  it('hadMovement() returns false when layout does not change between calls', () => {
    const { root } = buildTree();
    populateLayoutResults(root);
    // Second call — same layout
    populateLayoutResults(root);

    expect(hadMovement()).toBe(false);
  });

  it('hadMovement() returns true when a child position changes', () => {
    const root = createNode('root', {}, stubFlexNode({ width: 80, height: 24 }));
    let childTop = 3;
    const childFlex = {
      getComputedLeft: () => 2,
      getComputedTop: () => childTop,
      getComputedWidth: () => 20,
      getComputedHeight: () => 5,
      insertChild: () => {},
      removeChild: () => {},
    } as any;
    const child = createNode('box', {}, childFlex);
    appendChild(root, child);

    populateLayoutResults(root);
    expect(hadMovement()).toBe(false); // first call, no prev to compare

    // Simulate parent padding change moving the child
    childTop = 5;
    populateLayoutResults(root);

    expect(hadMovement()).toBe(true);
  });

  it('_prevBounds reflects the latest layout after each call', () => {
    const root = createNode('root', {}, stubFlexNode({ width: 80, height: 24 }));
    let childLeft = 0;
    const childFlex = {
      getComputedLeft: () => childLeft,
      getComputedTop: () => 0,
      getComputedWidth: () => 10,
      getComputedHeight: () => 5,
      insertChild: () => {},
      removeChild: () => {},
    } as any;
    const child = createNode('box', {}, childFlex);
    appendChild(root, child);

    populateLayoutResults(root);
    expect(child._prevBounds).toEqual({ x: 0, y: 0, width: 10, height: 5 });

    childLeft = 4;
    populateLayoutResults(root);
    expect(child._prevBounds).toEqual({ x: 4, y: 0, width: 10, height: 5 });
  });

  it('clearMovement() resets the flag', () => {
    const root = createNode('root', {}, stubFlexNode({ width: 80, height: 24 }));
    let childTop = 0;
    const childFlex = {
      getComputedLeft: () => 0,
      getComputedTop: () => childTop,
      getComputedWidth: () => 10,
      getComputedHeight: () => 5,
      insertChild: () => {},
      removeChild: () => {},
    } as any;
    const child = createNode('box', {}, childFlex);
    appendChild(root, child);

    populateLayoutResults(root);
    childTop = 2;
    populateLayoutResults(root);
    expect(hadMovement()).toBe(true);

    clearMovement();
    expect(hadMovement()).toBe(false);
  });
});
