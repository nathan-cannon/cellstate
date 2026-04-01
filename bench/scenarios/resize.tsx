/**
 * Resize benchmark: worst-case operation (full re-layout + rasterize + redraw).
 * Simulates 120x40 to 80x24 at various content sizes.
 */
import React, { useState, useLayoutEffect } from 'react';
import { performance } from 'node:perf_hooks';
import { Box, Text } from '../../src/components/elements.js';
import { mountRoot } from '../../src/core/reconciler.js';
import { layout, contentHeight } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { fullRedraw, extractViewport, lastContentRow } from '../../src/core/diff.js';
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
 * Simulate a resize frame: clearLayout → full re-layout at new dimensions →
 * full rasterize → full redraw. This is the maximum-cost operation.
 */
function simulateResizeFrame(root: TNode, cols: number, rows: number): { output: string } {
  layout(root, cols, rows);
  const ch = contentHeight(root);
  const fullGrid = rasterize(root, cols, Math.max(ch + 10, rows), 0);
  const actualHeight = lastContentRow(fullGrid) + 1;
  const scrollback = Math.max(0, actualHeight - rows);
  const viewportGrid = extractViewport(fullGrid, scrollback, rows);
  const result = fullRedraw(viewportGrid, 0);
  return { output: result.output };
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

    mountRoot(<ChatUI messageCount={msgCount} />, onFrame);
    const root = await waitForCommit();

    // Initial frame at original dimensions
    simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS);

    // Warmup resize cycles
    for (let i = 0; i < WARMUP; i++) {
      simulateResizeFrame(root, RESIZE_COLS, RESIZE_ROWS);
      simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS);
    }

    // Measure resize from 120×40 → 80×24
    const resizeLatencies: number[] = [];
    const resizeBytes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      // Reset to original dimensions
      simulateResizeFrame(root, INITIAL_COLS, INITIAL_ROWS);

      const t0 = performance.now();
      const { output } = simulateResizeFrame(root, RESIZE_COLS, RESIZE_ROWS);
      const t1 = performance.now();

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
