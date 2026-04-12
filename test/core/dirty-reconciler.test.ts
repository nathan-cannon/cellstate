import { describe, it, expect } from 'bun:test';
import React from 'react';
import { mountRoot } from '../../src/core/reconciler.js';
import type { TNode } from '../../src/core/nodes.js';
import { clearAllDirty } from '../../src/core/dirty.js';

const Box = 'box' as any;
const Text = 'text' as any;

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

describe('dirty propagation in reconciler', () => {
  it('commitUpdate with a changed style prop marks node and ancestors dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Box, { bold: false })),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    update(React.createElement(Box, null, React.createElement(Box, { bold: true })));
    await flush();

    const inner = root!.children[0]!.children[0]!;
    expect(inner._dirty).toBe(true);
    expect(root!._dirty).toBe(true);
  });

  it('commitUpdate where only non-rendering props changed does NOT mark dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, { key: 'a', 'data-x': 1 }),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    update(React.createElement(Box, { key: 'a', 'data-x': 2 }));
    await flush();

    const box = root!.children[0]!;
    expect(box._dirty).toBeFalsy();
    expect(root!._dirty).toBeFalsy();
  });

  it('commitUpdate where all rendering props are identical does NOT mark dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, { bold: true, fg: 'red', 'data-x': 1 }),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    // Same rendering props, different non-rendering prop
    update(React.createElement(Box, { bold: true, fg: 'red', 'data-x': 2 }));
    await flush();

    const box = root!.children[0]!;
    expect(box._dirty).toBeFalsy();
  });

  it('commitTextUpdate marks node and ancestors dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Text, null, 'hello')),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    update(React.createElement(Box, null, React.createElement(Text, null, 'world')));
    await flush();

    const textEl = root!.children[0]!.children[0]!;
    // The text-instance child of <text> should be dirty
    const textInst = textEl.children.find((c) => c.text !== null);
    expect(textInst?._dirty).toBe(true);
    expect(root!._dirty).toBe(true);
  });

  it('removeChild marks parent dirty and sets _childWasDetached', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null, React.createElement(Box, { key: 'a' })),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    update(React.createElement(Box, null));
    await flush();

    const outerBox = root!.children[0]!;
    expect(outerBox._dirty).toBe(true);
    expect(outerBox._childWasDetached).toBe(true);
    expect(root!._dirty).toBe(true);
  });

  it('removeChild of absolute-positioned child queues a pending clear on the parent', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Box, { key: 'abs', position: 'absolute' }),
      ),
      (r) => { root = r; },
    );
    await flush();
    // Seed _prevBounds so that removeChild has something to collect
    const outerBox = root!.children[0]!;
    const absChild = outerBox.children[0]!;
    absChild._prevBounds = { x: 0, y: 0, width: 4, height: 2 };
    clearAllDirty(root!);

    update(React.createElement(Box, null));
    await flush();

    expect(outerBox._pendingClears?.length).toBe(1);
    expect(outerBox._pendingClears?.[0]).toEqual({ x: 0, y: 0, width: 4, height: 2 });
  });

  it('appendChild marks parent dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(Box, null),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    update(React.createElement(Box, null, React.createElement(Box, { key: 'new' })));
    await flush();

    const outerBox = root!.children[0]!;
    expect(outerBox._dirty).toBe(true);
    expect(root!._dirty).toBe(true);
  });

  it('insertBefore marks parent dirty', async () => {
    let root: TNode | null = null;
    const { update } = mountRoot(
      React.createElement(
        Box,
        null,
        React.createElement(Box, { key: 'b' }),
      ),
      (r) => { root = r; },
    );
    await flush();
    clearAllDirty(root!);

    // Insert key='a' before key='b'
    update(
      React.createElement(
        Box,
        null,
        React.createElement(Box, { key: 'a' }),
        React.createElement(Box, { key: 'b' }),
      ),
    );
    await flush();

    const outerBox = root!.children[0]!;
    expect(outerBox._dirty).toBe(true);
    expect(root!._dirty).toBe(true);
  });
});
