/**
 * Frame classification integration tests.
 *
 * Verify that the damage-scoped diff pipeline correctly handles frame
 * types and that growth frames activate for streaming content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { createFrameLoop, type FrameLoop } from '../../src/core/frame-loop.js';
import { gridToDebugString } from '../../src/core/cell.js';
import {
  createVerifiedFrameLoop,
  type VerifiedFrameLoopInstance,
} from '../helpers/verified-frame-loop.js';

// --- Mock stdout ---

interface MockStdout extends NodeJS.WriteStream {
  written: string[];
  columns: number;
  rows: number;
  writeReturns: boolean;
}

function createMockStdout(cols = 40, rows = 10): MockStdout {
  const emitter = new EventEmitter();
  const written: string[] = [];

  const mock = Object.assign(emitter, {
    written,
    columns: cols,
    rows,
    writeReturns: true,
    writable: true,
    write(chunk: any): boolean {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return mock.writeReturns;
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

// --- Tests ---

describe('frame classification — append-only streaming', () => {
  it('streaming lines produce append-only frames', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    // First frame: 5 rows (within viewport)
    loop.start(makeLines(5));
    await flushReact();

    // Add one row at a time for 15 more frames, growing past viewport
    for (let n = 6; n <= 20; n++) {
      loop.update(makeLines(n));
      await flushReact();
    }

    loop.stop();

    // Verify final state is correct
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 10');
    expect(text).toContain('Line 19');
    expect(loop.getScrollbackLines()).toBe(10);

    // Check perf counters — append-only should dominate growth frames
    const snap = loop.perfSnapshot()!;
    const appendOnly = (snap.counts as any).growthFrames ?? 0;
    // At least some frames should be append-only (once content exceeds viewport)
    expect(appendOnly).toBeGreaterThanOrEqual(5);
  });

  it('append-only output contains only new row content', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any);

    // Start with content exceeding viewport
    loop.start(makeLines(12));
    await flushReact();

    const writesAfterFirst = stdout.written.length;

    // Add one more row — should be append-only
    loop.update(makeLines(13));
    await flushReact();
    loop.stop();

    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    expect(laterWrites.length).toBeGreaterThanOrEqual(1);

    // The growth output should NOT contain clear screen
    const frameOutput = laterWrites.join('');
    expect(frameOutput).not.toContain('\x1b[2J');

    // Should contain the new content
    expect(frameOutput).toContain('Line 12');

    // Should NOT contain a full viewport's worth of erase-line sequences
    // (which would indicate a full viewport redraw instead of append-only)
    const eraseCount = (frameOutput.match(/\x1b\[2K/g) || []).length;
    expect(eraseCount).toBe(0); // append-only doesn't use EL
  });
});

describe('frame classification — update', () => {
  it('single character change produces update frame', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    loop.start(makeLines(10));
    await flushReact();

    const writesAfterFirst = stdout.written.length;

    // Change one line in the middle
    const children = [];
    for (let i = 0; i < 10; i++) {
      children.push(React.createElement('text', { key: `line-${i}` }, i === 5 ? 'CHANGED' : `Line ${i}`));
    }
    loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await flushReact();
    loop.stop();

    const snap = loop.perfSnapshot()!;
    const updates = (snap.counts as any).framesUpdate ?? 0;
    expect(updates).toBeGreaterThanOrEqual(1);

    // Diff output should be small (just the changed cell, not a full repaint)
    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    expect(laterWrites.length).toBeGreaterThanOrEqual(1);
    const frame = laterWrites[0]!;
    expect(frame).toContain('CHANGED');
    expect(frame).not.toContain('\x1b[2J');
    expect(frame).not.toContain('\x1b[2K'); // no erase-line in diff
  });
});

describe('frame classification — contamination recovery', () => {
  it('resize triggers full-redraw then returns to normal', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any, { perf: true });

    loop.start(makeLines(8));
    await flushReact();

    loop.perfReset();

    // Resize triggers contamination
    stdout.columns = 30;
    stdout.rows = 10;
    stdout.emit('resize');

    const snap1 = loop.perfSnapshot()!;
    const fullRedraws = (snap1.counts as any).framesFullRedraw ?? 0;
    expect(fullRedraws).toBeGreaterThanOrEqual(1);

    // Subsequent update should be a normal diff, not full redraw
    loop.perfReset();
    loop.update(makeLines(8));
    await flushReact();
    loop.stop();

    const snap2 = loop.perfSnapshot()!;
    const laterFullRedraws = (snap2.counts as any).framesFullRedraw ?? 0;
    expect(laterFullRedraws).toBe(0);
  });
});

describe('frame classification — visual correctness with xterm.js', () => {
  let vfl: VerifiedFrameLoopInstance | null = null;

  afterEach(() => {
    if (vfl) {
      vfl.loop.stop();
      vfl.dispose();
      vfl = null;
    }
  });

  it('append-only growth is visually correct', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(12));
    await vfl.flush();
    vfl.assertFrameCorrect('append — initial');

    // Grow by 1 row at a time
    for (let n = 13; n <= 16; n++) {
      vfl.loop.update(makeLines(n));
      await vfl.flush();
      vfl.assertFrameCorrect(`append — n=${n}`);
    }

    expect(vfl.loop.getScrollbackLines()).toBe(6);
  });

  it('growth-with-unreachable changed row is correct in scrollback', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    // Start with content taller than viewport
    vfl.loop.start(makeLines(15));
    await vfl.flush();
    vfl.assertFrameCorrect('unreachable — initial');

    // Simultaneously add new rows AND change a row above the viewport
    // Line 0 is above the viewport (scrollback row 5, viewport shows rows 5-14)
    const children = [];
    for (let i = 0; i < 20; i++) {
      const text = i === 0 ? 'CHANGED ROW ZERO' : `Line ${i}`;
      children.push(React.createElement('text', { key: `line-${i}` }, text));
    }
    vfl.loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await vfl.flush();
    vfl.assertFrameCorrect('unreachable — after');

    expect(vfl.loop.getScrollbackLines()).toBe(10);
  });

  it('update after growth is visually correct', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(15));
    await vfl.flush();
    vfl.assertFrameCorrect('update-after-growth — initial');

    // Same height, change a visible line
    const children = [];
    for (let i = 0; i < 15; i++) {
      children.push(React.createElement('text', { key: `line-${i}` }, i === 10 ? 'MODIFIED' : `Line ${i}`));
    }
    vfl.loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await vfl.flush();
    vfl.assertFrameCorrect('update-after-growth — modified');
  });
});

describe('frame classification — double-buffer swap', () => {
  it('buffer references swap between frames', async () => {
    const stdout = createMockStdout(40, 10);
    const loop = createFrameLoop(stdout as any);

    loop.start(makeLines(5));
    await flushReact();

    const buf1 = loop.getBuffer();
    expect(buf1).not.toBeNull();

    loop.update(makeLines(5, 'Updated'));
    await flushReact();

    const buf2 = loop.getBuffer();
    expect(buf2).not.toBeNull();
    // Front buffer should be a different object after swap
    expect(buf2).not.toBe(buf1);

    loop.stop();
  });
});
