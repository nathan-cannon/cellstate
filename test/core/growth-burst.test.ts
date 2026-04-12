/**
 * Tests for large single-frame content growth (burst growth).
 *
 * Reproduces a bug where jumping from ~5 rows to 80+ rows in one React
 * commit causes content duplication on screen. The growth frame emit
 * logic serializes overlapping content so rows appear twice.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import React from 'react';
import {
  createVerifiedFrameLoop,
  type VerifiedFrameLoopInstance,
} from '../helpers/verified-frame-loop.js';
import { gridToDebugString } from '../../src/core/cell.js';
import { paintTree } from '../../src/core/paint.js';
import { createNode, appendChild, type TNode } from '../../src/core/nodes.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import {
  createCellBuffer,
  isDamaged,
  viewportSlice,
} from '../../src/core/cell-buffer.js';
import {
  diffBuffers,
  serializeAll,
  InlineCursor,
} from '../../src/core/emit.js';

// --- Helpers ---

const _factory = createFlexNodeFactory();

function attachFlexNodes(node: TNode): void {
  const fn = _factory();
  node.flexNode = fn;
  if (node.type === 'text') {
    if (node.text === null) {
      fn.setMeasureFunc((w, wm) => computeTextLayout(node, w, wm));
    }
  } else {
    applyBoxProps(fn, node.props, node.type === 'root');
  }
  for (const child of node.children) {
    if (child.text !== null) continue;
    attachFlexNodes(child);
    fn.insertChild(child.flexNode!, fn.getChildCount());
  }
}

function makeText(content: string, props: Record<string, any> = {}): TNode {
  const el = createNode('text', { segments: [{ text: content }], ...props });
  const inst = createNode('text', {});
  inst.text = content;
  appendChild(el, inst);
  return el;
}

function buildAndPaint(
  texts: string[],
  width: number,
  front: import('../../src/core/cell-buffer.js').CellBuffer | null,
  tables: { ct: CharTable; st: StyleTable; lt: LinkTable },
): { root: TNode; buf: import('../../src/core/cell-buffer.js').CellBuffer } {
  const root = createNode('root');
  for (const t of texts) {
    appendChild(root, makeText(t));
  }
  attachFlexNodes(root);
  root.flexNode!.setWidth(width);
  root.flexNode!.calculateLayout(width);
  populateLayoutResults(root);

  const h = root.layout?.height ?? 1;
  const buf = createCellBuffer(width, h);
  paintTree(root, buf, front, tables.ct, tables.st, tables.lt, 0);
  return { root, buf };
}

function makeTables() {
  return { ct: new CharTable(), st: new StyleTable(), lt: new LinkTable() };
}

// --- xterm.js verified tests ---

describe('growth burst — xterm.js verified', () => {
  let vfl: VerifiedFrameLoopInstance | null = null;

  afterEach(() => {
    if (vfl) {
      vfl.loop.stop();
      vfl.dispose();
      vfl = null;
    }
  });

  it('burst from 2 rows to 60+ rows: no duplicated content', async () => {
    vfl = createVerifiedFrameLoop(40, 20);

    // Small initial content: header + short body
    vfl.loop.start(
      React.createElement(
        'box',
        { flexDirection: 'column' },
        React.createElement('text', { key: 'header' }, 'Header'),
        React.createElement('text', { key: 'body' }, 'Short'),
      ),
    );
    await vfl.flush();
    vfl.assertFrameCorrect('initial');

    // Burst growth: replace body with 60 lines
    const bodyLines: string[] = [];
    for (let i = 1; i <= 60; i++) bodyLines.push(`Line ${i}`);
    const longBody = bodyLines.join('\n');

    vfl.loop.update(
      React.createElement(
        'box',
        { flexDirection: 'column' },
        React.createElement('text', { key: 'header' }, 'Header'),
        React.createElement('text', { key: 'body' }, longBody),
      ),
    );
    await vfl.flush();

    // Verify xterm.js matches CellState
    vfl.assertFrameCorrect('after burst');

    // Extra check: scan the full grid for duplicates
    const fullGrid = vfl.readFullGrid();
    const fullText = gridToDebugString(fullGrid);

    // "Header" should appear exactly once
    const headerCount = (fullText.match(/Header/g) || []).length;
    expect(headerCount).toBe(1);

    // "Line 1" should appear exactly once (not duplicated)
    const line1Count = (fullText.match(/Line 1\b/g) || []).length;
    expect(line1Count).toBe(1);
  });

  it('burst from 3 rows to 80 rows with viewport=10: correct scrollback', async () => {
    vfl = createVerifiedFrameLoop(40, 10);

    // Start with 3 text elements
    const initial = React.createElement(
      'box',
      { flexDirection: 'column' },
      React.createElement('text', { key: 'a' }, 'Alpha'),
      React.createElement('text', { key: 'b' }, 'Beta'),
      React.createElement('text', { key: 'c' }, 'Gamma'),
    );
    vfl.loop.start(initial);
    await vfl.flush();
    vfl.assertFrameCorrect('initial-3');

    // Burst to 80 individual text elements
    const children: React.ReactElement[] = [];
    for (let i = 0; i < 80; i++) {
      children.push(React.createElement('text', { key: `row-${i}` }, `Row ${i}`));
    }
    vfl.loop.update(React.createElement('box', { flexDirection: 'column' }, ...children));
    await vfl.flush();

    vfl.assertFrameCorrect('after-burst-80');

    // Viewport should show the last 10 rows
    const vpGrid = vfl.readViewportGrid();
    const vpText = gridToDebugString(vpGrid);
    expect(vpText).toContain('Row 79');
    expect(vpText).toContain('Row 70');

    // Scrollback should contain the earlier rows
    expect(vfl.loop.getScrollbackLines()).toBe(70);
  });

  it('growth-with-unreachable from scrollbackRows=0: no duplication', async () => {
    // This reproduces the exact bug: content jumps from small to very large
    // in one commit. Previously, a pre-paint step overflowed the viewport
    // and desynchronized scrollback tracking, causing content duplication.
    vfl = createVerifiedFrameLoop(68, 30);

    // Start with ~30 rows of content (fills viewport, no scrollback)
    const initialChildren: React.ReactElement[] = [];
    for (let i = 0; i < 30; i++) {
      initialChildren.push(React.createElement('text', { key: `row-${i}` }, `Initial ${i}`));
    }
    vfl.loop.start(React.createElement('box', { flexDirection: 'column' }, ...initialChildren));
    await vfl.flush();
    vfl.assertFrameCorrect('initial-30');
    expect(vfl.loop.getScrollbackLines()).toBe(0);

    // Burst to 278 rows in one commit (the exact scenario from the bug report)
    const burstChildren: React.ReactElement[] = [];
    for (let i = 0; i < 278; i++) {
      burstChildren.push(React.createElement('text', { key: `row-${i}` }, `Content ${i}`));
    }
    vfl.loop.update(React.createElement('box', { flexDirection: 'column' }, ...burstChildren));
    await vfl.flush();

    // assertFrameCorrect compares CellState's grid against xterm.js viewport.
    // If the duplication bug exists, xterm.js will show different content
    // than CellState expects (the duplicated rows shift everything).
    vfl.assertFrameCorrect('after-burst-278');

    // Viewport should show the last 30 rows
    const vpText = gridToDebugString(vfl.readViewportGrid());
    expect(vpText).toContain('Content 277');
    expect(vpText).toContain('Content 248');

    // Scrollback should be 248 rows
    expect(vfl.loop.getScrollbackLines()).toBe(248);
  });
});

// --- Unit tests (no xterm.js) ---

describe('growth burst — unit tests', () => {
  it('large burst produces damage covering content', () => {
    const tables = makeTables();
    const width = 40;

    // Small front buffer (5 rows)
    const { buf: front } = buildAndPaint(
      ['Header', 'Short', 'A', 'B', 'C'],
      width,
      null,
      tables,
    );

    // Large back buffer (80 rows) — pass null as front because these are
    // independent trees; populateLayoutResults sets _prevBounds which would
    // cause incorrect blitting from the smaller front buffer.
    const lines: string[] = ['Header'];
    for (let i = 1; i <= 79; i++) lines.push(`Line ${i}`);
    const { buf: back } = buildAndPaint(lines, width, null, tables);

    // Back buffer should have damage from paint
    expect(isDamaged(back)).toBe(true);
    // Damage should cover the full content
    expect(back.damageBox!.maxRow).toBeGreaterThanOrEqual(front.height - 1);
  });

  it('viewport diff for large burst produces output smaller than full serialize', () => {
    const tables = makeTables();
    const width = 40;
    const viewportRows = 10;

    const { buf: front } = buildAndPaint(
      ['Header', 'Short', 'A', 'B', 'C'],
      width,
      null,
      tables,
    );

    const lines: string[] = ['Header'];
    for (let i = 1; i <= 79; i++) lines.push(`Line ${i}`);
    const { buf: back } = buildAndPaint(lines, width, null, tables);

    // Diff the viewport slice
    const backStart = Math.max(0, back.height - viewportRows);
    const frontStart = Math.max(0, front.height - viewportRows);
    const backVp = viewportSlice(back, backStart, viewportRows);
    const frontVp = viewportSlice(front, frontStart, viewportRows);
    const diffCursor = new InlineCursor(0, 0, backVp.width);
    diffBuffers(frontVp, backVp, tables.st, tables.ct, tables.lt, false, diffCursor);
    const patch = diffCursor.output;

    // Full serialize for comparison
    const fullCursor = new InlineCursor(0, 0, back.width);
    serializeAll(back, tables.st, tables.ct, tables.lt, false, fullCursor);
    const fullBackSize = fullCursor.output.length;
    expect(patch.length).toBeLessThanOrEqual(fullBackSize);
  });
});
