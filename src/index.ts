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
export { Box, Text, Divider } from './components/elements.js';
export type { BoxProps, TextProps } from './components/elements.js';

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

// ── Utilities ──
export { markdownToElements } from './components/markdown.js';
export { highlightCode } from './components/highlighter.js';
export { measureElement } from './hooks/measure.js';
export type { ElementDimensions } from './hooks/measure.js';
export { charDisplayWidth, stringDisplayWidth, sliceToWidth, sliceFromEndToWidth } from './core/width.js';

// ── Input handling ──
export { decodeKeypress } from './hooks/keypress.js';
export type { KeypressEvent } from './hooks/keypress.js';

// ── Terminal capabilities ──
export { detectCapabilities } from './core/capabilities.js';
export type { TerminalCapabilities } from './core/capabilities.js';
