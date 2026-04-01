/**
 * Streaming simulation: appends one word per frame for 300 frames through the
 * real React reconciler. Reports per-phase medians to detect degradation.
 */
import React, { useState, useLayoutEffect } from 'react';
import { Box, Text } from '../../src/components/elements.js';
import { mountRoot } from '../../src/core/reconciler.js';
import { layout, contentHeight } from '../../src/core/layout.js';
import { rasterize } from '../../src/core/rasterizer.js';
import { diff, extractViewport, lastContentRow } from '../../src/core/diff.js';
import type { TNode } from '../../src/core/nodes.js';
import type { CellGrid } from '../../src/core/cell.js';
import { performance } from 'node:perf_hooks';
import {
  getMessageBody,
  getRole,
  headerText,
  inputLineText,
  STREAM_WORDS,
} from '../content.js';
import { computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const STREAM_FRAMES = 300;
const MESSAGE_COUNTS = [10, 50, 100, 250, 500];

let globalSetStreamText: ((fn: (s: string) => string) => void) | null = null;

function ChatUI({
  messageCount,
  counter,
  streamingText,
}: {
  messageCount: number;
  counter: number;
  streamingText?: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(messageCount)}
      </Text>
      {Array.from({ length: messageCount }, (_, i) => {
        const { role, isUser } = getRole(i);
        let body = getMessageBody(i);
        if (streamingText !== undefined && i === messageCount - 1 && !isUser) {
          body = body + ' ' + streamingText;
        }
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

function StreamingApp({ messageCount }: { messageCount: number }) {
  const [streamText, setStreamText] = useState('');

  useLayoutEffect(() => {
    globalSetStreamText = setStreamText;
    return () => { globalSetStreamText = null; };
  }, []);

  return (
    <ChatUI messageCount={messageCount} counter={0} streamingText={streamText} />
  );
}

function runPipeline(root: TNode, prevGrid: CellGrid): { viewportGrid: CellGrid; output: string; isGrowth: boolean } {
  layout(root, COLS, ROWS);
  const ch = contentHeight(root);
  const fullGrid = rasterize(root, COLS, Math.max(ch + 10, ROWS), 0);
  const actualHeight = lastContentRow(fullGrid) + 1;
  const scrollback = Math.max(0, actualHeight - ROWS);
  const viewportGrid = extractViewport(fullGrid, scrollback, ROWS);
  const result = diff(prevGrid, viewportGrid, 0, 0);
  // Approximate growth detection: diff returns full redraw when grids differ in size
  const isGrowth = result.output.length > 500; // heuristic
  return { viewportGrid, output: result.output, isGrowth };
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

export async function runStreamingSimulation(): Promise<void> {
  const tableRows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    latestRoot = null;
    rootResolve = null;
    globalSetStreamText = null;

    mountRoot(<StreamingApp messageCount={msgCount} />, onFrame);

    let root = await waitForCommit();

    // Wait for setter to be available
    if (!globalSetStreamText) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    if (!globalSetStreamText) {
      console.error(`Streaming: setter not ready for ${msgCount} messages`);
      continue;
    }

    // Initial pipeline to get first viewport
    layout(root, COLS, ROWS);
    const ch0 = contentHeight(root);
    const fg0 = rasterize(root, COLS, Math.max(ch0 + 10, ROWS), 0);
    const ah0 = lastContentRow(fg0) + 1;
    const sb0 = Math.max(0, ah0 - ROWS);
    let prevGrid: CellGrid = extractViewport(fg0, sb0, ROWS);

    // Warmup (15 frames)
    for (let i = 0; i < 15; i++) {
      latestRoot = null;
      globalSetStreamText!((prev) => {
        const idx = prev ? prev.split(' ').length : 0;
        const word = STREAM_WORDS[idx % STREAM_WORDS.length]!;
        return prev ? prev + ' ' + word : word;
      });
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { viewportGrid } = runPipeline(root, prevGrid);
      prevGrid = viewportGrid;
    }

    // Measurement: 300 streaming frames
    const latencies: number[] = [];
    const bytesPerFrame: number[] = [];
    let growthFrames = 0;

    for (let i = 0; i < STREAM_FRAMES; i++) {
      latestRoot = null;

      const t0 = performance.now();
      globalSetStreamText!((prev) => {
        const idx = prev ? prev.split(' ').length : 0;
        const word = STREAM_WORDS[idx % STREAM_WORDS.length]!;
        return prev ? prev + ' ' + word : word;
      });
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();

      const { viewportGrid, output, isGrowth } = runPipeline(root, prevGrid);
      const t1 = performance.now();

      prevGrid = viewportGrid;
      latencies.push(t1 - t0);
      bytesPerFrame.push(output.length);
      if (isGrowth) growthFrames++;
    }

    globalSetStreamText = null;

    const allStats = computeStats(latencies);
    const phase1 = computeStats(latencies.slice(0, 100));
    const phase2 = computeStats(latencies.slice(100, 200));
    const phase3 = computeStats(latencies.slice(200, 300));
    const avgBytes = bytesPerFrame.reduce((s, b) => s + b, 0) / bytesPerFrame.length;

    tableRows.push([
      String(msgCount),
      fmtMs(allStats.median),
      fmtMs(allStats.p95),
      fmtMs(allStats.p99),
      fmtMs(phase1.median),
      fmtMs(phase2.median),
      fmtMs(phase3.median),
      `${growthFrames}/${STREAM_FRAMES}`,
      `${Math.round(avgBytes)}`,
    ]);
  }

  printTable(
    `Streaming Simulation — ${STREAM_FRAMES} words appended per message count`,
    ['Messages', 'Median', 'P95', 'P99', '1-100', '101-200', '201-300', 'Growth/Total', 'Avg bytes'],
    tableRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('streaming-simulation.tsx')) {
  runStreamingSimulation();
}
