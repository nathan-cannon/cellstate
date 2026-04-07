# Contributing to CellState

## Setup

```bash
git clone https://github.com/nathan-cannon/cellstate.git
cd cellstate
npm install
```

## Development

Build:
```bash
npm run build
```

Run tests:
```bash
bun test
```

Run benchmarks:
```bash
npx tsx bench/run.ts
```

Run a single benchmark:
```bash
npx tsx bench/run.ts pipeline
npx tsx bench/run.ts streaming
```

For more stable results, expose the GC so the harness can force collection between runs:
```bash
npx tsx --expose-gc bench/run.ts
```

## Tests

The test suite uses property-based testing against xterm.js as a ground truth oracle. Tests generate thousands of random UI states and verify CellState's ANSI output produces the correct terminal screen. If you change the paint, emit, or layout logic, the property tests will catch regressions.

Run a specific test file:
```bash
bun test test/core/paint.test.ts
```

## Pull requests

- Run `bun test` and `npm run build` before submitting.
- Add deterministic tests for specific edge cases.
- Keep PRs focused. One fix or feature per PR.

## Project structure

```
src/
  core/
    cell.ts           Cell type definitions
    cell-buffer.ts    Packed cell buffer (flat arrays for char/style/width)
    char-table.ts     Interned string table for cell characters
    style-table.ts    Interned style table (colors, attributes)
    link-table.ts     Interned hyperlink table
    dirty.ts          Dirty-region tracking for incremental updates
    paint.ts          Paints TNodes into a CellBuffer
    emit.ts           Emits ANSI escape sequences from a CellBuffer
    width.ts          Unicode display width tables
    reconciler.ts     React reconciler (TNode tree)
    layout.ts         Flexbox layout (delegates to layout/)
    frame-loop.ts     Frame scheduling and scrollback management
    render.ts         Terminal lifecycle (raw mode, cursor, cleanup)
    render-once.ts    Single-frame render for non-interactive output
    perf.ts           Performance instrumentation
    capabilities.ts   Terminal capability detection
  layout/
    flex-node.ts      Layout node abstraction
    yoga-flex.ts      Yoga-backed layout engine
    text-layout.ts    Text measurement and wrapping
    apply-props.ts    Maps JSX props to layout constraints
    populate-layout.ts Builds layout tree from TNodes
  components/
    elements.ts       JSX component exports (Box, Text, Divider, RawAnsi)
    markdown.tsx       Markdown-to-JSX converter
  markdown/
    ansi-generator.ts  Markdown block parsing and ANSI line generation
    block-cache.ts     Incremental block cache for streaming markdown
    highlighter.ts     Syntax highlighting (tree-sitter)
    theme.ts           Highlight color themes
    tree-sitter-init.ts Tree-sitter WASM initialization
  hooks/
    use-input.ts      Keyboard input hook
    use-focus.ts      Focus management hook
    app-context.ts    App lifecycle context
```

The rendering pipeline: React reconciler > layout > paint into CellBuffer > emit ANSI output.

## Reporting bugs

Include your terminal emulator, OS, Node version, and a minimal reproduction. If the bug is visual (flickering, misaligned content), a screenshot or recording helps.