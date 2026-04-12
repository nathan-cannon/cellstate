/**
 * Streaming simulation: appends one word per frame for 300 frames through the
 * real React reconciler. Reports per-phase medians to detect degradation.
 */
import React, { useState, useLayoutEffect } from 'react';
import { Box, Text } from '../../src/components/elements.js';
import { Markdown, StreamingMarkdown } from '../../src/components/markdown.js';
import { mountRoot, setFlexNodeFactory } from '../../src/core/reconciler.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { paintTree } from '../../src/core/paint.js';
import { createCellBuffer, lastNonBlankRow, type CellBuffer } from '../../src/core/cell-buffer.js';
import { diffBuffers, InlineCursor } from '../../src/core/emit.js';
import { viewportSlice } from '../../src/core/cell-buffer.js';
const expandDamageForShrink = (_a: CellBuffer, _b: CellBuffer): void => {};
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import { createPerf } from '../../src/core/perf.js';
import type { TNode } from '../../src/core/nodes.js';
import { performance } from 'node:perf_hooks';
import {
  getMessageBody,
  getRole,
  headerText,
  inputLineText,
  STREAM_WORDS,
  MARKDOWN_MESSAGES,
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
  perf?: import('../../src/core/perf.js').Perf,
): { backBuf: CellBuffer; output: string } {
  doLayout(root);
  const ch = root.flexNode!.getComputedHeight();
  const bufHeight = Math.max(ch, ROWS);
  const backBuf = createCellBuffer(COLS, bufHeight);
  paintTree(root, backBuf, frontBuf, charTable, styleTable, linkTable, 0, perf);
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

export async function runStreamingSimulation(): Promise<void> {
  const tableRows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    latestRoot = null;
    rootResolve = null;
    globalSetStreamText = null;

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    setFlexNodeFactory(createFlexNodeFactory());
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

    // Initial pipeline to get first buffer
    doLayout(root);
    const ch0 = root.flexNode!.getComputedHeight();
    let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
    paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

    // Track word index outside setState to avoid O(n) string parsing per frame
    let wordIndex = 0;

    // Warmup (15 frames)
    for (let i = 0; i < 15; i++) {
      latestRoot = null;
      const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
      wordIndex++;
      globalSetStreamText!((prev) => prev ? prev + ' ' + word : word);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = backBuf;
    }

    // Measurement: 300 streaming frames with reconciler/pipeline split
    const reconcilerLatencies: number[] = [];
    const pipelineLatencies: number[] = [];
    const totalLatencies: number[] = [];
    const bytesPerFrame: number[] = [];

    for (let i = 0; i < STREAM_FRAMES; i++) {
      latestRoot = null;

      const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
      wordIndex++;

      // Phase 1: React reconciliation
      const t0 = performance.now();
      globalSetStreamText!((prev) => prev ? prev + ' ' + word : word);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const t1 = performance.now();

      // Phase 2: Render pipeline
      const { backBuf, output } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      const t2 = performance.now();

      frontBuf = backBuf;
      reconcilerLatencies.push(t1 - t0);
      pipelineLatencies.push(t2 - t1);
      totalLatencies.push(t2 - t0);
      bytesPerFrame.push(output.length);
    }

    globalSetStreamText = null;

    const allStats = computeStats(totalLatencies);
    const reconcilerStats = computeStats(reconcilerLatencies);
    const pipelineStats = computeStats(pipelineLatencies);
    const phase1 = computeStats(totalLatencies.slice(0, 100));
    const phase2 = computeStats(totalLatencies.slice(100, 200));
    const phase3 = computeStats(totalLatencies.slice(200, 300));
    const avgBytes = bytesPerFrame.reduce((s, b) => s + b, 0) / bytesPerFrame.length;

    tableRows.push([
      String(msgCount),
      fmtMs(allStats.median),
      fmtMs(reconcilerStats.median),
      fmtMs(pipelineStats.median),
      fmtMs(allStats.p95),
      fmtMs(allStats.p99),
      fmtMs(phase1.median),
      fmtMs(phase2.median),
      fmtMs(phase3.median),
      `${Math.round(avgBytes)}`,
    ]);
  }

  printTable(
    `Streaming Simulation — ${STREAM_FRAMES} words appended per message count`,
    ['Messages', 'Total', 'Reconciler', 'Pipeline', 'P95', 'P99', '1-100', '101-200', '201-300', 'Avg bytes'],
    tableRows,
  );
}

// ── Markdown streaming variant ──

let globalSetMdStreamText: ((fn: (s: string) => string) => void) | null = null;

function MarkdownChatUI({
  messageCount,
  streamingText,
}: {
  messageCount: number;
  streamingText: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(messageCount)}
      </Text>
      {Array.from({ length: messageCount }, (_, i) => {
        const { role, isUser } = getRole(i);
        if (isUser) {
          return (
            <Box key={i} flexDirection="column">
              <Text bold fg="#00cc66">{role}</Text>
              <Text>{getMessageBody(i)}</Text>
            </Box>
          );
        }
        const mdIndex = Math.floor(i / 2) % MARKDOWN_MESSAGES.length;
        const baseMarkdown = MARKDOWN_MESSAGES[mdIndex]!;
        const isLast = i === messageCount - 1;
        if (isLast && streamingText) {
          return (
            <Box key={i} flexDirection="column">
              <Text bold fg="#cc66ff">{role}</Text>
              <StreamingMarkdown>{baseMarkdown + '\n\n' + streamingText}</StreamingMarkdown>
            </Box>
          );
        }
        return (
          <Box key={i} flexDirection="column">
            <Text bold fg="#cc66ff">{role}</Text>
            <Markdown>{baseMarkdown}</Markdown>
          </Box>
        );
      })}
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

function MarkdownStreamingApp({ messageCount }: { messageCount: number }) {
  const [streamText, setStreamText] = useState('');

  useLayoutEffect(() => {
    globalSetMdStreamText = setStreamText;
    return () => { globalSetMdStreamText = null; };
  }, []);

  return (
    <MarkdownChatUI messageCount={messageCount} streamingText={streamText} />
  );
}

export async function runMarkdownStreamingSimulation(): Promise<void> {
  const tableRows: string[][] = [];
  const MD_MESSAGE_COUNTS = [10, 50, 100, 250];

  for (const msgCount of MD_MESSAGE_COUNTS) {
    latestRoot = null;
    rootResolve = null;
    globalSetMdStreamText = null;

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(<MarkdownStreamingApp messageCount={msgCount} />, onFrame);

    let root = await waitForCommit();

    if (!globalSetMdStreamText) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    if (!globalSetMdStreamText) {
      console.error(`Markdown streaming: setter not ready for ${msgCount} messages`);
      continue;
    }

    // Initial pipeline
    doLayout(root);
    const ch0 = root.flexNode!.getComputedHeight();
    let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
    paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

    let wordIndex = 0;

    // Warmup
    for (let i = 0; i < 15; i++) {
      latestRoot = null;
      const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
      wordIndex++;
      globalSetMdStreamText!((prev) => prev ? prev + ' ' + word : word);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = backBuf;
    }

    // Measurement
    const latencies: number[] = [];
    const bytesPerFrame: number[] = [];
    let totalWalkNodeRawAnsi = 0;
    let totalWalkNodeText = 0;

    for (let i = 0; i < STREAM_FRAMES; i++) {
      latestRoot = null;
      const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
      wordIndex++;
      const framePerf = createPerf(true);
      const t0 = performance.now();
      globalSetMdStreamText!((prev) => prev ? prev + ' ' + word : word);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf, output } = runPipeline(root, frontBuf, charTable, styleTable, linkTable, framePerf);
      const t1 = performance.now();

      const snap = framePerf.snapshot()!;
      totalWalkNodeRawAnsi += snap.counts.walkNodeRawAnsi;
      totalWalkNodeText += snap.counts.walkNodeText;

      frontBuf = backBuf;
      latencies.push(t1 - t0);
      bytesPerFrame.push(output.length);
    }

    globalSetMdStreamText = null;

    console.log(
      `  [${msgCount} msgs] walkNodeRawAnsi: ${totalWalkNodeRawAnsi}, ` +
      `walkNodeText: ${totalWalkNodeText}` +
      (totalWalkNodeText > 0 ? ' ⚠ TEXT FALLBACK DETECTED' : ''),
    );

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
      `${Math.round(avgBytes)}`,
    ]);
  }

  printTable(
    `Streaming Simulation (Markdown) — ${STREAM_FRAMES} words appended per message count`,
    ['Messages', 'Median', 'P95', 'P99', '1-100', '101-200', '201-300', 'Avg bytes'],
    tableRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('streaming-simulation.tsx')) {
  runStreamingSimulation();
}
