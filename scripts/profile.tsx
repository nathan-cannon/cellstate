/**
 * CellState render pipeline profiler.
 *
 * Runs controlled scenarios through the real render pipeline
 * (layout -> rasterize -> diff -> write) with perf instrumentation
 * enabled, then writes the snapshot to .perf/ as JSON.
 *
 * Usage:
 *   npx tsx scripts/profile.tsx <scenario>
 *   npx tsx scripts/profile.tsx --list
 *
 * Examples:
 *   npx tsx scripts/profile.tsx startup
 *   npx tsx scripts/profile.tsx streaming
 *   npx tsx scripts/profile.tsx wrapped-text
 *   npx tsx scripts/profile.tsx growth
 *   npx tsx scripts/profile.tsx status-churn
 *
 * Output: .perf/<scenario>-<timestamp>.json
 */

import React from 'react';
import { createFrameLoop, type FrameLoop } from '../src/core/frame-loop.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { createElement: h } = React;

// ── Null stdout ──────────────────────────────────────────────────
// Sinks all write output. Provides columns/rows and event-listener
// stubs so the frame loop operates normally without terminal I/O.

function createNullStdout(cols: number, rows: number) {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    columns: cols,
    rows: rows,
    write(_chunk: string | Buffer): boolean {
      return true; // no backpressure
    },
    on(event: string, fn: (...args: any[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: any[]) => void) {
      handlers.get(event)?.delete(fn);
    },
  } as unknown as NodeJS.WriteStream;
}

// ── Helpers ──────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function makeLine(n: number): string {
  return `Line ${String(n).padStart(4, '0')}: The quick brown fox jumps over the lazy dog.`;
}

function makeParagraph(charCount: number): string {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  let buf = '';
  while (buf.length < charCount) buf += sentence;
  return buf.slice(0, charCount);
}

// ── Scenario type ────────────────────────────────────────────────

interface ScenarioConfig {
  cols: number;
  rows: number;
  desc: string;
  run: (loop: FrameLoop) => Promise<void>;
}

// ── Scenarios ────────────────────────────────────────────────────

const scenarios: Record<string, ScenarioConfig> = {

  /**
   * startup — initial render of a moderate UI.
   * Measures: layout, rasterize, fullRedraw, createGrid.
   * The first frame is always a full redraw so this captures the
   * complete initial pipeline cost.
   */
  startup: {
    cols: 80,
    rows: 24,
    desc: 'Initial render of a moderate UI with boxes, borders, and text.',
    async run(loop) {
      const el = h('box', null,
        h('box', { borderStyle: 'round', paddingLeft: 1, paddingRight: 1 },
          h('text', { bold: true }, 'CellState Profiler'),
        ),
        h('text', null, ''),
        ...Array.from({ length: 8 }, (_, i) =>
          h('text', { key: i }, makeLine(i)),
        ),
        h('box', {
          borderStyle: 'single',
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
        },
          h('text', { color: 'green' }, 'Status: OK'),
        ),
      );

      // Initial render IS the workload. Perf captures from loop creation.
      loop.start(el);
      await sleep(100);
    },
  },

  /**
   * streaming — rapid line appending, simulating chat or log output.
   * Measures: diff efficiency, growth handling, extractViewport,
   * update vs growth frame ratio.
   * Resets perf after the initial render so only streaming work
   * is captured.
   */
  streaming: {
    cols: 80,
    rows: 24,
    desc: 'Append 200 lines one at a time, simulating streaming output.',
    async run(loop) {
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) lines.push(makeLine(i));

      const makeEl = () => h('box', null,
        ...lines.map((text, i) => h('text', { key: i }, text)),
      );

      loop.start(makeEl());
      await sleep(50);
      loop.perfReset(); // exclude initial render

      for (let i = 5; i < 205; i++) {
        lines.push(makeLine(i));
        loop.update(makeEl());
        await sleep(10);
      }
      await sleep(100); // drain final frames
    },
  },

  /**
   * wrapped-text — heavy wrapping workload.
   * Measures: wrapText, wrapSingleLine, stringDisplayWidth call volume,
   * layoutTextNode timing, wrappedLinesProduced.
   * Uses a tall viewport (100 rows) to avoid growth frames and
   * isolate wrapping cost.
   */
  'wrapped-text': {
    cols: 80,
    rows: 100,
    desc: 'Render and re-render a 5000-char paragraph requiring heavy wrapping.',
    async run(loop) {
      const text = makeParagraph(5000);
      loop.start(
        h('box', { paddingLeft: 2, paddingRight: 2 },
          h('text', null, text),
        ),
      );
      await sleep(100);

      // Update with a slightly longer paragraph to also measure diff
      // against a fully wrapped grid.
      const text2 = makeParagraph(5200);
      loop.update(
        h('box', { paddingLeft: 2, paddingRight: 2 },
          h('text', null, text2),
        ),
      );
      await sleep(100);
    },
  },

  /**
   * growth — deliberate viewport overflow.
   * Measures: growth frame count, extractViewport cost,
   * serializeRowRange work, scrollbackRows progression.
   * Starts below viewport height and grows past it.
   */
  growth: {
    cols: 80,
    rows: 24,
    desc: 'Grow content from 10 to 80 lines, triggering viewport growth frames.',
    async run(loop) {
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) lines.push(makeLine(i));

      const makeEl = () => h('box', null,
        ...lines.map((text, i) => h('text', { key: i }, text)),
      );

      loop.start(makeEl());
      await sleep(50);
      loop.perfReset(); // exclude initial render

      for (let i = 10; i < 80; i++) {
        lines.push(makeLine(i));
        loop.update(makeEl());
        await sleep(15);
      }
      await sleep(100);
    },
  },

  /**
   * status-churn — small localized updates in a mostly-static layout.
   * Measures: diff row-skip efficiency, minimal rasterize work per
   * frame, framesSkipped count (identical frames).
   * Most of the viewport is unchanged between frames.
   */
  'status-churn': {
    cols: 80,
    rows: 24,
    desc: 'Large static content with a rapidly changing status line.',
    async run(loop) {
      const staticLines = Array.from({ length: 20 }, (_, i) =>
        `Static line ${String(i).padStart(2, '0')}: ${makeParagraph(55).slice(0, 55)}`,
      );

      let statusText = 'Idle';

      const makeEl = () => h('box', null,
        ...staticLines.map((text, i) =>
          h('text', { key: `s${i}` }, text),
        ),
        h('box', { borderStyle: 'single', key: 'status' },
          h('text', { color: 'cyan' },
            `Status: ${statusText}`,
          ),
        ),
      );

      loop.start(makeEl());
      await sleep(50);
      loop.perfReset();

      for (let i = 0; i < 200; i++) {
        const filled = Math.floor(i / 10);
        const empty = 20 - filled;
        statusText = `Processing ${i + 1}/200 [${'#'.repeat(filled)}${'.'.repeat(empty)}]`;
        loop.update(makeEl());
        await sleep(10);
      }
      await sleep(100);
    },
  },
};

// ── Runner ───────────────────────────────────────────────────────

async function runScenario(name: string): Promise<void> {
  const config = scenarios[name];
  if (!config) {
    process.stderr.write(`Unknown scenario: ${name}\n`);
    process.stderr.write(`Available: ${Object.keys(scenarios).join(', ')}\n`);
    process.exit(1);
  }

  const stdout = createNullStdout(config.cols, config.rows);
  const loop = createFrameLoop(stdout, {
    perf: true,
    capabilities: { synchronizedOutput: false },
  });

  process.stderr.write(
    `Running scenario: ${name} (${config.cols}\u00d7${config.rows})\n`,
  );

  await config.run(loop);

  const snapshot = loop.perfSnapshot();
  if (!snapshot) {
    process.stderr.write('Error: perf snapshot is null\n');
    process.exit(1);
  }

  // Write output
  const outDir = join(process.cwd(), '.perf');
  mkdirSync(outDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${name}-${ts}.json`;
  const outPath = join(outDir, filename);

  const output = {
    scenario: name,
    description: config.desc,
    viewport: { cols: config.cols, rows: config.rows },
    snapshot,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2));
  process.stderr.write(`Wrote ${outPath}\n`);

  // Print a key-metrics summary
  const c = snapshot.counts;
  const t = snapshot.timings;
  process.stderr.write('\nKey metrics:\n');
  process.stderr.write(
    `  Frames: ${c.frames} (update=${c.framesUpdate} growth=${c.framesGrowth}` +
    ` full=${c.framesFullRedraw} skipped=${c.framesSkipped})\n`,
  );
  process.stderr.write(`  Bytes written: ${c.bytesWritten}\n`);
  process.stderr.write(
    `  Layout: ${t.layout.toFixed(2)}ms` +
    ` (wrapText=${t.wrapText.toFixed(2)}ms` +
    ` textNodes=${c.layoutTextNodes}` +
    ` lines=${c.wrappedLinesProduced})\n`,
  );
  process.stderr.write(
    `  Rasterize: ${t.rasterize.toFixed(2)}ms` +
    ` (cells=${c.cellsWritten} bg=${c.bgFillCells} border=${c.borderCells})\n`,
  );
  process.stderr.write(
    `  Diff: ${t.diff.toFixed(2)}ms` +
    ` (calls=${c.diffCalls} changed=${c.diffChangedCells}` +
    ` skipped=${c.diffRowsSkipped})\n`,
  );
  process.stderr.write(
    `  Write: ${t.write.toFixed(2)}ms  Serialize: ${t.serialize.toFixed(2)}ms\n`,
  );
  process.stderr.write(`  Elapsed: ${snapshot.elapsed.toFixed(0)}ms\n`);

  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────

const arg = process.argv[2];

if (!arg || arg === '--help' || arg === '-h') {
  process.stderr.write(
    'CellState profiler\n\n' +
    'Usage: npx tsx scripts/profile.tsx <scenario>\n' +
    '       npx tsx scripts/profile.tsx --list\n\n' +
    `Scenarios: ${Object.keys(scenarios).join(', ')}\n`,
  );
  process.exit(0);
}

if (arg === '--list') {
  for (const [name, config] of Object.entries(scenarios)) {
    process.stderr.write(`  ${name.padEnd(16)} ${config.desc}\n`);
  }
  process.exit(0);
}

runScenario(arg).catch(err => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
