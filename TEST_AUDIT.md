# CellState Testing Infrastructure Audit

## 1. Test Inventory

### Test Files and Coverage

| File | Covers | Type | ~Cases |
|---|---|---|---|
| `test/__tests__/width.test.ts` | `charDisplayWidth`, `stringDisplayWidth`, `sliceToWidth`, `sliceFromEndToWidth`, VS16, emoji presentation | Unit | 46 |
| `test/tui/__tests__/layout.test.ts` | `wrapText`, `layout()`, `contentHeight`, padding/margin/gap/flexDirection/alignItems/justifyContent/border/divider/display:none/truncation | Unit | 87 |
| `test/tui/__tests__/rasterizer.test.ts` | Rasterizer: text placement, wrapping, colors, attrs, style inheritance, backgrounds, borders, wide chars, scroll offset, viewport clipping, segments, dividers, display:none, end-to-end with layout | Unit | 50 |
| `test/tui/__tests__/reconciler.test.ts` | `mountRoot`: tree building, child add/remove/reorder, text update, commitUpdate identity, onFrame firing, rapid sequential updates | Unit | 12 |
| `test/tui/tests/frame-loop.test.ts` | Frame loop: first frame, update/diff, DEC 2026, growth frames, content shrink, resize, backpressure/drain, scrollback tracking, status bar, spinner removal | Integration | 55 |
| `test/__tests__/diff.test.ts` | Diff engine: no-change, single cell, style-only, full line, sparse, clear, wide chars, fullRedraw, no-absolute-CUP, stale pixel regression (spinner shrink) | Unit + Integration + Property-based | 25 |
| `test/__tests__/render-properties.test.ts` | 12 property-based tests: fullRedraw round-trip, diff round-trip, idempotency, determinism, 20-frame sequential composition, pending wrap stress, wide chars at edge, shrink simulation, cursor bounds, style-only transitions, diff minimality, full pipeline (component->rasterize->diff->verify) | Property-based | 12 (x3,600 iterations) |
| `test/__tests__/ansi-parser.test.ts` | `parseAnsi`: plain text, colors (basic/256/truecolor), cursor position, wrapping, wide chars, attrs, xterm color mode constants, renderMarkdown through parseAnsi | Unit + Property-based | 21 |
| `test/__tests__/virtual-screen.test.ts` | `VirtualScreen`: accumulation, incremental updates, rapid writes, resize, renderMarkdown integration | Integration | 10 |
| `test/__tests__/ink-output-capture.test.ts` | DEC 2026 handling in xterm, Ink render capture through VirtualScreen, incremental Ink updates, full pipeline (capture->VirtualScreen->diff->apply) | Integration (Ink cross-validation) | 25 |
| `test/tui/tests/keypress.test.ts` | `decodeKeypress`: ASCII, multi-byte, backspace, enter, arrows, Ctrl+key, Home/End, Delete, UTF-8, emoji, CJK, SGR mouse, tab, shift-tab | Unit | 33 |
| `test/tui/tests/input.test.ts` | `handleKey` state machine: insert, delete, backspace, cursor movement, home/end, passthrough events | Unit | 16 |
| `test/tui/tests/markdown.test.ts` | `flattenInline`: text/strong/emphasis/inlineCode/link/delete/break; `markdownToElements` integration via reconciler: heading, code blocks, lists, blockquotes, thematic breaks | Unit + Integration | 21 |
| `test/tui/tests/highlighter.test.ts` | `highlightCode`: known/unknown languages, multi-line, fontStyle mapping, empty lines, empty tokens | Unit | 10 |

### Totals

- **~432 test case declarations** across 14 test files
- **~3,600 property-based iterations** in `render-properties.test.ts` alone (500+500+300+300+200x20frames+300+200+200+300+300+200+300)
- Additional **~1,000 property-based iterations** in `diff.test.ts` (200+300+500)
- **Test runner: `bun test`**

### Test Helpers and Utilities

| File | Purpose |
|---|---|
| `test/virtual-screen.ts` | Persistent xterm.js Terminal wrapper; accumulates ANSI writes, reads CellGrid via buffer-reader, supports viewport-only reads |
| `test/buffer-reader.ts` | Translates xterm.js buffer state into CellGrid — maps xterm color mode constants, extracts attrs, normalizes char/width |
| `test/ansi-parser.ts` | One-shot ANSI->CellGrid parser (creates+disposes xterm Terminal per call) |
| `test/__tests__/markdown-helper.ts` | Renders markdown via `marked`+`marked-terminal`+`cli-highlight` (used as comparison reference) |
| `test/__tests__/preload.ts` | Sets `FORCE_COLOR=1` before module load for chalk/Ink tests |
| `test/tui/demo.ts` | Interactive demo app (not a test) |

---

## 2. The xterm.js Oracle Pattern

### How VirtualScreen Works

`VirtualScreen` (in `test/virtual-screen.ts`) wraps a **persistent** `@xterm/headless` Terminal instance. Unlike `parseAnsi()` which creates a fresh terminal per call, VirtualScreen **accumulates state** across multiple `write()` calls — modeling how a real terminal works (incremental cursor moves + partial rewrites, not complete frames).

Key methods:

- **`write(data)`** — feeds ANSI to the xterm instance (async, uses xterm's parser queue)
- **`readGrid()`** — reads from row 0 of the buffer (includes scrollback if `baseY > 0`)
- **`readViewportGrid()`** — reads only the visible viewport (rows from `baseY` onwards), which is what the frame loop's diff engine operates on
- **`resize(cols, rows)`** — disposes and recreates the terminal (xterm-headless doesn't support resize well)
- **`getCursorPos()`** — returns cursor position within viewport
- **`baseY`** — number of rows scrolled into scrollback

### How buffer-reader.ts Translates xterm.js State

`buffer-reader.ts` reads xterm's `IBufferNamespace` into a `CellGrid`:

1. Iterates rows x cols on the active buffer
2. For each cell, reads: `getChars()`, `getWidth()`, `getFgColor()`/`getFgColorMode()`, `getBgColor()`/`getBgColorMode()`, plus 6 attr methods (`isBold`, `isItalic`, `isUnderline`, `isStrikethrough`, `isDim`, `isInverse`)
3. Maps xterm's **undocumented color mode constants** (0 = default, 0x2000000 = palette, 0x3000000 = RGB) to CellState's `ColorMode` enum
4. Normalizes: width=0 -> `char=""` (continuation), width>=1 with empty char -> `char=" "` (unfilled)

The `ansi-parser.test.ts` includes **guard tests** that verify these hardcoded xterm constants haven't changed on `@xterm/headless` upgrade — a clever defensive measure.

### What ansi-parser.ts Does

`ansi-parser.ts` is a convenience wrapper: creates a fresh xterm Terminal, uses the **private `_core.writeSync`** API for synchronous writes (keeping tests simple), reads the buffer into a CellGrid, disposes the terminal. One-shot: parse ANSI string -> CellGrid.

### Walk-Through: One Complete Property-Based Test

Taking **Test 2 ("diff round-trip")** from `render-properties.test.ts`:

1. **Generation**: `pairedGridArb` generates two CellGrids of the same random dimensions (10-80 cols x 5-20 rows). Each cell is randomly: 80% narrow ASCII char with random fg/bg (weighted: 50% default, 30% palette 0-255, 20% RGB 24-bit) and random attrs (bold/italic/underline combos 0-7), or 20% wide CJK char (you/hao/shi/jie) with a spacer continuation cell. 10% chance of fully blank grid.

2. **Serialization**: `diff(gridA, gridB, 0, 0)` computes the minimal ANSI escape sequence to transform gridA into gridB.

3. **Fed to xterm**: `applyDiff()` seeds a VirtualScreen with gridA via `fullRedraw(gridA, 0).output`, positions cursor at (0,0) with `\x1b[H`, then writes the diff output.

4. **Comparison**: `assertGridsEqual()` compares every cell of the VirtualScreen's resulting grid against gridB. **Spacer cells (width=0, char="")** are skipped — their attrs are set by the terminal as a side effect of wide chars and don't reflect explicit content.

5. **Failure reporting**: On mismatch, throws with seed, iteration number, cell coordinates, actual vs expected cell JSON, hex dump of diff output, and full `describeGrid()` output of both grids (shows chars + per-cell style annotations).

### What Cell Properties Are Compared and Which Are Skipped

**Compared**: `char`, `width`, `fg` (mode + value), `bg` (mode + value), `attrs` (bitmask)

**Skipped**:

- **Wide-char continuation cells** (width=0, char="") — their attrs/colors are inherited from the preceding wide char by the terminal and vary between xterm implementations. Both grids must agree the cell is a spacer, but the inherited style is not checked.
- **Cursor position** — `assertGridsEqual` ignores `cursorRow`/`cursorCol` (separate cursor bounds test exists as Test 9)
- **Emoji** — deliberately excluded from the wide char generators because xterm-headless reports emoji as width 1, while real terminals show width 2. Only CJK characters are used for wide char testing.

---

## 3. Pipeline Stage Coverage Map

| Pipeline Stage | Test Files | Coverage Level |
|---|---|---|
| **Reconciler** (JSX -> TNode) | `reconciler.test.ts` | Good — tree build, add/remove/reorder children, text updates, onFrame callback semantics |
| **Layout** (TNode -> positions) | `layout.test.ts` | Excellent — 87 tests covering wrapping, flex row/column, gap, padding (all sides), margin, border sizing, alignItems, justifyContent, hanging indent, resize, edge cases |
| **Rasterizer** (TNode -> CellGrid) | `rasterizer.test.ts` | Good — text placement, wrapping, colors, attrs, inheritance, backgrounds, borders, scroll offset, viewport clipping, wide chars, segments, dividers |
| **Diff engine** (prev -> next grid -> ANSI) | `diff.test.ts`, `render-properties.test.ts` | Excellent — unit tests + 3,600+ property-based iterations with xterm oracle |
| **Serialization** (grid -> ANSI initial) | `render-properties.test.ts` Test 1 | Excellent — 500 iterations of fullRedraw round-trip against xterm |
| **Frame loop** | `frame-loop.test.ts` | Good — 55 tests covering update/growth/full redraw classification, scrollback tracking, resize, backpressure, DEC 2026 wrapping, status bar, spinner removal |
| **Viewport extraction + scrollback** | `frame-loop.test.ts`, `rasterizer.test.ts` | Moderate — frame-loop tests verify scrollbackRows counts and viewport content; rasterizer tests verify scroll offset clipping |
| **Width calculations** | `width.test.ts` | Good — 46 tests covering ASCII, CJK, Hangul, emoji, combining marks, VS16, surrogates, slicing |
| **Keypress decoding** | `keypress.test.ts` | Good — 33 tests covering all event types, UTF-8, SGR mouse, mixed content |
| **End-to-end** (component -> terminal) | `render-properties.test.ts` Test 12, `ink-output-capture.test.ts` | Moderate — Test 12 does component->layout->rasterize->diff->xterm (300 iterations); Ink capture tests validate against Ink's renderer |

---

## 4. What's NOT Tested

### Pipeline Stages With No or Weak Coverage

1. **`render()` entry point** — Never tested end-to-end. No test calls CellState's own `render()` function, creates a React component, triggers state updates, and verifies the terminal output. All end-to-end tests either use Ink's `render()` (ink-output-capture) or manually construct TNode trees and run layout->rasterize->diff manually. The wiring in `render.ts` (error boundary, raw mode, bracketed paste enable, console patching, focus context wiring, keepAlive interval, exit handler) is untested.

2. **`useInput` hook** — No test verifies that the React hook correctly registers/deregisters stdin listeners or that the `active` flag actually starts/stops listening.

3. **`useFocus` / `useFocusManager` hooks** — The FocusRegistry class itself is exercised implicitly through `render.ts` integration, but there are **no tests** for the Tab/Shift-Tab cycling behavior, `autoFocus`, `isActive` toggling, programmatic `focus(id)`, or `enableFocus`/`disableFocus`.

4. **`useDimensions` hook** — No tests.

5. **`patchConsole`** — No tests that console.log/warn/error are redirected to stderr and restored on cleanup.

6. **`renderOnce`** — No tests for the static rendering path.

7. **`measureElement`** — No tests.

### Specific Gaps

- **No integration tests through CellState's own `render()`** — The ink-output-capture tests go through *Ink's* render, not CellState's. Test 12 in render-properties goes through layout+rasterize+diff but bypasses the reconciler and frame loop.

- **Frame loop is tested but NOT against xterm.js** — The frame-loop tests use a mock stdout and verify properties of the output (contains/not contains certain escape sequences, grid state via `getGrid()`). They do **not** feed the output to a VirtualScreen to verify it produces the correct visual result. The mock stdout is just a string collector.

- **Resize handling is partially tested** — Frame-loop tests verify resize triggers clear screen and correct dimensions. But there's no test that feeds resize output to xterm.js to verify the visual result is correct.

- **Space-backspace row advancement is NOT tested against xterm.js** — The `serializeRows` function uses `' \x08'` for row advancement (instead of `\n`). While the property-based diff tests implicitly test `fullRedraw` (which uses `serializeRowsFull` with the same technique), there's no targeted test that verifies space-backspace produces the same visual result as `\n` across row boundaries.

- **SGR delta transitions (`styleDelta`) are only tested indirectly** — No unit tests for `styleDelta()` specifically. It's exercised through the diff round-trip property tests, which validates the *output* is correct but doesn't verify the *minimal* SGR sequences are chosen for specific transitions (e.g., bold->dim requires `\x1b[22m` before re-enabling).

- **Scrollback integrity is weakly tested** — Frame-loop tests verify `scrollbackRows` count and that `getGrid()` shows the right viewport content. But there's no test that reads scrollback content from xterm.js (via `readGrid()` at `baseY=0`) to verify rows pushed into scrollback retain correct styling. The `readViewportGrid()` method exists for this purpose but isn't used in frame-loop tests because the frame loop uses a mock stdout, not a VirtualScreen.

- **`serializeRowsReflow`** (exit repaint) — Not tested against xterm.js. The frame loop's `stop()` method uses this for exit repaint, but no test verifies the exit output produces a correct visual result.

---

## 5. Cross-Terminal Testing

- **Only xterm.js** — All oracle testing uses `@xterm/headless`. There's no mechanism to test against other terminal emulators (iTerm2, kitty, Windows Terminal, Ghostty).

- **Terminal-specific workarounds exist but aren't tested** — The codebase has a comment in `render-properties.test.ts` (Test 6, pending wrap stress): *"xterm-headless may be more lenient about pending wrap state than real terminals (iTerm2, Ghostty, Windows Terminal). A passing test here does NOT guarantee correct behavior on physical terminals."*

- **Width data has terminal-specific overrides** — `src/width.ts:33` has hardcoded overrides for Japanese button emoji that are width 2 on real terminals but `Emoji_Presentation=No` in Unicode data. Comment says "Verified against iTerm2, Terminal.app, and kitty via test-terminal-widths.ts" — but this verification script isn't in the repo.

- **No capability detection testing** — DEC 2026 synchronized output is always emitted; the tests verify xterm ignores it, but there's no testing around terminals that might not handle it gracefully.

---

## 6. Benchmark Infrastructure

The `bench/` directory contains a comprehensive internal benchmarking suite.

**Runner**: `bench/run.ts` — `npx tsx bench/run.ts [name]`

**Harness**: `bench/harness.ts` — `measure(fn, iterations, warmup)` with stats (min/max/mean/median/p95/p99/stddev), table formatting

### Internal Benchmarks (5)

| Name | What it measures |
|---|---|
| `pipeline-breakdown` | Full pipeline: layout -> rasterize -> diff, broken down per stage |
| `rasterize-scope` | Rasterizer performance at different content sizes |
| `layout-breakdown` | Layout engine at different tree sizes/complexity |
| `grid-alloc` | CellGrid allocation and `createGrid` cost |
| `growth-frame` | Growth frame sequence (pre-paint + scroll + redraw) |

### Scenario Benchmarks (3)

| Name | What it measures |
|---|---|
| `streaming-simulation` | Simulates streaming text (SSE-style), measures frame-to-frame latency |
| `resize` | Terminal resize handling latency |
| `component-mount` | React component mount -> first frame latency |

**No allocation/GC pressure benchmarks** — The benchmarks measure wall-clock latency only. There's no `--expose-gc` or heap snapshot analysis.

---

## 7. Test Helpers and Utilities

### Custom fast-check Arbitraries (in render-properties.test.ts)

- **`colorArb`** — Weighted: 50% Default, 30% Palette (0-255), 20% RGB (24-bit). Realistic distribution.
- **`cellArb`** — 80% narrow ASCII (a-z, 0-9, space, punctuation), 20% wide CJK. Emoji deliberately excluded (xterm mismatch).
- **`gridArb(cols, rows)`** — Builds valid grids with proper wide char spacer placement. 10% chance of fully blank grid.
- **`variableGridArb`** — 10-120 cols x 5-30 rows.
- **`pairedGridArb`** — Two grids of identical dimensions.
- **`segmentArb`** — Text segments with optional styles (bold/italic/dim/fg color).
- **`componentTreeArb`** — Random TNode trees: root with 3-8 children (text or nested boxes with padding/gap/width).
- **`mutatedTreeArb`** — Clone tree A, mutate 1-3 text nodes -> tree B. Produces ~90% identical grids.
- **Targeted generators**: `wrapStressArb` (last-column differences), `wideEdgeArb` (wide chars at right edge), `shrinkArb` (tail rows blanked), `styleOnlyArb` (chars identical, styles differ), `sparseChangeArb` (1-5 cells changed).

### Failure Reporting Quality

**Excellent.** The `assertGridsEqual` in `render-properties.test.ts` includes:

- Seed number (reproducible)
- Iteration index
- Label identifying which sub-test
- Exact cell coordinates of first mismatch
- Full JSON of actual vs expected cell
- Grid dimensions
- Hex dump of diff output
- Full `describeGrid()` output of both grids (chars per row + per-cell style annotations)

This means a failing property test is fully reproducible and debuggable from its output alone.

---

## Three Most Important Testing Gaps

### 1. No end-to-end tests through CellState's own `render()` function

The entire wiring layer — ErrorBoundary, AppCtx/FocusCtx providers, raw mode, bracketed paste, console patching, keepAlive, exit handlers — has **zero test coverage**. The `ink-output-capture` tests validate against *Ink's* renderer, and `render-properties` Test 12 manually constructs TNode trees. A bug in how `render()` wires the frame loop to the reconciler, or how `unmount()` restores terminal state, would go undetected. This is the primary user-facing entry point.

### 2. Frame loop output is never verified against xterm.js

The 55 frame-loop tests use a mock stdout and check properties (string contains, grid state, write counts). But the actual ANSI output is never fed to a VirtualScreen to verify it produces the correct visual result. This means the growth frame's pre-paint->scroll->redraw sequence, the space-backspace row advancement, and the exit repaint (`serializeRowsReflow`) are all untested for visual correctness. A bug that produces ANSI that *looks right* to string matching but renders incorrectly in a real terminal would be missed. The infrastructure to do this already exists (VirtualScreen) — it's just not connected to the frame loop tests.

### 3. Focus system, hooks, and `renderOnce` have no tests

`useFocus`, `useFocusManager`, `useInput`, `useDimensions`, `patchConsole`, `measureElement`, and `renderOnce` are all completely untested. The focus system is particularly important — Tab/Shift-Tab cycling, autoFocus, programmatic focus, enable/disable — and is a common source of user-facing bugs. `renderOnce` is the static rendering path (used for one-shot terminal output and testing) and its correctness is assumed but never verified.
