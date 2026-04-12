/**
 * Component mount benchmark: adding 10 messages in one update. Exercises
 * reconciler, layout, and emit. Compares against no-change pipeline cost.
 */
import React, { useState, useLayoutEffect } from 'react';
import { performance } from 'node:perf_hooks';
import { Box, Text } from '../../src/components/elements.js';
import { mountRoot, setFlexNodeFactory } from '../../src/core/reconciler.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { paintTree } from '../../src/core/paint.js';
import { createCellBuffer, type CellBuffer } from '../../src/core/cell-buffer.js';
import { diffBuffers, InlineCursor } from '../../src/core/emit.js';
import { viewportSlice } from '../../src/core/cell-buffer.js';
const expandDamageForShrink = (_a: CellBuffer, _b: CellBuffer): void => {};
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

function doLayout(root: TNode): void {
  root.flexNode!.setWidth(COLS);
  root.flexNode!.calculateLayout(COLS);
}

function runPipeline(
  root: TNode,
  frontBuf: CellBuffer | null,
  charTable: CharTable,
  styleTable: StyleTable,
  linkTable: LinkTable,
): { backBuf: CellBuffer; output: string } {
  doLayout(root);
  const ch = root.flexNode!.getComputedHeight();
  const bufHeight = Math.max(ch, ROWS);
  const backBuf = createCellBuffer(COLS, bufHeight);
  paintTree(root, backBuf, frontBuf, charTable, styleTable, linkTable, 0);
  const emitFront = frontBuf ?? createCellBuffer(COLS, 1);
  expandDamageForShrink(emitFront, backBuf);
  const backStart = Math.max(0, backBuf.height - ROWS);
  const frontStart = Math.max(0, emitFront.height - ROWS);
  const backVp = viewportSlice(backBuf, backStart, ROWS);
  const frontVp = viewportSlice(emitFront, frontStart, ROWS);
  const cursor = new InlineCursor(0, 0, backVp.width);
  diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, false, cursor);
  return { backBuf, output: cursor.output };
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

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    setFlexNodeFactory(createFlexNodeFactory());
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
    doLayout(root);
    const ch0 = root.flexNode!.getComputedHeight();
    let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
    paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

    // Measure mount: add MOUNT_BATCH messages in one setState
    const mountLatencies: number[] = [];
    const mountBytes: number[] = [];

    // Also measure pipeline-only cost at the final size for comparison
    const updateLatencies: number[] = [];

    // Warmup: repeatedly mount startCount → startCount + MOUNT_BATCH to warm
    // caches and JIT, then settle back to startCount. This matches the real
    // measurement pattern (always mounting from the same baseline).
    for (let i = 0; i < WARMUP; i++) {
      // Mount
      latestRoot = null;
      globalSetMsgCount!(() => startCount + MOUNT_BATCH);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: mountBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = mountBuf;

      // Reset back to startCount
      latestRoot = null;
      globalSetMsgCount!(() => startCount);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf;
    }

    for (let i = 0; i < ITERATIONS; i++) {
      // Mount: startCount → startCount + MOUNT_BATCH
      latestRoot = null;
      const t0 = performance.now();
      globalSetMsgCount!(() => startCount + MOUNT_BATCH);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: mountBuf, output: mountOutput } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      const t1 = performance.now();

      mountLatencies.push(t1 - t0);
      mountBytes.push(mountOutput.length);
      frontBuf = mountBuf;

      // Reset back to startCount for next iteration
      latestRoot = null;
      globalSetMsgCount!(() => startCount);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf2 } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf2;
    }

    // Measure pipeline-only cost at startCount + MOUNT_BATCH (no React overhead)
    latestRoot = null;
    globalSetMsgCount!(() => startCount + MOUNT_BATCH);
    await new Promise<void>((r) => queueMicrotask(r));
    root = await waitForCommit();
    const { backBuf: finalBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
    frontBuf = finalBuf;

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      // Re-run pipeline on same root (no state change = no React overhead)
      doLayout(root);
      const ch = root.flexNode!.getComputedHeight();
      const buf = createCellBuffer(COLS, Math.max(ch, ROWS));
      paintTree(root, buf, frontBuf, charTable, styleTable, linkTable, 0);
      expandDamageForShrink(frontBuf, buf);
      const bStart = Math.max(0, buf.height - ROWS);
      const fStart = Math.max(0, frontBuf.height - ROWS);
      const bVp = viewportSlice(buf, bStart, ROWS);
      const fVp = viewportSlice(frontBuf, fStart, ROWS);
      const cursor2 = new InlineCursor(0, 0, bVp.width);
      diffBuffers(fVp, bVp, styleTable, charTable, linkTable, false, cursor2);
      frontBuf = buf;
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
