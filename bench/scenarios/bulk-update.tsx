/**
 * Bulk update benchmark: measures non-streaming coding agent patterns —
 * large discrete updates rather than word-by-word streaming. Exercises the
 * "response just landed" frame that dominates latency for tools like
 * Claude Code, Copilot, Cursor, etc.
 *
 * Uses <Markdown> from src/components/markdown.tsx to render responses
 * through the tree-sitter → ANSI → raw-ansi pipeline. Falls back to
 * plain text wrapping if tree-sitter WASM is not initialized.
 */
import React, { useState, useLayoutEffect } from 'react';
import { performance } from 'node:perf_hooks';
import { Box, Text } from '../../src/components/elements.js';
import { markdownToElements } from '../../src/components/markdown.js';
import { mountRoot, setFlexNodeFactory } from '../../src/core/reconciler.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { paintTree } from '../../src/core/paint.js';
import { createCellBuffer, type CellBuffer } from '../../src/core/cell-buffer.js';
import { diffBuffers } from '../../src/core/emit.js';
import { viewportSlice, expandDamageForShrink } from '../../src/core/cell-buffer.js';
import { CharTable } from '../../src/core/char-table.js';
import { StyleTable } from '../../src/core/style-table.js';
import { LinkTable } from '../../src/core/link-table.js';
import type { TNode } from '../../src/core/nodes.js';
import {
  getMessageBody,
  getRole,
  headerText,
  inputLineText,
  generateCodeResponse,
  generateToolResult,
  TOOL_CALL_MESSAGES,
} from '../content.js';
import { computeStats, fmtMs, printTable } from '../harness.js';

const COLS = 120;
const ROWS = 40;
const ITERATIONS = 50;
const WARMUP = 10;

// ── Shared helpers ──

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
  const patch = diffBuffers(frontVp, backVp, styleTable, charTable, linkTable, false);
  return { backBuf, output: patch };
}

// ── Sub-benchmark 1: Bulk Insert — "Response landed" ──

let globalSetResponse: ((fn: (s: string | null) => string | null) => void) | null = null;

function BulkInsertApp({ messageCount }: { messageCount: number }) {
  const [response, setResponse] = useState<string | null>(null);

  useLayoutEffect(() => {
    globalSetResponse = setResponse;
    return () => { globalSetResponse = null; };
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(messageCount)}
      </Text>
      {Array.from({ length: messageCount }, (_, i) => {
        const { role, isUser } = getRole(i);
        return (
          <Box key={i} flexDirection="column">
            <Text bold fg={isUser ? '#00cc66' : '#cc66ff'}>{role}</Text>
            <Text>{getMessageBody(i)}</Text>
          </Box>
        );
      })}
      {response !== null && (
        <Box flexDirection="column">
          <Text bold fg="#cc66ff">assistant</Text>
          {markdownToElements(response)}
        </Box>
      )}
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

async function runBulkInsert(): Promise<void> {
  const tableRows: string[][] = [];
  const BULK_SIZES = [20, 50, 100, 200, 500];

  for (const lineCount of BULK_SIZES) {
    const mdContent = generateCodeResponse(lineCount);

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    latestRoot = null;
    rootResolve = null;
    globalSetResponse = null;

    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(<BulkInsertApp messageCount={3} />, onFrame);

    let root = await waitForCommit();

    if (!globalSetResponse) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    if (!globalSetResponse) {
      console.error(`Bulk insert: setter not ready for ${lineCount} lines`);
      continue;
    }

    // Initial pipeline
    doLayout(root);
    const ch0 = root.flexNode!.getComputedHeight();
    let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
    paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      latestRoot = null;
      globalSetResponse!(() => mdContent);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = backBuf;

      // Reset
      latestRoot = null;
      globalSetResponse!(() => null);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf;
    }

    // Measurement
    const reconcilerLatencies: number[] = [];
    const pipelineLatencies: number[] = [];
    const totalLatencies: number[] = [];
    const bytesPerFrame: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      latestRoot = null;

      const t0 = performance.now();
      globalSetResponse!(() => mdContent);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const t1 = performance.now();

      const { backBuf, output } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      const t2 = performance.now();

      reconcilerLatencies.push(t1 - t0);
      pipelineLatencies.push(t2 - t1);
      totalLatencies.push(t2 - t0);
      bytesPerFrame.push(output.length);
      frontBuf = backBuf;

      // Reset
      latestRoot = null;
      globalSetResponse!(() => null);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf;
    }

    globalSetResponse = null;

    const totalStats = computeStats(totalLatencies);
    const reconStats = computeStats(reconcilerLatencies);
    const pipeStats = computeStats(pipelineLatencies);
    const avgBytes = bytesPerFrame.reduce((s, b) => s + b, 0) / bytesPerFrame.length;

    tableRows.push([
      `${lineCount} lines`,
      fmtMs(totalStats.median),
      fmtMs(reconStats.median),
      fmtMs(pipeStats.median),
      fmtMs(totalStats.p95),
      fmtMs(totalStats.p99),
      `${Math.round(avgBytes)}`,
    ]);
  }

  printTable(
    'Bulk Insert — "Response landed" (full response in one setState)',
    ['Size', 'Total', 'Reconciler', 'Pipeline', 'P95', 'P99', 'Avg bytes'],
    tableRows,
  );
}

// ── Sub-benchmark 2: Sequential Bulk Updates — "Agent tool loop" ──

interface ToolMessage {
  role: 'tool-call' | 'tool-result';
  text: string;
}

let globalSetToolMessages: ((fn: (msgs: ToolMessage[]) => ToolMessage[]) => void) | null = null;

function ToolLoopApp() {
  const [toolMessages, setToolMessages] = useState<ToolMessage[]>([]);

  useLayoutEffect(() => {
    globalSetToolMessages = setToolMessages;
    return () => { globalSetToolMessages = null; };
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(5 + toolMessages.length)}
      </Text>
      {/* 5 prior conversation messages */}
      {Array.from({ length: 5 }, (_, i) => {
        const { role, isUser } = getRole(i);
        return (
          <Box key={`base-${i}`} flexDirection="column">
            <Text bold fg={isUser ? '#00cc66' : '#cc66ff'}>{role}</Text>
            <Text>{getMessageBody(i)}</Text>
          </Box>
        );
      })}
      {/* Tool call/result messages */}
      {toolMessages.map((msg, i) => (
        <Box key={`tool-${i}`} flexDirection="column">
          <Text bold fg={msg.role === 'tool-call' ? '#ffaa00' : '#888888'}>
            {msg.role === 'tool-call' ? 'tool' : 'result'}
          </Text>
          {msg.role === 'tool-call'
            ? <Text>{msg.text}</Text>
            : markdownToElements(`\`\`\`\n${msg.text}\n\`\`\``)
          }
        </Box>
      ))}
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

async function runToolLoop(): Promise<void> {
  const STEPS = 10;
  const TOOL_RESULT_LINES = 50;

  const charTable = new CharTable();
  const styleTable = new StyleTable();
  const linkTable = new LinkTable();

  latestRoot = null;
  rootResolve = null;
  globalSetToolMessages = null;

  setFlexNodeFactory(createFlexNodeFactory());
  mountRoot(<ToolLoopApp />, onFrame);

  let root = await waitForCommit();

  if (!globalSetToolMessages) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  if (!globalSetToolMessages) {
    console.error('Tool loop: setter not ready');
    return;
  }

  // Initial pipeline
  doLayout(root);
  const ch0 = root.flexNode!.getComputedHeight();
  let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
  paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

  const tableRows: string[][] = [];

  for (let step = 0; step < STEPS; step++) {
    const callText = TOOL_CALL_MESSAGES[step % TOOL_CALL_MESSAGES.length]!;
    const resultText = generateToolResult(TOOL_RESULT_LINES);

    // Add tool call
    latestRoot = null;
    const tc0 = performance.now();
    globalSetToolMessages!((prev) => [...prev, { role: 'tool-call' as const, text: callText }]);
    await new Promise<void>((r) => queueMicrotask(r));
    root = await waitForCommit();
    const tc1 = performance.now();
    const { backBuf: tcBuf, output: tcOutput } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
    const tc2 = performance.now();
    frontBuf = tcBuf;

    // Add tool result
    latestRoot = null;
    const tr0 = performance.now();
    globalSetToolMessages!((prev) => [...prev, { role: 'tool-result' as const, text: resultText }]);
    await new Promise<void>((r) => queueMicrotask(r));
    root = await waitForCommit();
    const tr1 = performance.now();
    const { backBuf: trBuf, output: trOutput } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
    const tr2 = performance.now();
    frontBuf = trBuf;

    const cumMessages = 5 + (step + 1) * 2;

    tableRows.push([
      String(step + 1),
      String(cumMessages),
      fmtMs(tc2 - tc0),
      fmtMs(tr2 - tr0),
      fmtMs(tc1 - tc0),
      fmtMs(tr1 - tr0),
      `${tcOutput.length}/${trOutput.length}`,
    ]);
  }

  globalSetToolMessages = null;

  printTable(
    `Sequential Bulk Updates — "Agent tool loop" (${STEPS} steps, ~${TOOL_RESULT_LINES} lines each)`,
    ['Step', 'Msgs', 'Call frame', 'Result frame', 'Call recon', 'Result recon', 'Bytes C/R'],
    tableRows,
  );
}

// ── Sub-benchmark 3: Large Code Block — "Show me the code" ──

let globalSetCodeResponse: ((fn: (s: string | null) => string | null) => void) | null = null;

function CodeBlockApp() {
  const [codeResponse, setCodeResponse] = useState<string | null>(null);

  useLayoutEffect(() => {
    globalSetCodeResponse = setCodeResponse;
    return () => { globalSetCodeResponse = null; };
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(codeResponse ? 4 : 3)}
      </Text>
      {Array.from({ length: 3 }, (_, i) => {
        const { role, isUser } = getRole(i);
        return (
          <Box key={i} flexDirection="column">
            <Text bold fg={isUser ? '#00cc66' : '#cc66ff'}>{role}</Text>
            <Text>{getMessageBody(i)}</Text>
          </Box>
        );
      })}
      {codeResponse !== null && (
        <Box flexDirection="column">
          <Text bold fg="#cc66ff">assistant</Text>
          {markdownToElements(codeResponse)}
        </Box>
      )}
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

async function runLargeCodeBlock(): Promise<void> {
  const tableRows: string[][] = [];
  const CODE_SIZES = [50, 100, 250, 500, 1000];

  for (const lineCount of CODE_SIZES) {
    const mdContent = generateCodeResponse(lineCount);

    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    latestRoot = null;
    rootResolve = null;
    globalSetCodeResponse = null;

    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(<CodeBlockApp />, onFrame);

    let root = await waitForCommit();

    if (!globalSetCodeResponse) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    if (!globalSetCodeResponse) {
      console.error(`Code block: setter not ready for ${lineCount} lines`);
      continue;
    }

    // Initial pipeline
    doLayout(root);
    const ch0 = root.flexNode!.getComputedHeight();
    let frontBuf = createCellBuffer(COLS, Math.max(ch0, ROWS));
    paintTree(root, frontBuf, null, charTable, styleTable, linkTable, 0);

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      latestRoot = null;
      globalSetCodeResponse!(() => mdContent);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = backBuf;

      latestRoot = null;
      globalSetCodeResponse!(() => null);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf;
    }

    // Measurement
    const totalLatencies: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      latestRoot = null;

      const t0 = performance.now();
      globalSetCodeResponse!(() => mdContent);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      const t1 = performance.now();

      totalLatencies.push(t1 - t0);
      frontBuf = backBuf;

      // Reset
      latestRoot = null;
      globalSetCodeResponse!(() => null);
      await new Promise<void>((r) => queueMicrotask(r));
      root = await waitForCommit();
      const { backBuf: resetBuf } = runPipeline(root, frontBuf, charTable, styleTable, linkTable);
      frontBuf = resetBuf;
    }

    globalSetCodeResponse = null;

    const stats = computeStats(totalLatencies);

    tableRows.push([
      `${lineCount} lines`,
      fmtMs(stats.median),
      fmtMs(stats.p95),
      fmtMs(stats.p99),
    ]);
  }

  printTable(
    'Large Code Block — "Show me the code" (single highlighted code response)',
    ['Size', 'Median', 'P95', 'P99'],
    tableRows,
  );
}

// ── Exported runner ──

export async function runBulkUpdate(): Promise<void> {
  await runBulkInsert();
  await runToolLoop();
  await runLargeCodeBlock();
}

// Allow running standalone
if (process.argv[1]?.endsWith('bulk-update.tsx')) {
  runBulkUpdate();
}
