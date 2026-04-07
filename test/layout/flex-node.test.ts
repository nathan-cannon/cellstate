import { describe, test, expect } from 'bun:test';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { SizeConstraint, type FlexNode } from '../../src/layout/flex-node.js';

const createNode = createFlexNodeFactory();

describe('FlexNode (via Yoga adapter)', () => {
  test('basic width: create root, set width, verify computed', () => {
    const root = createNode();
    root.setWidth(80);
    root.calculateLayout();
    expect(root.getComputedWidth()).toBe(80);
    root.freeRecursive();
  });

  test('column layout: children stack vertically', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('column');

    const children: FlexNode[] = [];
    for (let i = 0; i < 3; i++) {
      const child = createNode();
      child.setHeight(10);
      root.insertChild(child, i);
      children.push(child);
    }

    root.calculateLayout();

    expect(children[0]!.getComputedTop()).toBe(0);
    expect(children[1]!.getComputedTop()).toBe(10);
    expect(children[2]!.getComputedTop()).toBe(20);
    expect(root.getComputedHeight()).toBe(30);
    root.freeRecursive();
  });

  test('row layout: children placed horizontally', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('row');

    const children: FlexNode[] = [];
    for (let i = 0; i < 3; i++) {
      const child = createNode();
      child.setWidth(20);
      child.setHeight(10);
      root.insertChild(child, i);
      children.push(child);
    }

    root.calculateLayout();

    expect(children[0]!.getComputedLeft()).toBe(0);
    expect(children[1]!.getComputedLeft()).toBe(20);
    expect(children[2]!.getComputedLeft()).toBe(40);
    root.freeRecursive();
  });

  test('flexGrow: child fills remaining space', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('row');

    const fixed = createNode();
    fixed.setWidth(30);
    fixed.setHeight(10);
    root.insertChild(fixed, 0);

    const grow = createNode();
    grow.setFlexGrow(1);
    grow.setHeight(10);
    root.insertChild(grow, 1);

    root.calculateLayout();

    expect(fixed.getComputedWidth()).toBe(30);
    expect(grow.getComputedWidth()).toBe(70);
    root.freeRecursive();
  });

  test('padding: child offset by padding, getComputedPadding values', () => {
    const root = createNode();
    root.setWidth(100);
    root.setPadding('all', 2);

    const child = createNode();
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedLeft()).toBe(2);
    expect(child.getComputedTop()).toBe(2);
    expect(child.getComputedWidth()).toBe(96); // 100 - 2 - 2
    expect(root.getComputedPaddingLeft()).toBe(2);
    expect(root.getComputedPaddingRight()).toBe(2);
    expect(root.getComputedPaddingTop()).toBe(2);
    expect(root.getComputedPaddingBottom()).toBe(2);
    root.freeRecursive();
  });

  test('margin: child offset from sibling', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('column');

    const child1 = createNode();
    child1.setHeight(10);
    root.insertChild(child1, 0);

    const child2 = createNode();
    child2.setHeight(10);
    child2.setMargin('top', 3);
    root.insertChild(child2, 1);

    root.calculateLayout();

    expect(child1.getComputedTop()).toBe(0);
    expect(child2.getComputedTop()).toBe(13); // 10 + 3
    root.freeRecursive();
  });

  test('border: getComputedBorder values and child offset', () => {
    const root = createNode();
    root.setWidth(100);
    root.setBorder('all', 1);

    const child = createNode();
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(root.getComputedBorderLeft()).toBe(1);
    expect(root.getComputedBorderRight()).toBe(1);
    expect(root.getComputedBorderTop()).toBe(1);
    expect(root.getComputedBorderBottom()).toBe(1);
    expect(child.getComputedLeft()).toBe(1);
    expect(child.getComputedTop()).toBe(1);
    expect(child.getComputedWidth()).toBe(98); // 100 - 1 - 1
    root.freeRecursive();
  });

  test('gap: spacing between children', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('column');
    root.setGap(1);

    const children: FlexNode[] = [];
    for (let i = 0; i < 3; i++) {
      const child = createNode();
      child.setHeight(10);
      root.insertChild(child, i);
      children.push(child);
    }

    root.calculateLayout();

    expect(children[0]!.getComputedTop()).toBe(0);
    expect(children[1]!.getComputedTop()).toBe(11); // 10 + 1
    expect(children[2]!.getComputedTop()).toBe(22); // 11 + 10 + 1
    root.freeRecursive();
  });

  test('display none: zero computed size, no sibling impact', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('column');

    const child1 = createNode();
    child1.setHeight(10);
    root.insertChild(child1, 0);

    const hidden = createNode();
    hidden.setHeight(10);
    hidden.setDisplay('none');
    root.insertChild(hidden, 1);

    const child3 = createNode();
    child3.setHeight(10);
    root.insertChild(child3, 2);

    root.calculateLayout();

    expect(hidden.getComputedWidth()).toBe(0);
    expect(hidden.getComputedHeight()).toBe(0);
    // child3 should be right after child1 since hidden takes no space
    expect(child3.getComputedTop()).toBe(10);
    root.freeRecursive();
  });

  test('measure function: text node with custom size', () => {
    const root = createNode();
    root.setWidth(100);
    root.setAlignItems('flex-start'); // prevent stretch overriding measured width

    const text = createNode();
    text.setMeasureFunc((_width: number, _mode: SizeConstraint) => ({
      width: 10,
      height: 3,
    }));
    root.insertChild(text, 0);

    root.calculateLayout();

    expect(text.getComputedWidth()).toBe(10);
    expect(text.getComputedHeight()).toBe(3);
    root.freeRecursive();
  });

  test('measure function caching: same width does not re-invoke', () => {
    const root = createNode();
    root.setWidth(100);

    let callCount = 0;
    const text = createNode();
    text.setMeasureFunc((_width: number, _mode: SizeConstraint) => {
      callCount++;
      return { width: 10, height: 3 };
    });
    root.insertChild(text, 0);

    root.calculateLayout(100);
    const firstCount = callCount;
    expect(firstCount).toBeGreaterThan(0);

    // Second layout with same width — Yoga caches the result
    root.calculateLayout(100);
    expect(callCount).toBe(firstCount);
    root.freeRecursive();
  });

  test('dirty propagation: child width change picked up by parent', () => {
    const root = createNode();
    root.setWidth(100);

    const child = createNode();
    child.setWidth(50);
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();
    expect(child.getComputedWidth()).toBe(50);

    child.setWidth(70);
    root.calculateLayout();
    expect(child.getComputedWidth()).toBe(70);
    root.freeRecursive();
  });

  test('alignItems center: narrow child centered', () => {
    const root = createNode();
    root.setWidth(100);
    root.setFlexDirection('column');
    root.setAlignItems('center');

    const child = createNode();
    child.setWidth(40);
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedLeft()).toBe(30); // (100 - 40) / 2
    root.freeRecursive();
  });

  test('justifyContent space-between: evenly distributed', () => {
    const root = createNode();
    root.setWidth(100);
    root.setHeight(100);
    root.setFlexDirection('column');
    root.setJustifyContent('space-between');

    const children: FlexNode[] = [];
    for (let i = 0; i < 3; i++) {
      const child = createNode();
      child.setHeight(10);
      root.insertChild(child, i);
      children.push(child);
    }

    root.calculateLayout();

    // 100 total - 30 used = 70 space, distributed in 2 gaps = 35 each
    expect(children[0]!.getComputedTop()).toBe(0);
    expect(children[1]!.getComputedTop()).toBe(45); // 10 + 35
    expect(children[2]!.getComputedTop()).toBe(90); // 45 + 10 + 35
    root.freeRecursive();
  });

  test('absolute positioning: child at specific position', () => {
    const root = createNode();
    root.setWidth(100);
    root.setHeight(100);

    const child = createNode();
    child.setPositionType('absolute');
    child.setPosition('top', 5);
    child.setPosition('left', 10);
    child.setWidth(20);
    child.setHeight(15);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedTop()).toBe(5);
    expect(child.getComputedLeft()).toBe(10);
    expect(child.getComputedWidth()).toBe(20);
    expect(child.getComputedHeight()).toBe(15);
    root.freeRecursive();
  });

  test('free: no crash on free', () => {
    const node = createNode();
    node.setWidth(10);
    node.calculateLayout();
    node.free();
    // If we get here, no crash
    expect(true).toBe(true);
  });

  test('percentage width: 50% of 100-wide root = 50', () => {
    const root = createNode();
    root.setWidth(100);

    const child = createNode();
    child.setWidthPercent(50);
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedWidth()).toBe(50);
    root.freeRecursive();
  });

  test('maxWidth: clamped to 20 in a 100-wide root', () => {
    const root = createNode();
    root.setWidth(100);

    const child = createNode();
    child.setMaxWidth(20);
    child.setHeight(10);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedWidth()).toBe(20);
    root.freeRecursive();
  });

  test('aspectRatio: width=10, ratio=2 gives height=5', () => {
    const root = createNode();
    root.setWidth(100);

    const child = createNode();
    child.setWidth(10);
    child.setAspectRatio(2);
    root.insertChild(child, 0);

    root.calculateLayout();

    expect(child.getComputedWidth()).toBe(10);
    expect(child.getComputedHeight()).toBe(5);
    root.freeRecursive();
  });
});
