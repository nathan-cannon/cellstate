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

## Tests

The test suite uses property-based testing against xterm.js as a ground truth oracle. Tests generate thousands of random UI states and verify CellState's ANSI output produces the correct terminal screen. If you change the diff engine, rasterizer, or serialization logic, the property tests will catch regressions.

Run a specific test file:
```bash
bun test test/core/diff.test.ts
```

## Pull requests

- Run `bun test` and `npm run build` before submitting.
- If your change affects rendering output, the property-based tests in `render-properties.test.ts` should cover it. Add deterministic tests for specific edge cases.
- Keep PRs focused. One fix or feature per PR.

## Project structure

```
src/
  core/
    cell.ts           Cell grid data structures
    diff.ts           Cell-level diff engine and ANSI serialization
    width.ts          Unicode display width tables
    reconciler.ts     React reconciler (TNode tree)
    layout.ts         Flexbox layout engine
    rasterizer.ts     Paints TNodes into CellGrid
    frame-loop.ts     Frame scheduling and scrollback management
    render.ts         Terminal lifecycle (raw mode, cursor, cleanup)
  components/
    elements.ts       JSX component exports (Box, Text, Divider)
    markdown.tsx      Markdown-to-JSX converter
    highlighter.ts    Syntax highlighting (Shiki)
  hooks/
    use-input.ts      Keyboard input hook
    use-focus.ts      Focus management hook
    app-context.ts    App lifecycle context
```

The rendering pipeline: React reconciler > layout > rasterize > viewport extract > diff > ANSI output.

## Reporting bugs

Include your terminal emulator, OS, Node version, and a minimal reproduction. If the bug is visual (flickering, misaligned content), a screenshot or recording helps.