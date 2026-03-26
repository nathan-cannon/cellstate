// ── Entry points ──
export { render } from './tui/render.js';
export type { RenderInstance, RenderOptions } from './tui/render.js';
export { renderOnce } from './tui/render-once.js';
export type { RenderOnceOptions } from './tui/render-once.js';
export { createFrameLoop } from './tui/frame-loop.js';
export type { FrameLoop } from './tui/frame-loop.js';

// ── JSX element types ──
export { Box, Text, Divider } from './tui/components.js';
export type { BoxProps, TextProps } from './tui/components.js';

// ── Types for building content ──
export type { Segment, SegmentStyle, StyledRun, WrappedLine } from './tui/nodes.js';

// ── Hooks ──
export { useApp } from './tui/app-context.js';
export type { AppContext } from './tui/app-context.js';
export { useInput } from './tui/use-input.js';
export type { UseInputOptions } from './tui/use-input.js';
export { useDimensions } from './tui/use-dimensions.js';
export type { Dimensions } from './tui/use-dimensions.js';
export { useFocus } from './tui/use-focus.js';
export type { UseFocusOptions, UseFocusResult } from './tui/use-focus.js';
export { useFocusManager } from './tui/use-focus-manager.js';
export type { UseFocusManagerResult } from './tui/use-focus-manager.js';

// ── Utilities ──
export { markdownToElements } from './tui/markdown.js';
export { highlightCode } from './tui/highlighter.js';
export { measureElement } from './tui/measure.js';
export type { ElementDimensions } from './tui/measure.js';
export { charDisplayWidth, stringDisplayWidth, sliceToWidth, sliceFromEndToWidth } from './width.js';

// ── Input handling ──
export { decodeKeypress } from './tui/keypress.js';
export type { KeypressEvent } from './tui/keypress.js';

// ── Terminal capabilities ──
export { detectCapabilities } from './tui/capabilities.js';
export type { TerminalCapabilities } from './tui/capabilities.js';
