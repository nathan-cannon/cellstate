// ── Entry points ──
export { render } from './core/render.js';
export type { RenderInstance, RenderOptions } from './core/render.js';
export { renderOnce } from './core/render-once.js';
export type { RenderOnceOptions } from './core/render-once.js';
export { createFrameLoop } from './core/frame-loop.js';
export type { FrameLoop, FrameLoopOptions } from './core/frame-loop.js';

// ── Performance instrumentation ──
export { createPerf } from './core/perf.js';
export type { Perf, PerfSnapshot, PerfCounts, PerfTimings } from './core/perf.js';

// ── JSX element types ──
export { Box, Text, Divider, RawAnsi } from './components/elements.js';
export type { BoxProps, TextProps, RawAnsiProps } from './components/elements.js';

// ── Types for building content ──
export type { Segment, SegmentStyle, StyledRun, WrappedLine } from './core/nodes.js';

// ── Hooks ──
export { useApp } from './hooks/app-context.js';
export type { AppContext } from './hooks/app-context.js';
export { useInput } from './hooks/use-input.js';
export type { UseInputOptions } from './hooks/use-input.js';
export { useDimensions } from './hooks/use-dimensions.js';
export type { Dimensions } from './hooks/use-dimensions.js';
export { useFocus } from './hooks/use-focus.js';
export type { UseFocusOptions, UseFocusResult } from './hooks/use-focus.js';
export { useFocusManager } from './hooks/use-focus-manager.js';
export type { UseFocusManagerResult } from './hooks/use-focus-manager.js';

// ── Layout abstraction ──
export type { FlexNode, FlexNodeFactory, FlexEdge, SizeFunc } from './layout/flex-node.js';
export { SizeConstraint } from './layout/flex-node.js';

// ── Markdown ──
export { Markdown, StreamingMarkdown } from './components/markdown.js';
export type { MarkdownProps, StreamingMarkdownProps } from './components/markdown.js';

// ── Markdown internals (advanced usage) ──
export { initTreeSitter, setWasmDir, preloadLanguages } from './markdown/tree-sitter-init.js';
export { BlockCache } from './markdown/block-cache.js';
export { wrapAnsiText, generateAnsiLines, parseMarkdownToBlocks } from './markdown/ansi-generator.js';
export type { MarkdownBlock } from './markdown/ansi-generator.js';
export { setHighlightTheme, nordTheme } from './markdown/theme.js';
export type { HighlightTheme } from './markdown/theme.js';


// ── Utilities ──
export { measureElement } from './hooks/measure.js';
export type { ElementDimensions } from './hooks/measure.js';
export { charDisplayWidth, stringDisplayWidth, sliceToWidth, sliceFromEndToWidth } from './core/width.js';

// ── Input handling ──
export { decodeKeypress } from './hooks/keypress.js';
export type { KeypressEvent } from './hooks/keypress.js';

// ── Packed buffer types ──
export type { CellBuffer } from './core/cell-buffer.js';
export { readCell, bufferToText, NORMAL_WIDTH, WIDE_WIDTH, CONTINUATION_WIDTH } from './core/cell-buffer.js';
export { CharTable, SPACE_CHAR, EMPTY_CHAR } from './core/char-table.js';
export { StyleTable, DEFAULT_STYLE } from './core/style-table.js';
export { LinkTable, NO_LINK } from './core/link-table.js';

// ── Terminal capabilities ──
export { detectCapabilities } from './core/capabilities.js';
export type { TerminalCapabilities } from './core/capabilities.js';
