/**
 * Benchmark runner. Run all: `npx tsx bench/run.ts`
 * Run one: `npx tsx bench/run.ts pipeline`
 */
import { runPipelineBreakdown } from './internals/pipeline-breakdown.js';
import { runRasterizeScope } from './internals/rasterize-scope.js';
import { runLayoutBreakdown } from './internals/layout-breakdown.js';
import { runGridAlloc } from './internals/grid-alloc.js';
import { runGrowthFrame } from './internals/growth-frame.js';
import { runStreamingSimulation } from './scenarios/streaming-simulation.js';
import { runResize } from './scenarios/resize.js';
import { runComponentMount } from './scenarios/component-mount.js';

const benchmarks: Record<string, () => Promise<void>> = {
  'pipeline': runPipelineBreakdown,
  'rasterize-scope': runRasterizeScope,
  'layout': runLayoutBreakdown,
  'grid-alloc': runGridAlloc,
  'growth': runGrowthFrame,
  'streaming': runStreamingSimulation,
  'resize': runResize,
  'mount': runComponentMount,
};

async function main() {
  console.log('CellState Internal Benchmarks');
  console.log(`Terminal: 120×40 | Node ${process.version}\n`);

  const arg = process.argv[2];
  if (arg) {
    const fn = benchmarks[arg];
    if (!fn) {
      console.error(`Unknown benchmark: ${arg}. Available: ${Object.keys(benchmarks).join(', ')}`);
      process.exit(1);
    }
    await fn();
  } else {
    // Run all
    console.log('── Internals ──');
    await runPipelineBreakdown();
    await runRasterizeScope();
    await runLayoutBreakdown();
    await runGridAlloc();
    await runGrowthFrame();

    console.log('── Scenarios ──');
    await runStreamingSimulation();
    await runResize();
    await runComponentMount();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
