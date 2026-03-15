import { describe, it, expect } from 'bun:test';
import React from 'react';
import { mountRoot } from '../../../src/tui/reconciler.js';
import type { TNode } from '../../../src/tui/nodes.js';

// Convenience host element "components" for createElement
const Box = 'box' as any;
const Text = 'text' as any;

/** Wait for concurrent React to flush */
const flush = () => new Promise<void>((r) => setTimeout(r, 10));

/** Get the raw text value from a text element's first text-instance child */
const textOf = (node: TNode): string | null => {
  // Text element's string content lives in a text-instance child
  const inst = node.children.find((c) => c.text !== null);
  return inst?.text ?? node.text;
};

describe('reconciler', () => {
  it('builds a basic tree: box > text > "hello"', async () => {
    let root: TNode | null = null;
    mountRoot(
      React.createElement(Box, null, React.createElement(Text, null, 'hello')),
      (r) => { root = r; },
    );
    await flush();

    expect(root).not.toBeNull();
    expect(root!.type).toBe('root');
    expect(root!.children).toHaveLength(1);

    const box = root!.children[0]!;
    expect(box.type).toBe('box');
    expect(box.children).toHaveLength(1);

    const textEl = box.children[0]!;
    expect(textEl.type).toBe('text');
    expect(textEl.children).toHaveLength(1);
    expect(textOf(textEl)).toBe('hello');
  });

  it('renders multiple children in order', async () => {
    let root: TNode | null = null;
    mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Text, null, 'first'),
        React.createElement(Text, null, 'second'),
      ),
      (r) => { root = r; },
    );
    await flush();

    const box = root!.children[0]!;
    expect(box.children).toHaveLength(2);
    expect(textOf(box.children[0]!)).toBe('first');
    expect(textOf(box.children[1]!)).toBe('second');
  });

  it('updates text content', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Text, null, 'hello')),
      (r) => { root = r; },
    );
    await flush();
    expect(textOf(root!.children[0]!.children[0]!)).toBe('hello');

    update(
      React.createElement(Box, null, React.createElement(Text, null, 'world')),
    );
    await flush();
    expect(textOf(root!.children[0]!.children[0]!)).toBe('world');
  });

  it('adds a child', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Text, { key: 'a' }, 'one')),
      (r) => { root = r; },
    );
    await flush();
    expect(root!.children[0]!.children).toHaveLength(1);

    update(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'a' }, 'one'),
        React.createElement(Text, { key: 'b' }, 'two'),
      ),
    );
    await flush();
    expect(root!.children[0]!.children).toHaveLength(2);
    expect(textOf(root!.children[0]!.children[1]!)).toBe('two');
  });

  it('removes a child', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'a' }, 'one'),
        React.createElement(Text, { key: 'b' }, 'two'),
      ),
      (r) => { root = r; },
    );
    await flush();
    expect(root!.children[0]!.children).toHaveLength(2);

    update(
      React.createElement(Box, null, React.createElement(Text, { key: 'a' }, 'one')),
    );
    await flush();
    expect(root!.children[0]!.children).toHaveLength(1);
    expect(textOf(root!.children[0]!.children[0]!)).toBe('one');
  });

  it('fires onFrame after initial render and updates', async () => {
    let callCount = 0;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Text, null, 'a')),
      () => { callCount++; },
    );
    await flush();
    expect(callCount).toBeGreaterThanOrEqual(1);

    const before = callCount;
    update(
      React.createElement(Box, null, React.createElement(Text, null, 'b')),
    );
    await flush();
    expect(callCount).toBeGreaterThan(before);
  });

  it('mutation ordering: remove A, add D → [B, C, D]', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'a' }, 'A'),
        React.createElement(Text, { key: 'b' }, 'B'),
        React.createElement(Text, { key: 'c' }, 'C'),
      ),
      (r) => { root = r; },
    );
    await flush();

    const box = root!.children[0]!;
    expect(box.children).toHaveLength(3);
    expect(textOf(box.children[0]!)).toBe('A');

    update(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'b' }, 'B'),
        React.createElement(Text, { key: 'c' }, 'C'),
        React.createElement(Text, { key: 'd' }, 'D'),
      ),
    );
    await flush();

    expect(box.children).toHaveLength(3);
    expect(textOf(box.children[0]!)).toBe('B');
    expect(textOf(box.children[1]!)).toBe('C');
    expect(textOf(box.children[2]!)).toBe('D');
  });

  it('commitUpdate preserves node identity', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'x', color: 'red' }, 'hello'),
      ),
      (r) => { root = r; },
    );
    await flush();

    const box = root!.children[0]!;
    const textNodeBefore = box.children[0]!;
    expect(textNodeBefore.props.color).toBe('red');

    update(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'x', color: 'blue' }, 'hello'),
      ),
    );
    await flush();

    const textNodeAfter = box.children[0]!;
    expect(textNodeAfter).toBe(textNodeBefore); // same object reference
    expect(textNodeAfter.props.color).toBe('blue');
  });

  it('onFrame fires once per commit, not per mutation', async () => {
    let frameCount = 0;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'a' }, '1'),
        React.createElement(Text, { key: 'b' }, '2'),
        React.createElement(Text, { key: 'c' }, '3'),
      ),
      () => { frameCount++; },
    );
    await flush();

    const before = frameCount;
    // Update all 3 texts simultaneously in one render
    update(
      React.createElement(
        Box,
        null,
        React.createElement(Text, { key: 'a' }, 'x'),
        React.createElement(Text, { key: 'b' }, 'y'),
        React.createElement(Text, { key: 'c' }, 'z'),
      ),
    );
    await flush();

    // Should fire exactly once for the single commit, not 3 times
    expect(frameCount - before).toBe(1);
  });

  it('rapid sequential updates: tree reflects last update', async () => {
    let root: TNode | null = null;
    let frameCount = 0;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Text, null, 'initial')),
      (r) => { root = r; frameCount++; },
    );
    await flush();

    const before = frameCount;
    // Two synchronous updates — no await between them
    update(
      React.createElement(Box, null, React.createElement(Text, null, 'first')),
    );
    update(
      React.createElement(Box, null, React.createElement(Text, null, 'second')),
    );
    await flush();

    // Tree must reflect the second (last) update
    expect(textOf(root!.children[0]!.children[0]!)).toBe('second');
    // Document how many onFrame calls happened (1 or 2 — either is acceptable)
    const frameDelta = frameCount - before;
    console.log(`rapid sequential updates: onFrame fired ${frameDelta} time(s)`);
    expect(frameDelta).toBeGreaterThanOrEqual(1);
    expect(frameDelta).toBeLessThanOrEqual(2);
  });

  it('reorders children by key', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Box, { key: 'a' }, React.createElement(Text, null, 'A')),
        React.createElement(Box, { key: 'b' }, React.createElement(Text, null, 'B')),
      ),
      (r) => { root = r; },
    );
    await flush();

    const outer = root!.children[0]!;
    expect(textOf(outer.children[0]!.children[0]!)).toBe('A');
    expect(textOf(outer.children[1]!.children[0]!)).toBe('B');

    // Swap order: B first, then A
    update(
      React.createElement(
        Box,
        null,
        React.createElement(Box, { key: 'b' }, React.createElement(Text, null, 'B')),
        React.createElement(Box, { key: 'a' }, React.createElement(Text, null, 'A')),
      ),
    );
    await flush();

    expect(textOf(outer.children[0]!.children[0]!)).toBe('B');
    expect(textOf(outer.children[1]!.children[0]!)).toBe('A');
  });
});
