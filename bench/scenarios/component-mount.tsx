/**
 * Component mount benchmark: adding 10 messages in one update. Exercises
 * reconciler, layout, and diff. Compares against no-change pipeline cost.
 */
import React, { useState, useLayoutEffect } from 'react';
import { performance } from 'node:perf_hooks';
import { Box, Text } from '../../src/components/elements.js';
import { mountRoot } from '../../src/core/reconciler.js';
import { layout, contentHeight } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { diff, extractViewport, lastContentRow } from '../../src/core/diff.js';
import type { TNode } from '../../src/core/nodes.js';
import type { CellGrid } from '../../src/core/cell.js';
import {
  getMessageBody,
  getRole,
  headerText,
  inputLineText,
} from '../content.js';
import { computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const MOUNT_BATCH = 10;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500];
const ITERATIONS = 100;
const WARMUP = 15;

let globalSetMsgCount: ((fn: (c: number) => number) => void) | null = null;

function ChatUI({ messageCount, counter }: { messageCount: number; counter: number }) {
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
      <Text>{inputLineText(counter)}</Text>
    </Box>
  );
}

function MountApp({ startCount }: { startCount: number }) {
  const [msgCount, setMsgCount] = useState(startCount);

  useLayoutEffect(() => {
    globalSetMsgCount = setMsgCount;
    return () => { globalSetMsgCount = null; };
  }, []);

  return <ChatUI messageCount={msgCount} counter={0} />;
}

function runPipeline(root: TNode, prevGrid: CellGrid): { viewportGrid: CellGrid; output: string } {
  layout(root, COLS, ROWS);
  const ch = contentHeight(root);
  const fullGrid = rasterize(root, COLS, Math.max(ch + 10, ROWS), 0);
  const actualHeight = lastContentRow(fullGrid) + 1;
  const scrollback = Math.max(0, actualHeight - ROWS);
  const viewportGrid = extractViewport(fullGrid, scrollback, ROWS);
  const result = diff(prevGrid, viewportGrid, 0, 0);
  return { viewportGrid, output: result.output };
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

export async function runComponentMount(): Promise<void> {
  const tableRows: string[][] = [];

  for (const startCount of MESSAGE_COUNTS) {
    latestRoot = null;
    rootResolve = null;
    globalSetMsgCount = null;

    mountRoot(<MountApp startCount={startCount} />, onFrame);

    let root = await waitForCommit();

    // Wait for setter to be available
    if (!globalSetMsgCount) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    if (!globalSetMsgCount) {
      console.error(`Mount: setter not ready for ${startCount} messages`);
      continue;
    }

    // Initial pipeline
    layout(root, COLS, ROWS);
    const ch0 = contentHeight(root);
    const fg0 = rasterize(root, COLS, Math.max(ch0 + 10, ROWS), 0);
    const ah0 = lastContentRow(fg0) + 1;
    const sb0 = Math.max(0, ah0 - ROWS);
    let prevGrid: CellGrid = extractViewport(fg0, sb0, ROWS);

    // Measure mount: add MOUNT_BATCH messages in one setState
    const mountLatencies: number[] = [];
    const mountBytes: number[] = [];

    // Also measure single-cell update at the final size for comparison
    const updateLatencies: number[] = [];

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      latestRoot = null;
      // Toggle between startCount and startCount+MOUNT_BATCH
      const targetCount = i % 2 === 0 ? startCount + MOUNT_BATCH : startCount;
      globalSetMsgCount!(() => targetCount);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { viewportGrid } = runPipeline(root, prevGrid);
      prevGrid = viewportGrid;
    }

    // Ensure we're at startCount before measurements
    latestRoot = null;
    globalSetMsgCount!(() => startCount);
    await new Promise<void>((r) => queueMicrotask(r));
    root = await waitForCommit();
    const { viewportGrid: resetGrid } = runPipeline(root, prevGrid);
    prevGrid = resetGrid;

    for (let i = 0; i < ITERATIONS; i++) {
      // Mount: startCount → startCount + MOUNT_BATCH
      latestRoot = null;
      const t0 = performance.now();
      globalSetMsgCount!(() => startCount + MOUNT_BATCH);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { viewportGrid: mountVP, output: mountOutput } = runPipeline(root, prevGrid);
      const t1 = performance.now();

      mountLatencies.push(t1 - t0);
      mountBytes.push(mountOutput.length);
      prevGrid = mountVP;

      // Reset back to startCount for next iteration
      latestRoot = null;
      globalSetMsgCount!(() => startCount);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { viewportGrid: resetVP2 } = runPipeline(root, prevGrid);
      prevGrid = resetVP2;
    }

    // Measure single-cell update at startCount + MOUNT_BATCH
    latestRoot = null;
    globalSetMsgCount!(() => startCount + MOUNT_BATCH);
    await new Promise<void>((r) => queueMicrotask(r));
    root = await waitForCommit();
    const { viewportGrid: finalVP } = runPipeline(root, prevGrid);
    prevGrid = finalVP;

    // Use a counter-based ChatUI for single-cell updates — since MountApp doesn't
    // have a counter, we just re-run the pipeline without state changes to measure
    // the pipeline cost at the final size
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      // Re-run pipeline on same root (no state change = no React overhead, just pipeline)
      layout(root, COLS, ROWS);
      const ch = contentHeight(root);
      const fg = rasterize(root, COLS, Math.max(ch + 10, ROWS), 0);
      const ah = lastContentRow(fg) + 1;
      const sb = Math.max(0, ah - ROWS);
      const vp = extractViewport(fg, sb, ROWS);
      diff(prevGrid, vp, 0, 0);
      const t1 = performance.now();
      updateLatencies.push(t1 - t0);
    }

    globalSetMsgCount = null;

    const mountStats = computeStats(mountLatencies);
    const updateStats = computeStats(updateLatencies);
    const avgMountBytes = mountBytes.reduce((s, b) => s + b, 0) / mountBytes.length;

    tableRows.push([
      `${startCount}→${startCount + MOUNT_BATCH}`,
      fmtMs(mountStats.median),
      fmtMs(mountStats.p95),
      fmtMs(updateStats.median),
      `${(mountStats.median / updateStats.median).toFixed(1)}x`,
      `${Math.round(avgMountBytes)}`,
    ]);
  }

  printTable(
    `Component Mount — adding ${MOUNT_BATCH} messages in one update`,
    ['Messages', 'Mount median', 'Mount P95', 'Update median', 'Mount/Update', 'Mount bytes'],
    tableRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('component-mount.tsx')) {
  runComponentMount();
}
