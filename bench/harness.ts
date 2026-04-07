import { performance } from 'node:perf_hooks';

export interface Stats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stddev: number;
}

export interface BenchmarkResult {
  name: string;
  iterations: number;
  latencies: number[];
  stats: Stats;
  meta?: Record<string, number>;
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stddev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / sorted.length;

  const n = sorted.length;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const stddev = Math.sqrt(variance);

  // Interpolated median
  const mid = (n - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  const median = lo === hi ? sorted[lo]! : (sorted[lo]! + sorted[hi]!) / 2;

  // Interpolated percentiles
  const p95idx = (n - 1) * 0.95;
  const p95lo = Math.floor(p95idx);
  const p95frac = p95idx - p95lo;
  const p95 = sorted[p95lo]! + p95frac * ((sorted[Math.ceil(p95idx)] ?? sorted[p95lo]!) - sorted[p95lo]!);

  const p99idx = (n - 1) * 0.99;
  const p99lo = Math.floor(p99idx);
  const p99frac = p99idx - p99lo;
  const p99 = sorted[p99lo]! + p99frac * ((sorted[Math.ceil(p99idx)] ?? sorted[p99lo]!) - sorted[p99lo]!);

  return {
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean,
    median,
    p95,
    p99,
    stddev,
  };
}

/**
 * Run fn `iterations` times after `warmup` warmups. Returns latencies array (ms).
 */
export function measure(
  fn: () => void,
  iterations: number = 200,
  warmup: number = 20,
): number[] {
  for (let i = 0; i < warmup; i++) {
    fn();
  }

  // Force GC to reduce noise in measurements
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    latencies.push(performance.now() - t0);
  }
  return latencies;
}

/**
 * Async variant of measure.
 */
export async function measureAsync(
  fn: () => Promise<void>,
  iterations: number = 100,
  warmup: number = 15,
): Promise<number[]> {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  // Force GC to reduce noise in measurements
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  const latencies: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    latencies.push(performance.now() - t0);
  }
  return latencies;
}

export function fmtMs(ms: number): string {
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

export function padLeft(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

export function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export function printTable(
  title: string,
  headers: string[],
  rows: string[][],
  colWidths?: number[],
): void {
  console.log(`\n${title}`);

  const widths = colWidths ?? headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      max = Math.max(max, (row[i] ?? '').length);
    }
    return max;
  });

  const headerLine = headers.map((h, i) => padRight(h, widths[i]!)).join(' │ ');
  const sep = widths.map(w => '─'.repeat(w)).join('─┼─');

  console.log('═'.repeat(headerLine.length));
  console.log(headerLine);
  console.log(sep);

  for (const row of rows) {
    const line = row.map((cell, i) => {
      // Right-align numeric columns (all except first)
      return i === 0 ? padRight(cell, widths[i]!) : padLeft(cell, widths[i]!);
    }).join(' │ ');
    console.log(line);
  }
  console.log('');
}
