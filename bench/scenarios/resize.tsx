/**
 * Resize benchmark: worst-case operation (full re-layout + paint + full-redraw).
 * Simulates 120x40 to 80x24 at various content sizes.
 */
import React from 'react';
import { performance } from 'node:perf_hooks';
import { Box, Text } from '../../src/components/elements.js';
import { mountRoot, setFlexNodeFactory } from '../../src/core/reconciler.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { paintTree } from '../../src/core/paint.js';
import { createCellBuffer, viewportSlice, type CellBuffer } from '../../src/core/cell-buffer.js';
import { serializeAll } from '../../src/core/emit.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import type { TNode } from '../../src/core/nodes.js';
import {
  getMessageBody,
  getRole,
  headerText,
  inputLineText,
} from '../content.js';
import { computeStats, fmtMs, printTable } from '../harness.js';

const INITIAL_COLS = 120;
const INITIAL_ROWS = 40;
const RESIZE_COLS = 80;
const RESIZE_ROWS = 24;
const MESSAGE_COUNTS = [50, 100, 250, 500, 1000];
const ITERATIONS = 100;
const WARMUP = 15;

function ChatUI({ messageCount }: { messageCount: number }) {
  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(messageCount)}
      </Text>
      {Array.from({ length: messageCount }, (_, i) => {
        const { role, isUser } = getRole(i);
        const body = getMessageBody(i);
        return (
          <Box key={i} flexDirection="column">
            <Text bold fg={isUser ? '#00cc66' : '#cc66ff'}>
              {role}
            </Text>
            <Text>{body}</Text>
          </Box>
        );
      })}
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

/**
 * Simulate a resize frame: full re-layout at new dimensions →
 * paintTree → full-redraw emit.
 *
 * Resize changes dimensions, so paintTree detects movement during its walk
 * and won't blit anything. We still pass the front buffer for API correctness
 * and return the painted buffer.
 */
function simulateResizeFrame(
  root: TNode,
  cols: number,
  rows: number,
  frontBuf: CellBuffer | null,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
): { backBuf: CellBuffer; output: string } {
  root.flexNode!.setWidth(cols);
  root.flexNode!.calculateLayout(cols);
  const ch = root.flexNode!.getComputedHeight();
  const bufHeight = Math.max(ch, rows);
  const backBuf = createCellBuffer(cols, bufHeight);
  paintTree(root, backBuf, frontBuf, charTable, styleTable, linkTable, 0);
  const backStart = Math.max(0, backBuf.height - rows);
  const backVp = viewportSlice(backBuf, backStart, rows);
  const result = serializeAll(backVp, styleTable, charTable, linkTable, false);
  return { backBuf, output: result.output };
}

let latestRoot: TNode | null = null;
let rootResolve: ((root: TNode) => void) | null = null;

function onFrame(root: TNode): void {
  latestRoot = root;
  if (rootResolve) {
    const resolve = rootResolve;
    rootResolve = null;
    resolve(root);
  }
}

function waitForCommit(): Promise<TNode> {
  if (latestRoot) {
    const root = latestRoot;
    latestRoot = null;
    return Promise.resolve(root);
  }
  return new Promise((resolve) => { rootResolve = resolve; });
}

export async function runResize(): Promise<void> {
  const tableRows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    latestRoot = null;
    rootResolve = null;

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(<ChatUI messageCount={msgCount} />, onFrame);
    const root = await waitForCommit();

    // Initial frame at original dimensions
    let { backBuf: frontBuf } = simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS, null, charTable, styleTable, linkTable);

    // Warmup resize cycles
    for (let i = 0; i < WARMUP; i++) {
      const r1 = simulateResizeFrame(root, RESIZE_COLS, RESIZE_ROWS, frontBuf, charTable, styleTable, linkTable);
      const r2 = simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS, r1.backBuf, charTable, styleTable, linkTable);
      frontBuf = r2.backBuf;
    }

    // Measure resize from 120×40 → 80×24
    const resizeLatencies: number[] = [];
    const resizeBytes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      // Reset to original dimensions
      const reset = simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS, frontBuf, charTable, styleTable, linkTable);

      const t0 = performance.now();
      const { backBuf, output } = simulateResizeFrame(root, RESIZE_COLS, RESIZE_ROWS, reset.backBuf, charTable, styleTable, linkTable);
      const t1 = performance.now();

      frontBuf = backBuf;
      resizeLatencies.push(t1 - t0);
      resizeBytes.push(output.length);
    }

    const stats = computeStats(resizeLatencies);
    const avgBytes = resizeBytes.reduce((s, b) => s + b, 0) / resizeBytes.length;

    tableRows.push([
      String(msgCount),
      fmtMs(stats.median),
      fmtMs(stats.p95),
      fmtMs(stats.p99),
      fmtMs(stats.min),
      fmtMs(stats.max),
      `${Math.round(avgBytes)}`,
    ]);
  }

  printTable(
    `Resize — ${INITIAL_COLS}×${INITIAL_ROWS} → ${RESIZE_COLS}×${RESIZE_ROWS}`,
    ['Messages', 'Median', 'P95', 'P99', 'Min', 'Max', 'Avg bytes'],
    tableRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('resize.tsx')) {
  runResize();
}
