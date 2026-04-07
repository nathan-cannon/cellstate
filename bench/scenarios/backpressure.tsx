/**
 * Backpressure simulation: measures frame-to-frame latency under simulated
 * stdout backpressure. Exercises the isFlushing / drain / setImmediate
 * scheduling path in the frame loop.
 */
import React, { useState, useLayoutEffect } from 'react';
import { Box, Text } from '../../src/components/elements.js';
import { createFrameLoop } from '../../src/core/frame-loop.js';
import { MockStdout, type FrameRecord } from '../mock-stream.js';
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
const STREAM_FRAMES = 200;
const MESSAGE_COUNTS = [50, 100, 250];
const DEFAULT_BACKPRESSURE_RATE = 5; // every Nth frame
const DEFAULT_DRAIN_DELAY_MS = 20;

/**
 * MockStdout subclass that simulates backpressure by returning false from
 * write() every N frames, then emitting 'drain' after a configurable delay.
 */
class BackpressureMockStdout extends MockStdout {
  private _writeCount = 0;
  private _backpressureRate: number;
  private _drainDelayMs: number;
  drainWaits = 0;

  constructor(cols: number, rows: number, rate: number, drainDelay: number) {
    super(cols, rows);
    this._backpressureRate = rate;
    this._drainDelayMs = drainDelay;
  }

  override write(chunk: string | Buffer, ...args: unknown[]): boolean {
    this._writeCount++;
    // Call parent write to record the frame
    const result = super.write(chunk, ...args);

    // Simulate backpressure on every Nth write
    if (this._writeCount % this._backpressureRate === 0) {
      this.drainWaits++;
      setTimeout(() => {
        this.emit('drain');
      }, this._drainDelayMs);
      return false;
    }
    return result;
  }
}

let globalSetStreamText: ((fn: (s: string) => string) => void) | null = null;

function StreamingApp({
  messageCount,
}: {
  messageCount: number;
}) {
  const [streamText, setStreamText] = useState('');

  useLayoutEffect(() => {
    globalSetStreamText = setStreamText;
    return () => { globalSetStreamText = null; };
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold fg="#5599ff">
        {headerText(messageCount)}
      </Text>
      {Array.from({ length: messageCount }, (_, i) => {
        const { role, isUser } = getRole(i);
        let body = getMessageBody(i);
        if (streamText && i === messageCount - 1 && !isUser) {
          body = body + ' ' + streamText;
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
      <Text>{inputLineText(0)}</Text>
    </Box>
  );
}

async function runWithStdout(
  msgCount: number,
  stdout: MockStdout,
): Promise<{
  latencies: number[];
  deferredFrames: number;
  maxConsecutiveDeferred: number;
}> {
  globalSetStreamText = null;

  const loop = createFrameLoop(stdout as unknown as NodeJS.WriteStream, { immediateMode: true });
  loop.start(<StreamingApp messageCount={msgCount} />);

  // Wait for initial render
  await stdout.nextFrameTimeout(500);

  // Wait for setter
  if (!globalSetStreamText) {
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  if (!globalSetStreamText) {
    throw new Error(`Backpressure: setter not ready for ${msgCount} messages`);
  }

  let wordIndex = 0;

  // Warmup
  for (let i = 0; i < 15; i++) {
    const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
    wordIndex++;
    globalSetStreamText!((prev) => prev ? prev + ' ' + word : word);
    await stdout.nextFrameTimeout(100);
  }

  stdout.resetFrames();

  // Measurement
  const latencies: number[] = [];
  let deferredFrames = 0;
  let consecutiveDeferred = 0;
  let maxConsecutiveDeferred = 0;

  for (let i = 0; i < STREAM_FRAMES; i++) {
    const word = STREAM_WORDS[wordIndex % STREAM_WORDS.length]!;
    wordIndex++;

    const t0 = performance.now();
    globalSetStreamText!((prev) => prev ? prev + ' ' + word : word);

    const frame = await stdout.nextFrameTimeout(200);
    const t1 = performance.now();

    if (frame) {
      latencies.push(t1 - t0);
      consecutiveDeferred = 0;
    } else {
      // Frame was deferred/dropped (timed out)
      deferredFrames++;
      consecutiveDeferred++;
      maxConsecutiveDeferred = Math.max(maxConsecutiveDeferred, consecutiveDeferred);
      latencies.push(t1 - t0);
    }
  }

  // Don't call loop.stop() — it writes to fd 1 via writeFileSync, which
  // clears the real terminal and destroys output from earlier benchmarks.
  // Instead, manually clean up listeners and let the frame loop be GC'd.
  stdout.removeAllListeners('drain');
  stdout.removeAllListeners('resize');
  globalSetStreamText = null;

  return { latencies, deferredFrames, maxConsecutiveDeferred };
}

export async function runBackpressure(): Promise<void> {
  const tableRows: string[][] = [];

  for (const msgCount of MESSAGE_COUNTS) {
    // Control: no backpressure
    const controlStdout = new MockStdout(COLS, ROWS);
    const control = await runWithStdout(msgCount, controlStdout);
    const controlStats = computeStats(control.latencies);

    // Backpressure: every 5th frame returns false, drain after 1ms
    const bpStdout = new BackpressureMockStdout(
      COLS, ROWS, DEFAULT_BACKPRESSURE_RATE, DEFAULT_DRAIN_DELAY_MS,
    );
    const bp = await runWithStdout(msgCount, bpStdout);
    const bpStats = computeStats(bp.latencies);

    tableRows.push([
      String(msgCount),
      fmtMs(controlStats.median),
      fmtMs(controlStats.p95),
      fmtMs(controlStats.p99),
      fmtMs(bpStats.median),
      fmtMs(bpStats.p95),
      fmtMs(bpStats.p99),
      String(bp.deferredFrames),
      String(bp.maxConsecutiveDeferred),
    ]);
  }

  printTable(
    `Backpressure — ${STREAM_FRAMES} frames, backpressure every ${DEFAULT_BACKPRESSURE_RATE}th frame (${DEFAULT_DRAIN_DELAY_MS}ms drain)`,
    [
      'Messages',
      'Ctrl med', 'Ctrl P95', 'Ctrl P99',
      'BP med', 'BP P95', 'BP P99',
      'Deferred', 'Max consec',
    ],
    tableRows,
  );
}

// Allow running standalone
if (process.argv[1]?.endsWith('backpressure.tsx')) {
  runBackpressure();
}
