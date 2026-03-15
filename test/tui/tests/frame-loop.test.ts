import { describe, it, expect, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { createFrameLoop } from '../frame-loop.js';
import { gridToDebugString } from '../../cell.js';

// ---------------------------------------------------------------------------
// Mock stdout
// ---------------------------------------------------------------------------

interface MockStdout extends NodeJS.WriteStream {
  written: string[];
  columns: number;
  rows: number;
  /** Override to simulate backpressure (return false) */
  writeReturns: boolean;
}

function createMockStdout(cols = 40, rows = 10): MockStdout {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let writeReturns = true;

  const mock = Object.assign(emitter, {
    written,
    columns: cols,
    rows,
    writeReturns: true,
    writable: true,
    write(chunk: any, ...args: any[]): boolean {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return mock.writeReturns;
    },
    end: () => mock,
    destroy: () => mock,
    cork: () => {},
    uncork: () => {},
    isTTY: true,
    // Satisfy NodeJS.WriteStream shape enough for our purposes
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

// ---------------------------------------------------------------------------
// Helper: wait for React concurrent mode to flush commits
// ---------------------------------------------------------------------------
async function flushReact(): Promise<void> {
  // React concurrent mode schedules via microtasks + scheduler.
  // Multiple rounds of microtask flushing ensures commits complete.
  // The frame loop uses setTimeout(8) for initial frame, setTimeout(4)
  // for normal gap, and setTimeout(50) after growth frames.
  // 8 × 10ms = 80ms covers all timer variants.
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Helper: create N text lines as children of a column box
// ---------------------------------------------------------------------------
function makeLines(n: number): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(React.createElement('text', { key: `line-${i}` }, `Line ${i}`));
  }
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

// ---------------------------------------------------------------------------
// Helper: create N text lines + a status bar as regular bottom child
// ---------------------------------------------------------------------------
function makeLinesWithBar(n: number, barText = 'STATUS'): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(React.createElement('text', { key: `line-${i}` }, `Line ${i}`));
  }
  children.push(React.createElement('text', { key: 'bar' }, barText));
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

// ---------------------------------------------------------------------------
// Basic tests
// ---------------------------------------------------------------------------

describe('frame-loop', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('first frame produces output containing rendered text', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'hello'));
    await flushReact();
    loop.stop();

    expect(stdout.written.length).toBeGreaterThanOrEqual(1);
    const all = stdout.written.join('');
    expect(all).toContain('hello');
  });

  it('update produces diff, not full redraw', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'hello'));
    await flushReact();

    const writesAfterFirst = stdout.written.length;
    loop.update(React.createElement('text', null, 'world'));
    await flushReact();
    loop.stop();

    expect(stdout.written.length).toBeGreaterThan(writesAfterFirst);
    const secondWrites = stdout.written.slice(writesAfterFirst).join('');
    // Strip ANSI escapes to get just the text characters emitted
    const textOnly = secondWrites.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '');
    // Diff emits 'wor' (positions 0-2 changed) + 'd' (position 4 changed)
    expect(textOnly).toContain('wor');
    expect(textOnly).toContain('d');
  });

  it('DEC 2026 wrapping on every frame write', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'wrapped'));
    await flushReact();
    loop.stop();

    // Filter out cursor hide/show control writes (from start/stop)
    const frameWrites = stdout.written.filter(
      (chunk) => chunk !== '\x1b[?25l' && !chunk.includes('\x1b[?25h'),
    );
    expect(frameWrites.length).toBeGreaterThanOrEqual(1);
    for (const chunk of frameWrites) {
      expect(chunk).toContain('\x1b[?2026h');
      expect(chunk.endsWith('\x1b[?2026l')).toBe(true);
    }
  });

  it('content growth — add child', async () => {
    const loop = createFrameLoop(stdout as any);

    loop.start(
      React.createElement('box', { flexDirection: 'column' },
        React.createElement('text', { key: 'a' }, 'first'),
      ),
    );
    await flushReact();

    loop.update(
      React.createElement('box', { flexDirection: 'column' },
        React.createElement('text', { key: 'a' }, 'first'),
        React.createElement('text', { key: 'b' }, 'second'),
      ),
    );
    await flushReact();
    loop.stop();

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('first');
    expect(text).toContain('second');
    const lines = text.split('\n');
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('content shrink — remove child clears vacated cells', async () => {
    const loop = createFrameLoop(stdout as any);

    loop.start(
      React.createElement('box', { flexDirection: 'column' },
        React.createElement('text', { key: 'a' }, 'first'),
        React.createElement('text', { key: 'b' }, 'second'),
      ),
    );
    await flushReact();

    loop.update(
      React.createElement('box', { flexDirection: 'column' },
        React.createElement('text', { key: 'a' }, 'first'),
      ),
    );
    await flushReact();
    loop.stop();

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('first');
    const lines = text.split('\n');
    if (lines.length > 1) {
      expect(lines[1]!.trim()).toBe('');
    }
  });

  it('resize triggers clear screen before frame content', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'before resize'));
    await flushReact();

    const writesBeforeResize = stdout.written.length;

    stdout.columns = 20;
    stdout.rows = 5;
    stdout.emit('resize');

    loop.stop();

    const resizeWrites = stdout.written.slice(writesBeforeResize);
    expect(resizeWrites.length).toBeGreaterThanOrEqual(1);
    const resizeOutput = resizeWrites.join('');
    expect(resizeOutput).toContain('\x1b[2J');
  });

  it('resize invalidation forces full redraw at new dimensions', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'resize me'));
    await flushReact();

    stdout.columns = 20;
    stdout.rows = 5;
    stdout.emit('resize');

    loop.stop();

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    expect(grid!.width).toBe(20);
    expect(grid!.height).toBe(5);
    const text = gridToDebugString(grid!);
    expect(text).toContain('resize me');
  });

  it('multiple rapid updates — final grid reflects last update', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'initial'));
    await flushReact();

    const writesBeforeUpdates = stdout.written.length;

    loop.update(React.createElement('text', null, 'update-1'));
    loop.update(React.createElement('text', null, 'update-2'));
    loop.update(React.createElement('text', null, 'update-3'));
    await flushReact();
    loop.stop();

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('update-3');

    const writesAfter = stdout.written.length - writesBeforeUpdates;
    expect(writesAfter).toBeGreaterThanOrEqual(1);
  });

  it('empty tree — no crash', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('box', null));
    await flushReact();
    loop.stop();

    expect(true).toBe(true);
  });

  it('flush guard — backpressure defers frame, drain processes pending', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('text', null, 'start'));
    await flushReact();

    stdout.writeReturns = false;
    const writesBeforeBackpressure = stdout.written.length;

    loop.update(React.createElement('text', null, 'under-pressure'));
    await flushReact();

    const writesAfterPressure = stdout.written.length;
    expect(writesAfterPressure).toBeGreaterThan(writesBeforeBackpressure);

    loop.update(React.createElement('text', null, 'deferred'));
    await flushReact();

    const writesWhileFlushing = stdout.written.length;
    expect(writesWhileFlushing).toBe(writesAfterPressure);

    stdout.writeReturns = true;
    stdout.emit('drain');
    await flushReact(); // wait for drain's deferred frame timer

    const writesAfterDrain = stdout.written.length;
    expect(writesAfterDrain).toBeGreaterThan(writesWhileFlushing);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('deferred');

    loop.stop();
  });
});

// ---------------------------------------------------------------------------
// Growth frame tests
// ---------------------------------------------------------------------------

describe('frame-loop — growth frames', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('growth frame renders content into scrollback', async () => {
    // Content goes from 0 to 30 rows, viewport 10.
    // scrollbackRows should be 20 after the frame.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(30));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(20);

    // Output should contain actual content characters for the new rows
    const all = stdout.written.join('');
    expect(all).toContain('Line 0');
    expect(all).toContain('Line 15');
    expect(all).toContain('Line 29');

    // Grid shows last 10 visible rows
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 20');
    expect(text).toContain('Line 29');
  });

  it('growth frame with status bar in content flow', async () => {
    // 15 content lines + 1 status bar = 16 rows in 10-row viewport
    // effectiveViewport = 10, scrollbackRows = 6
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(15));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(6);

    // Output should contain line-erase sequences (\x1b[2K) from fullRedraw
    const all = stdout.written.join('');
    expect(all).toContain('\x1b[2K');

    // Bar is present in the final viewport
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[9]).toContain('STATUS');
  });

  it('growth frame with status bar — bar at bottom of final viewport', async () => {
    // 20 content lines + 1 status bar = 21 rows in 10-row viewport.
    // Growth frame pre-paints correct content, scrolls, then redraws.
    // Status bar appears at the bottom of the final viewport grid.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(20));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(11);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[9]).toContain('STATUS');
  });

  it('growth within viewport — no scrollback', async () => {
    // Content goes from 3 to 7 rows, viewport 10.
    // scrollbackRows stays 0.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(3));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(0);

    loop.update(makeLines(7));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 0');
    expect(text).toContain('Line 6');
  });

  it('growth causing exactly 1 row of scrollback', async () => {
    // Content goes from 0 to 11 rows, viewport 10.
    // scrollbackRows = 1 after the frame, exactly 1 row pushed into scrollback.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(11));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(1);

    // Grid shows lines 1-10
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Line 1');
    expect(lines[9]).toContain('Line 10');
  });

  it('frame after growth uses diff', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(13));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(3);
    const writesAfterGrowth = stdout.written.length;

    // Same content size, change one line — should trigger update (diff) frame
    const children = [];
    for (let i = 0; i < 13; i++) {
      const text = i === 5 ? 'CHANGED' : `Line ${i}`;
      children.push(React.createElement('text', { key: `line-${i}` }, text));
    }
    loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await flushReact();
    loop.stop();

    // Second frame should be a diff (small output), confirming prevGrid was set
    const laterWrites = stdout.written.slice(writesAfterGrowth).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    if (laterWrites.length > 0) {
      const frame = laterWrites[0]!;
      // Should NOT contain clear screen
      expect(frame).not.toContain('\x1b[2J');
      // Should contain diff content
      expect(frame).toContain('\x1b[?2026h');
    }
  });

  it('scrollbackRows precision across multiple growth frames', async () => {
    const loop = createFrameLoop(stdout as any);

    // 0 → 5 (no overflow, scrollbackRows=0)
    loop.start(makeLines(5));
    await flushReact();
    expect(loop.getScrollbackLines()).toBe(0);

    // 5 → 12 (overflow by 2, scrollbackRows=2)
    loop.update(makeLines(12));
    await flushReact();
    expect(loop.getScrollbackLines()).toBe(2);

    // 12 → 25 (overflow by 13 more, scrollbackRows=15)
    loop.update(makeLines(25));
    await flushReact();
    expect(loop.getScrollbackLines()).toBe(15);

    loop.stop();
  });
});

// ---------------------------------------------------------------------------
// Update frame tests
// ---------------------------------------------------------------------------

describe('frame-loop — update frames', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('update frame diffs without growth', async () => {
    // Content is 30 rows (already overflowed, scrollbackRows=20).
    // Change one visible cell. Verify output is a small diff patch, not fullRedraw.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(30));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(20);
    const writesAfterFirst = stdout.written.length;

    // Same size but change a visible line
    const children = [];
    for (let i = 0; i < 30; i++) {
      const text = i === 25 ? 'CHANGED' : `Line ${i}`;
      children.push(React.createElement('text', { key: `line-${i}` }, text));
    }
    loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await flushReact();
    loop.stop();

    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    expect(laterWrites.length).toBeGreaterThanOrEqual(1);
    const frame = laterWrites[0]!;
    // Should not contain clear screen (not full redraw)
    expect(frame).not.toContain('\x1b[2J');
    // Should contain CHANGED text
    expect(frame).toContain('CHANGED');
  });

  it('diff engine only sees viewport content', async () => {
    // Content 30 rows, viewport 10, scrollbackRows 20.
    // Two frames with identical viewport content → diff empty/minimal.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(30));
    await flushReact();

    const writesAfterFirst = stdout.written.length;

    // Same exact content → no visible changes
    loop.update(makeLines(30));
    await flushReact();
    loop.stop();

    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    // Either no writes or very small diff (empty diff skips write entirely)
    if (laterWrites.length > 0) {
      const frame = laterWrites[0]!;
      // Strip DEC 2026 and cursor home to see if there's actual content
      const stripped = frame
        .replace(/\x1b\[\?2026[hl]/g, '')
        .replace(/\x1b\[H/g, '');
      // Should be empty or near-empty (just the wrapping, no actual cell changes)
      expect(stripped.length).toBeLessThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Full redraw tests
// ---------------------------------------------------------------------------

describe('frame-loop — full redraw', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('full redraw on first frame', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(5));
    await flushReact();
    loop.stop();

    const frameWrites = stdout.written.filter(
      (chunk) => chunk !== '\x1b[?25l' && !chunk.includes('\x1b[?25h'),
    );
    expect(frameWrites.length).toBeGreaterThanOrEqual(1);
    // First write contains the clear screen sequence
    expect(frameWrites[0]!).toContain('\x1b[2J');
    expect(frameWrites[0]!).toContain('\x1b[3J');
    // Content appears in one of the writes (first or second depending on overflow)
    const allOutput = frameWrites.join('');
    expect(allOutput).toContain('Line 0');
  });

  it('full redraw on resize', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(15));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(5);
    const writesBeforeResize = stdout.written.length;

    // Resize resets scrollbackRows to 0, then re-renders via full redraw
    stdout.columns = 40;
    stdout.rows = 10;
    stdout.emit('resize');

    // scrollbackRows reset then re-established
    expect(loop.getScrollbackLines()).toBe(5);

    const resizeWrites = stdout.written.slice(writesBeforeResize);
    const resizeOutput = resizeWrites.join('');
    expect(resizeOutput).toContain('\x1b[2J');

    loop.stop();
  });

  it('content shrink with stale scrollback triggers full redraw', async () => {
    const loop = createFrameLoop(stdout as any);
    // 30 rows: scrollbackRows = 20
    loop.start(makeLines(30));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(20);

    // Shrink to 5: 5 < 20 + 10, triggers full redraw
    loop.update(makeLines(5));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    const all = stdout.written.join('');
    // Should contain clear screen from the shrink
    // (at least 2 clear screens: first frame + shrink)
    const clearCount = all.split('\x1b[2J').length - 1;
    expect(clearCount).toBeGreaterThanOrEqual(2);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 0');
    expect(text).toContain('Line 4');
  });

  it('content shrink within viewport — no full redraw', async () => {
    const loop = createFrameLoop(stdout as any);
    // 8 rows: scrollbackRows = 0
    loop.start(makeLines(8));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(0);
    const writesAfterFirst = stdout.written.length;

    // Shrink to 5: still within viewport, no stale scrollback
    loop.update(makeLines(5));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    // Second frame should be a diff, not full redraw
    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    for (const chunk of laterWrites) {
      expect(chunk).not.toContain('\x1b[2J');
    }
  });

  it('content shrink into scrollback triggers full redraw', async () => {
    const loop = createFrameLoop(stdout as any);
    // 20 lines on 10-row viewport → scrollbackRows = 10
    loop.start(makeLines(20));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(10);

    // Shrink to 8: desiredScrollback = max(0, 8-10) = 0 < 10 → full redraw
    loop.update(makeLines(8));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    const all = stdout.written.join('');
    // At least 2 clear screens: first frame + content-shrink full redraw
    const clearCount = all.split('\x1b[2J').length - 1;
    expect(clearCount).toBeGreaterThanOrEqual(2);
  });

  it('spinner disappearing — no full redraw when scrollback unchanged', async () => {
    // Terminal: 40x10. 10 lines → scrollbackRows = 0. No overflow.
    const loop = createFrameLoop(stdout as any);
    // 10 lines exactly fills viewport
    loop.start(makeLines(10));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(0);
    const writesAfterFirst = stdout.written.length;

    // Shrink to 9 (spinner removed): desiredScrollback = 0 = scrollbackRows → diff path
    loop.update(makeLines(9));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    // No clear screen in the shrink frame
    const laterWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    for (const chunk of laterWrites) {
      expect(chunk).not.toContain('\x1b[2J');
    }

    // Grid should reflect the 9 lines
    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    expect(text).toContain('Line 0');
    expect(text).toContain('Line 8');
    expect(text).not.toContain('Line 9');
  });

  it('resize does not double-clear', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(5));
    await flushReact();

    const writesBeforeResize = stdout.written.length;

    stdout.columns = 20;
    stdout.rows = 5;
    stdout.emit('resize');

    loop.stop();

    const resizeWrites = stdout.written.slice(writesBeforeResize).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    expect(resizeWrites.length).toBeGreaterThanOrEqual(1);
    const resizeOutput = resizeWrites[0]!;
    const clearCount = resizeOutput.split('\x1b[2J').length - 1;
    expect(clearCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixed bar tests
// ---------------------------------------------------------------------------

describe('frame-loop — status bar in content flow', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('overflow computed against full viewport rows', async () => {
    // 15 content lines + 1 status bar = 16 rows in 10-row terminal
    // effectiveViewport = 10. scrollbackRows = 16 - 10 = 6
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(15));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(6);
  });

  it('status bar stays at bottom after scroll', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(15));
    await flushReact();
    loop.stop();

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[9]).toContain('STATUS');
  });

  it('no overflow with status bar — content fits in viewport', async () => {
    // 8 content lines + 1 status bar = 9 rows in 10-row terminal. No overflow.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(8));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Line 0');
    expect(lines[7]).toContain('Line 7');
    expect(lines[8]).toContain('STATUS');
  });

  it('full pipeline: overflow with status bar — content scrolled, bar at bottom', async () => {
    // 20 content lines + 1 status bar = 21 rows in 10-row terminal
    // effectiveViewport = 10. scrollbackRows = 21 - 10 = 11.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(20));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(11);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    expect(lines[0]).toContain('Line 11');
    expect(lines[8]).toContain('Line 19');
    expect(lines[9]).toContain('STATUS');
  });

  it('physical scrollback aligned with status bar — correct scrollbackRows', async () => {
    // 20 content lines + 1 status bar = 21 rows in 10-row terminal.
    // effectiveViewport = 10. desiredScrollback = 21 - 10 = 11.
    // Growth frame emits 11 \n (newScrollNeeded) in the scroll phase to push
    // 11 rows into scrollback, achieving the correct scrollbackRows.
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(20));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(11);

    // Growth frame is a single write. Verify the write contains 11 \n
    // (one per scrolled row) and the final grid has STATUS at the bottom.
    const frameWrites = stdout.written.filter(
      (chunk) => chunk !== '\x1b[?25l' && !chunk.includes('\x1b[?25h'),
    );
    const growthWrite = frameWrites[0]!;
    const newlineCount = (growthWrite.match(/\n/g) || []).length;
    expect(newlineCount).toBe(11);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const lines = gridToDebugString(grid!).split('\n');
    expect(lines[9]).toContain('STATUS');
  });

  it('resize with status bar — viewport content correct after height change', async () => {
    // Start: 20 content + 1 bar = 21 rows, 10-row terminal, effectiveViewport=10, scrollbackRows=11
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLinesWithBar(20));
    await flushReact();

    expect(loop.getScrollbackLines()).toBe(11);

    // Resize to 15 rows. effectiveViewport=15. scrollbackRows = 21-15=6.
    stdout.columns = 40;
    stdout.rows = 15;
    stdout.emit('resize');

    expect(loop.getScrollbackLines()).toBe(6);

    const grid = loop.getGrid();
    expect(grid).not.toBeNull();
    const text = gridToDebugString(grid!);
    const lines = text.split('\n');
    // Viewport rows 0-13 show Lines 6-19 (14 content rows)
    expect(lines[0]).toContain('Line 6');
    expect(lines[13]).toContain('Line 19');
    // Row 14 shows the bar
    expect(lines[14]).toContain('STATUS');

    loop.stop();
  });
});

// ---------------------------------------------------------------------------
// Misc frame loop properties
// ---------------------------------------------------------------------------

describe('frame-loop — properties', () => {
  let stdout: MockStdout;

  beforeEach(() => {
    stdout = createMockStdout(40, 10);
  });

  it('full redraw produces two stdout.write calls (clear + redraw)', async () => {
    // Full redraw (first frame) produces 2 writes: clear+pre-paint and viewport redraw.
    // Growth frames (subsequent) produce 1 write (pre-paint+scroll+redraw in one block).
    const loop = createFrameLoop(stdout as any);
    const writesBefore = stdout.written.length;
    loop.start(makeLines(15));
    await flushReact();

    const frameWrites = stdout.written.slice(writesBefore).filter(
      (chunk) => chunk !== '\x1b[?25l',
    );
    // First frame is doFullRedraw → 2 writes
    expect(frameWrites.length).toBe(2);

    loop.stop();
  });

  it('zero-height content — no overflow, no crash', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(React.createElement('box', null));
    await flushReact();
    loop.stop();

    expect(loop.getScrollbackLines()).toBe(0);
    expect(true).toBe(true);
  });

  it('second frame does NOT contain clear screen sequence', async () => {
    const loop = createFrameLoop(stdout as any);
    loop.start(makeLines(5));
    await flushReact();

    const writesAfterFirst = stdout.written.length;
    loop.update(makeLines(6));
    await flushReact();
    loop.stop();

    const secondWrites = stdout.written.slice(writesAfterFirst).filter(
      (chunk) => !chunk.includes('\x1b[?25h'),
    );
    for (const chunk of secondWrites) {
      expect(chunk).not.toContain('\x1b[2J');
      expect(chunk).not.toContain('\x1b[3J');
    }
  });
});
