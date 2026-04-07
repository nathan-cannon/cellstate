/**
 * Frame loop visual correctness tests.
 *
 * These tests verify that the ANSI output produced by the frame loop renders
 * correctly in xterm.js. Every frame type is exercised: first frame (full
 * redraw), update frames (diff only), growth frames (scrollback push), content
 * shrink (triggers full redraw), and resize.
 *
 * The oracle is @xterm/headless via VirtualScreen — same pattern as
 * render-properties.test.ts, but going through the actual frame loop instead
 * of just the diff engine.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import fc from 'fast-check';
import React from 'react';
import {
  createVerifiedFrameLoop,
  assertGridsMatch,
  type VerifiedFrameLoopInstance,
} from '../helpers/verified-frame-loop.js';
import { VirtualScreen } from '../helpers/virtual-screen.js';
import {
  gridToDebugString,
  ColorMode,
  type CellGrid,
  type Cell,
} from '../../src/core/cell.js';
import { createNode, appendChild, type TNode, type Segment } from '../../src/core/nodes.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';
import { paintTree } from '../../src/core/paint.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import { createCellBuffer, readCell, WIDE_WIDTH, CONTINUATION_WIDTH } from '../../src/core/cell-buffer.js';

const _factory = createFlexNodeFactory();

function attachFlexNodes(node: TNode): void {
  const fn = _factory();
  node.flexNode = fn;
  if (node.type === 'text') {
    if (node.text === null) {
      fn.setMeasureFunc((w, wm) => computeTextLayout(node, w, wm));
    }
  } else if (node.type === 'divider') {
    applyBoxProps(fn, node.props);
    fn.setHeight(1);
  } else {
    applyBoxProps(fn, node.props, node.type === 'root');
  }
  for (const child of node.children) {
    if (child.text !== null) continue;
    attachFlexNodes(child);
    fn.insertChild(child.flexNode!, fn.getChildCount());
  }
}

function rasterizeToGrid(root: TNode, width: number): CellGrid {
  attachFlexNodes(root);
  root.flexNode!.setWidth(width);
  root.flexNode!.calculateLayout(width);
  populateLayoutResults(root);
  const ch = root.layout?.height ?? 0;
  if (ch <= 0) return { cells: [], cursorRow: 0, cursorCol: 0, width, height: 0 };
  const ct = new CharTable();
  const st = new StyleTable();
  const lt = new LinkTable();
  const buf = createCellBuffer(width, ch);
  paintTree(root, buf, null, ct, st, lt);
  const cells: Cell[][] = [];
  for (let r = 0; r < buf.height; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < buf.width; c++) {
      const packed = readCell(buf, r, c)!;
      const char = ct.resolve(packed.charId);
      const style = st.resolve(packed.styleId);
      let cellWidth: number;
      if (packed.width === WIDE_WIDTH) cellWidth = 2;
      else if (packed.width === CONTINUATION_WIDTH) cellWidth = 0;
      else cellWidth = 1;
      row.push({
        char,
        width: cellWidth,
        fg: { mode: style.fgMode as ColorMode, value: style.fgValue },
        bg: { mode: style.bgMode as ColorMode, value: style.bgValue },
        attrs: style.attrs,
      });
    }
    cells.push(row);
  }
  return { cells, cursorRow: 0, cursorCol: 0, width: buf.width, height: buf.height };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLines(n: number, prefix = 'Line'): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(React.createElement('text', { key: `line-${i}` }, `${prefix} ${i}`));
  }
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

function makeStyledLines(n: number): React.ReactElement {
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(
      React.createElement(
        'text',
        {
          key: `line-${i}`,
          color: colors[i % colors.length],
          bold: i % 3 === 0,
          italic: i % 5 === 0,
        },
        `Styled line ${i}: ${'x'.repeat(10 + (i % 15))}`,
      ),
    );
  }
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

function makeLinesWithBar(n: number, barText = 'STATUS'): React.ReactElement {
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push(React.createElement('text', { key: `line-${i}` }, `Line ${i}`));
  }
  children.push(React.createElement('text', { key: 'bar' }, barText));
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

function makeCustomLines(lines: { text: string; color?: string; bold?: boolean }[]): React.ReactElement {
  const children = lines.map((l, i) =>
    React.createElement(
      'text',
      { key: `line-${i}`, color: l.color, bold: l.bold },
      l.text,
    ),
  );
  return React.createElement('box', { flexDirection: 'column' }, ...children);
}

// ─── Test lifecycle ─────────────────────────────────────────────────────────

let vfl: VerifiedFrameLoopInstance | null = null;

afterEach(() => {
  if (vfl) {
    vfl.loop.stop();
    vfl.dispose();
    vfl = null;
  }
});

// ─── 1. First frame (full redraw) ──────────────────────────────────────────

describe('frame-loop visual: first frame', () => {
  it('content shorter than viewport', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(3));
    await vfl.flush();
    vfl.assertFrameCorrect('first frame — short content');
  });

  it('content exactly equal to viewport height', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(10));
    await vfl.flush();
    vfl.assertFrameCorrect('first frame — exact fit');
  });

  it('content taller than viewport (immediate growth)', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('first frame — overflow');
    expect(vfl.loop.getScrollbackLines()).toBe(10);
  });

  it('styled content renders with correct colors and attrs', async () => {
    vfl = createVerifiedFrameLoop(60, 10);
    vfl.loop.start(makeStyledLines(8));
    await vfl.flush();
    vfl.assertFrameCorrect('first frame — styled');
  });

  it('single text node', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(React.createElement('text', null, 'hello world'));
    await vfl.flush();
    vfl.assertFrameCorrect('first frame — single text');
  });

  it('empty box — no crash', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(React.createElement('box', null));
    await vfl.flush();
    // No assertFrameCorrect — grid may be null for empty content
    // Just verify no crash
  });
});

// ─── 2. Update frames (diff only) ──────────────────────────────────────────

describe('frame-loop visual: update frames', () => {
  it('single cell change', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('update — before');

    vfl.loop.update(makeCustomLines([
      { text: 'Line 0' },
      { text: 'CHANGED' },
      { text: 'Line 2' },
      { text: 'Line 3' },
      { text: 'Line 4' },
    ]));
    await vfl.flush();
    vfl.assertFrameCorrect('update — after');
  });

  it('style-only change', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeCustomLines([
      { text: 'hello', color: '#ff0000' },
      { text: 'world' },
    ]));
    await vfl.flush();
    vfl.assertFrameCorrect('style update — before');

    vfl.loop.update(makeCustomLines([
      { text: 'hello', color: '#00ff00', bold: true },
      { text: 'world' },
    ]));
    await vfl.flush();
    vfl.assertFrameCorrect('style update — after');
  });

  it('multiple sequential updates (5 frames)', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('sequential — frame 0');

    for (let frame = 1; frame <= 5; frame++) {
      const lines = [];
      for (let i = 0; i < 5; i++) {
        lines.push({
          text: i === frame % 5 ? `Frame ${frame} changed` : `Line ${i}`,
          color: i === frame % 5 ? '#ff0000' : undefined,
        });
      }
      vfl.loop.update(makeCustomLines(lines));
      await vfl.flush();
      vfl.assertFrameCorrect(`sequential — frame ${frame}`);
    }
  });

  it('10 rapid updates — final state correct', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('rapid — initial');

    for (let i = 1; i <= 10; i++) {
      vfl.loop.update(makeLines(5, `Update${i}`));
    }
    await vfl.flush();
    vfl.assertFrameCorrect('rapid — final');

    // Verify final content
    const grid = vfl.loop.getGrid()!;
    const text = gridToDebugString(grid);
    expect(text).toContain('Update10 0');
  });

  it('update within scrolled content — only viewport changes', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('scrolled update — initial');

    // Change a visible line (line 15, which is at viewport row 5)
    const children = [];
    for (let i = 0; i < 20; i++) {
      children.push(
        React.createElement(
          'text',
          { key: `line-${i}`, color: i === 15 ? '#ff0000' : undefined },
          i === 15 ? 'VISIBLE CHANGE' : `Line ${i}`,
        ),
      );
    }
    vfl.loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await vfl.flush();
    vfl.assertFrameCorrect('scrolled update — after change');
  });
});

// ─── 3. Growth frames (scrollback push) ────────────────────────────────────

describe('frame-loop visual: growth frames', () => {
  it('grow from within viewport to overflow', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('growth — before');
    expect(vfl.loop.getScrollbackLines()).toBe(0);

    vfl.loop.update(makeLines(15));
    await vfl.flush();
    vfl.assertFrameCorrect('growth — after');
    expect(vfl.loop.getScrollbackLines()).toBe(5);
  });

  it('multiple growth steps', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('multi-growth — step 0');

    vfl.loop.update(makeLines(12));
    await vfl.flush();
    vfl.assertFrameCorrect('multi-growth — step 1');
    expect(vfl.loop.getScrollbackLines()).toBe(2);

    vfl.loop.update(makeLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('multi-growth — step 2');
    expect(vfl.loop.getScrollbackLines()).toBe(10);

    vfl.loop.update(makeLines(30));
    await vfl.flush();
    vfl.assertFrameCorrect('multi-growth — step 3');
    expect(vfl.loop.getScrollbackLines()).toBe(20);
  });

  it('growth by exactly 1 row', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(10));
    await vfl.flush();
    vfl.assertFrameCorrect('grow-by-1 — before');
    expect(vfl.loop.getScrollbackLines()).toBe(0);

    vfl.loop.update(makeLines(11));
    await vfl.flush();
    vfl.assertFrameCorrect('grow-by-1 — after');
    expect(vfl.loop.getScrollbackLines()).toBe(1);
  });

  it('growth with status bar — bar stays at bottom', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLinesWithBar(15));
    await vfl.flush();
    vfl.assertFrameCorrect('growth+bar');
    expect(vfl.loop.getScrollbackLines()).toBe(6);

    // Verify status bar is in the viewport
    const grid = vfl.loop.getGrid()!;
    const lines = gridToDebugString(grid).split('\n');
    expect(lines[9]).toContain('STATUS');
  });

  it('growth with styled content — styles correct in viewport', async () => {
    vfl = createVerifiedFrameLoop(60, 10);
    vfl.loop.start(makeStyledLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('styled growth — before');

    vfl.loop.update(makeStyledLines(15));
    await vfl.flush();
    vfl.assertFrameCorrect('styled growth — after');
  });
});

// ─── 4. Content shrink (triggers full redraw) ──────────────────────────────

describe('frame-loop visual: content shrink', () => {
  it('shrink from overflow to within viewport', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('shrink — before');
    expect(vfl.loop.getScrollbackLines()).toBe(10);

    vfl.loop.update(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('shrink — after');
    expect(vfl.loop.getScrollbackLines()).toBe(0);
  });

  it('shrink within viewport — no full redraw needed', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(8));
    await vfl.flush();
    vfl.assertFrameCorrect('within-shrink — before');

    vfl.loop.update(makeLines(4));
    await vfl.flush();
    vfl.assertFrameCorrect('within-shrink — after');
  });

  it('spinner removal — shrink by 1 row, no scrollback', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(10));
    await vfl.flush();
    vfl.assertFrameCorrect('spinner — before');

    vfl.loop.update(makeLines(9));
    await vfl.flush();
    vfl.assertFrameCorrect('spinner — after');
  });
});

// ─── 5. Resize ─────────────────────────────────────────────────────────────

describe('frame-loop visual: resize', () => {
  it('resize to smaller terminal', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(5));
    await vfl.flush();
    vfl.assertFrameCorrect('resize — before');

    vfl.resize(20, 5);
    await vfl.flush();
    vfl.assertFrameCorrect('resize — after');
  });

  it('resize to larger terminal', async () => {
    vfl = createVerifiedFrameLoop(30, 8);
    vfl.loop.start(makeLines(6));
    await vfl.flush();
    vfl.assertFrameCorrect('resize-larger — before');

    vfl.resize(60, 15);
    await vfl.flush();
    vfl.assertFrameCorrect('resize-larger — after');
  });

  it('resize with scrolled content', async () => {
    vfl = createVerifiedFrameLoop(40, 10);
    vfl.loop.start(makeLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('resize-scrolled — before');
    expect(vfl.loop.getScrollbackLines()).toBe(10);

    vfl.resize(40, 15);
    await vfl.flush();
    vfl.assertFrameCorrect('resize-scrolled — after');
    expect(vfl.loop.getScrollbackLines()).toBe(5);
  });
});

// ─── 6. Multi-frame composition (property-based stress test) ───────────────

describe('frame-loop visual: multi-frame composition', () => {
  it('10-frame sequence with varying content', async () => {
    vfl = createVerifiedFrameLoop(40, 10);

    const states = [
      makeLines(3),
      makeLines(7),
      makeLines(5),
      makeLines(12),  // growth
      makeLines(8),   // shrink with stale scrollback -> full redraw
      makeLines(15),  // growth again
      makeLines(15, 'Changed'),  // same height, different content
      makeLines(10),  // shrink back
      makeLines(20),  // big growth
      makeLines(6),   // big shrink
    ];

    vfl.loop.start(states[0]!);
    await vfl.flush();
    vfl.assertFrameCorrect('multi — frame 0');

    for (let i = 1; i < states.length; i++) {
      vfl.loop.update(states[i]!);
      await vfl.flush();
      vfl.assertFrameCorrect(`multi — frame ${i}`);
    }
  });

  it('property: random content heights over 15 frames', async () => {
    const heightsArb = fc.array(
      fc.integer({ min: 1, max: 30 }),
      { minLength: 15, maxLength: 15 },
    );

    const samples = fc.sample(heightsArb, 20);

    for (let s = 0; s < samples.length; s++) {
      const heights = samples[s]!;
      const testVfl = createVerifiedFrameLoop(40, 10);

      try {
        testVfl.loop.start(makeLines(heights[0]!));
        await testVfl.flush();
        testVfl.assertFrameCorrect(`prop[${s}] — frame 0 (h=${heights[0]})`);

        for (let f = 1; f < heights.length; f++) {
          testVfl.loop.update(makeLines(heights[f]!));
          await testVfl.flush();
          testVfl.assertFrameCorrect(`prop[${s}] — frame ${f} (h=${heights[f]})`);
        }
      } finally {
        testVfl.loop.stop();
        testVfl.dispose();
      }
    }
  }, 60_000);

  it('property: random styled content over 10 frames', async () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'] as const;

    const lineArb = fc.record({
      text: fc.stringMatching(/^[\x20-\x7e]{1,25}$/),
      color: fc.constantFrom(...colors),
      bold: fc.boolean(),
    });

    const frameArb = fc.array(lineArb, { minLength: 1, maxLength: 20 });
    const sequenceArb = fc.array(frameArb, { minLength: 10, maxLength: 10 });

    const samples = fc.sample(sequenceArb, 15);

    for (let s = 0; s < samples.length; s++) {
      const frames = samples[s]!;
      const testVfl = createVerifiedFrameLoop(50, 10);

      try {
        testVfl.loop.start(makeCustomLines(frames[0]!));
        await testVfl.flush();
        testVfl.assertFrameCorrect(`styled-prop[${s}] — frame 0`);

        for (let f = 1; f < frames.length; f++) {
          testVfl.loop.update(makeCustomLines(frames[f]!));
          await testVfl.flush();
          testVfl.assertFrameCorrect(`styled-prop[${s}] — frame ${f}`);
        }
      } finally {
        testVfl.loop.stop();
        testVfl.dispose();
      }
    }
  }, 60_000);
});

// ─── 7. Scrollback styling integrity ───────────────────────────────────────

describe('scrollback styling integrity', () => {
  it('styled rows in scrollback retain correct styling', async () => {
    vfl = createVerifiedFrameLoop(50, 10);

    // Render styled content taller than viewport
    vfl.loop.start(makeStyledLines(20));
    await vfl.flush();
    vfl.assertFrameCorrect('scrollback styling — viewport');

    // Now verify scrollback content by reading the full xterm buffer
    const fullGrid = vfl.readFullGrid();
    const cellstateGrid = vfl.loop.getGrid()!;

    // The viewport grid (last 10 rows of fullGrid starting from baseY)
    // should already be verified by assertFrameCorrect above.
    // Now check that scrollback rows have non-default styling.
    const baseY = vfl.xtermBaseY();
    expect(baseY).toBeGreaterThan(0);

    // Check that scrollback rows (0 to baseY-1) have content and styling
    let styledCellsInScrollback = 0;
    for (let r = 0; r < baseY; r++) {
      for (let c = 0; c < fullGrid.width; c++) {
        const cell = fullGrid.cells[r]![c]!;
        if (cell.fg.mode !== ColorMode.Default || cell.attrs !== 0) {
          styledCellsInScrollback++;
        }
      }
    }

    // Scrollback should have substantial styled content
    // (each row has colored text, so at least a few styled cells per row)
    expect(styledCellsInScrollback).toBeGreaterThan(baseY * 5);
  });

  it('property: scrollback content matches rasterized grid rows', async () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'] as const;

    const lineArb = fc.record({
      text: fc.stringMatching(/^[\x20-\x7e]{5,30}$/),
      color: fc.constantFrom(...colors),
      bold: fc.boolean(),
    });

    const samples = fc.sample(
      fc.array(lineArb, { minLength: 15, maxLength: 30 }),
      10,
    );

    for (let s = 0; s < samples.length; s++) {
      const lines = samples[s]!;
      const testVfl = createVerifiedFrameLoop(50, 10);

      try {
        testVfl.loop.start(makeCustomLines(lines));
        await testVfl.flush();
        testVfl.assertFrameCorrect(`scrollback-prop[${s}] — viewport`);

        // Read the full xterm.js buffer to verify scrollback
        const fullGrid = testVfl.readFullGrid();
        const baseY = testVfl.xtermBaseY();

        if (baseY > 0) {
          // Build the expected grid by rasterizing the content ourselves
          const root = createNode('root', {});
          for (let i = 0; i < lines.length; i++) {
            const textEl = createNode('text', {
              color: lines[i]!.color,
              bold: lines[i]!.bold,
            });
            const inst = createNode('text', {});
            inst.text = lines[i]!.text;
            appendChild(textEl, inst);
            appendChild(root, textEl);
          }
          const expectedGrid = rasterizeToGrid(root, 50);

          // Check scrollback rows match expected content (chars).
          // readFullGrid() reads from row 0 with viewport-height rows,
          // so fullGrid.height = viewport rows (10). When baseY > 0, those
          // rows are the scrollback rows. We compare up to the available rows.
          const checkRows = Math.min(baseY, fullGrid.height, expectedGrid.height);
          for (let r = 0; r < checkRows; r++) {
            for (let c = 0; c < 50; c++) {
              const xtermCell = fullGrid.cells[r]![c]!;
              const expectedCell = expectedGrid.cells[r]![c]!;

              // Compare character content
              if (xtermCell.width === 0 && expectedCell.width === 0) continue;
              if (xtermCell.char !== expectedCell.char) {
                throw new Error(
                  `scrollback-prop[${s}]: char mismatch in scrollback row ${r}, col ${c}\n` +
                    `  xterm: '${xtermCell.char}'\n` +
                    `  expected: '${expectedCell.char}'\n` +
                    `  baseY=${baseY}, lines=${lines.length}`,
                );
              }
            }
          }
        }
      } finally {
        testVfl.loop.stop();
        testVfl.dispose();
      }
    }
  }, 30_000);
});
