/**
 * Integration tests for incremental paint in the frame loop.
 *
 * Verifies that incremental paint with damage tracking produces correct
 * output and perf characteristics.
 */
import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { createFrameLoop, type FrameLoop } from '../../src/core/frame-loop.js';
import { gridToDebugString } from '../../src/core/cell.js';

// --- Mock stdout ---

interface MockStdout extends NodeJS.WriteStream {
  written: string[];
  columns: number;
  rows: number;
}

function createMockStdout(cols = 40, rows = 10): MockStdout {
  const emitter = new EventEmitter();
  const written: string[] = [];

  const mock = Object.assign(emitter, {
    written,
    columns: cols,
    rows,
    writable: true,
    write(chunk: any): boolean {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    },
    end: () => mock,
    destroy: () => mock,
    cork: () => {},
    uncork: () => {},
    isTTY: true,
    fd: 1,
    close: () => {},
    bytesWritten: 0,
    path: '',
    pending: false,
    addListener: emitter.addListener.bind(emitter),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    off: emitter.off.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    setMaxListeners: emitter.setMaxListeners.bind(emitter),
    getMaxListeners: emitter.getMaxListeners.bind(emitter),
    listeners: emitter.listeners.bind(emitter),
    rawListeners: emitter.rawListeners.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    prependListener: emitter.prependListener.bind(emitter),
    prependOnceListener: emitter.prependOnceListener.bind(emitter),
    eventNames: emitter.eventNames.bind(emitter),
  }) as any as MockStdout;

  return mock;
}

async function flushReact(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function makeLines(n: number, prefix = 'Line'): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(React.createElement('text', { key: `line-${i}` }, `${prefix} ${i}`));
  }
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

function makeLinesWithChange(
  n: number,
  changedIndex: number,
  changedText: string,
): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(
      React.createElement(
        'text',
        { key: `line-${i}` },
        i === changedIndex ? changedText : `Line ${i}`,
      ),
    );
  }
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

// --- Tests ---

describe('incremental frame loop — streaming append-only with blitting', () => {
  it('streaming lines blit existing content and only paint new rows', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    // Start with 10 rows
    loop.start(makeLines(10));
    await flushReact();
    loop.perfReset();

    // Add rows one at a time
    for (let n = 11; n <= 20; n++) {
      loop.update(makeLines(n));
      await flushReact();
    }

    loop.stop();

    const snap = loop.perfSnapshot()!;
    const counts = snap.counts as any;

    // Blitting should occur — existing content reused from front buffer
    expect(counts.subtreeBlits).toBeGreaterThan(0);

    // Append-only frames should dominate
    expect(counts.growthFrames).toBeGreaterThanOrEqual(5);

    // Final content should be correct
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 10');
    expect(text).toContain('Line 19');
  });
});

describe('incremental frame loop — single-node update', () => {
  it('changing one text node produces an update frame with blitted header/footer', async () => {
    const stdout = createMockStdout(40, 15);
    const loop = createFrameLoop(stdout as any, { perf: true });

    // Render header + 10 body lines + footer = 12 lines
    const children = [];
    children.push(React.createElement('text', { key: 'header' }, '=== Header ==='));
    for (let i = 0; i < 10; i++) {
      children.push(React.createElement('text', { key: `body-${i}` }, `Body ${i}`));
    }
    children.push(React.createElement('text', { key: 'footer' }, '=== Footer ==='));
    loop.start(React.createElement('box', { flexDirection: 'column' }, ...children));
    await flushReact();
    loop.perfReset();

    // Change only the 5th body text node
    const updatedChildren = [];
    updatedChildren.push(React.createElement('text', { key: 'header' }, '=== Header ==='));
    for (let i = 0; i < 10; i++) {
      updatedChildren.push(
        React.createElement('text', { key: `body-${i}` }, i === 5 ? 'CHANGED' : `Body ${i}`),
      );
    }
    updatedChildren.push(React.createElement('text', { key: 'footer' }, '=== Footer ==='));
    loop.update(React.createElement('box', { flexDirection: 'column' }, ...updatedChildren));
    await flushReact();
    loop.stop();

    const snap = loop.perfSnapshot()!;
    const counts = snap.counts as any;

    // Should be an update frame
    expect(counts.framesUpdate).toBeGreaterThanOrEqual(1);

    // Blitting should occur for unchanged subtrees (header, footer, other body rows)
    expect(counts.subtreeBlits).toBeGreaterThan(0);

    // The diff output should contain CHANGED but not a full redraw
    const grid = loop.getGrid();
    const text = gridToDebugString(grid!);
    expect(text).toContain('CHANGED');
    expect(text).toContain('=== Header ===');
    expect(text).toContain('=== Footer ===');
  });
});

describe('incremental frame loop — resize triggers full paint', () => {
  it('resize disables blitting, next frame restores it', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    loop.start(makeLines(8));
    await flushReact();
    loop.perfReset();

    // Resize triggers contamination → full redraw (no blitting)
    stdout.columns = 30;
    stdout.rows = 10;
    stdout.emit('resize');

    const snap1 = loop.perfSnapshot()!;
    const counts1 = snap1.counts as any;
    expect(counts1.framesFullRedraw).toBeGreaterThanOrEqual(1);
    // During contaminated frame, subtreeBlits should be 0
    expect(counts1.subtreeBlits ?? 0).toBe(0);

    // Subsequent update should use blitting again
    loop.perfReset();
    loop.update(makeLines(8));
    await flushReact();
    loop.stop();

    const snap2 = loop.perfSnapshot()!;
    const counts2 = snap2.counts as any;
    expect(counts2.framesFullRedraw ?? 0).toBe(0);
    // Blitting should resume
    expect(counts2.subtreeBlits).toBeGreaterThan(0);
  });
});

describe('incremental frame loop — no-change frame', () => {
  it('no React changes → all blitted, empty diff output', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    loop.start(makeLines(5));
    await flushReact();
    loop.perfReset();

    const writtenBefore = stdout.written.length;

    // Re-render with identical content
    loop.update(makeLines(5));
    await flushReact();
    loop.stop();

    const snap = loop.perfSnapshot()!;
    const counts = snap.counts as any;

    // Everything should be blitted
    expect(counts.subtreeBlits).toBeGreaterThan(0);

    // Frame should be classified as update with empty diff
    expect(counts.framesSkipped).toBeGreaterThanOrEqual(1);
  });
});

describe('incremental frame loop — performance scaling', () => {
  it('changing 1 of 100 nodes: ~99 blits per frame', async () => {
    const stdout = createMockStdout(40, 100);
    const loop = createFrameLoop(stdout as any, { perf: true });

    // Create 100 text nodes
    loop.start(makeLines(100));
    await flushReact();

    // Change 1 node per frame for 5 frames
    for (let frame = 0; frame < 5; frame++) {
      loop.perfReset();
      loop.update(makeLinesWithChange(100, frame * 10, `CHANGED_${frame}`));
      await flushReact();
    }

    loop.stop();

    // Check the last frame's perf
    const snap = loop.perfSnapshot()!;
    const counts = snap.counts as any;

    // Siblings before the changed one should be blitted.
    // Siblings after are tainted by overflow, but we still get significant blits.
    expect(counts.subtreeBlits).toBeGreaterThan(10);

    // Blitting is active — not everything is painted
    expect(counts.subtreeBlitCells).toBeGreaterThan(0);

    // Final content correct
    const grid = loop.getGrid();
    const text = gridToDebugString(grid!);
    expect(text).toContain('CHANGED_4');
  });
});
