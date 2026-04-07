import type { Segment } from '../core/nodes.js';

/**
 * Style props shared by both <box> and <text> elements.
 * The rasterizer reads these from node.props and merges them
 * into the inherited StyleContext (precedence: inherited → node → segment).
 */
export interface StyleProps {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Swap foreground and background colors. */
  inverse?: boolean;
  /** Foreground color as hex string (#RRGGBB or #RRGGBBAA). */
  fg?: string;
  /** Alias for `fg`. */
  color?: string;
  /** Background color as hex string (#RRGGBB or #RRGGBBAA). */
  backgroundColor?: string;
}

/**
 * Props for the `<box>` intrinsic element (a container node).
 *
 * Layout reads: flexDirection, gap, width, flexGrow, padding, paddingLeft, paddingRight, paddingTop, paddingBottom, margin, marginTop, marginBottom, marginLeft, marginRight, borderStyle.
 * Rasterizer reads: backgroundColor and all StyleProps.
 */
export interface BoxProps extends StyleProps {
  /** Hide this component and all its children. Component stays mounted (React state preserved). Default: 'flex'. */
  display?: 'flex' | 'none';
  /** Stack direction for children. Default: 'column'. */
  flexDirection?: 'column' | 'row';
  /** Spacing between children. */
  gap?: number;
  /** Gap between columns (overrides gap for horizontal axis). */
  columnGap?: number;
  /** Gap between rows (overrides gap for vertical axis). */
  rowGap?: number;
  /** Fixed width in columns. If omitted, fills available width. */
  width?: number;
  /** Fixed height in rows. If omitted, shrinks to fit children. */
  height?: number;
  /** Width as percentage of parent (0-100). */
  widthPercent?: number;
  /** Height as percentage of parent (0-100). */
  heightPercent?: number;
  /** Minimum width in columns. */
  minWidth?: number;
  /** Maximum width in columns. */
  maxWidth?: number;
  /** Minimum height in rows. */
  minHeight?: number;
  /** Maximum height in rows. */
  maxHeight?: number;
  /** Fill remaining space in a row layout. */
  flexGrow?: number | boolean;
  /** How much this child should shrink relative to siblings. Default: 0. */
  flexShrink?: number;
  /** Initial main-axis size before flex grow/shrink. Number for columns, string like "50%" for percentage. */
  flexBasis?: number | string;
  /** Allow children to wrap to the next line. Default: 'nowrap'. */
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse';
  /** Margin on all four sides (shorthand). Individual sides override. */
  margin?: number;
  /** Shorthand for marginLeft + marginRight. */
  marginX?: number;
  /** Shorthand for marginTop + marginBottom. */
  marginY?: number;
  /** Space before the box (vertical only). */
  marginTop?: number;
  /** Space after the box (vertical only). */
  marginBottom?: number;
  /** Space to the left of the box. */
  marginLeft?: number;
  /** Space to the right of the box (reduces node width). */
  marginRight?: number;
  /** Padding on all four sides (shorthand). Individual sides override. */
  padding?: number;
  /** Shorthand for paddingLeft + paddingRight. */
  paddingX?: number;
  /** Shorthand for paddingTop + paddingBottom. */
  paddingY?: number;
  /** Left padding inside the box. */
  paddingLeft?: number;
  /** Right padding inside the box. */
  paddingRight?: number;
  /** Top padding inside the box. */
  paddingTop?: number;
  /** Bottom padding inside the box. */
  paddingBottom?: number;
  /** Draw a border around the box. */
  borderStyle?: 'single' | 'double' | 'round' | 'bold';
  /** Foreground color for border characters (#RRGGBB or #RRGGBBAA). */
  borderColor?: string;
  /** Cross-axis alignment of children. Default: 'stretch'. */
  alignItems?: 'stretch' | 'center' | 'flex-start' | 'flex-end';
  /** Override parent's alignItems for this child. */
  alignSelf?: 'auto' | 'stretch' | 'flex-start' | 'center' | 'flex-end';
  /** Cross-axis distribution of multi-line content (when flexWrap is used). */
  alignContent?: 'stretch' | 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  /** Main-axis distribution of children. Only effective when the container has extra space (e.g. fixed height). Default: 'flex-start'. */
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  /** Positioning mode. 'absolute' removes the node from normal flow. Default: 'relative'. */
  position?: 'relative' | 'absolute';
  /** Offset from top when position='absolute'. */
  top?: number;
  /** Offset from left when position='absolute'. */
  left?: number;
  /** Offset from right when position='absolute'. */
  right?: number;
  /** Offset from bottom when position='absolute'. */
  bottom?: number;
  /** Content overflow behavior. Default: 'visible'. */
  overflow?: 'visible' | 'hidden';
  /** Width-to-height ratio (e.g. 2 means width is 2x height). */
  aspectRatio?: number;
  /** Heading depth from markdown (passthrough, not consumed by layout/rasterizer). */
  depth?: number;
  /** Language hint from markdown code blocks (passthrough, not consumed by layout/rasterizer). */
  lang?: string;
  children?: React.ReactNode;
  key?: React.Key;
  ref?: React.Ref<any>;
}

/**
 * Props for the `<text>` intrinsic element (a leaf text node).
 *
 * Layout reads: segments, hangingIndent.
 * Rasterizer reads: segments (per-run styles) and all StyleProps.
 * Plain string children are set as node.text by the reconciler.
 */
export interface TextProps extends StyleProps {
  /** Styled text runs. When provided, children are ignored for rendering. */
  segments?: Segment[];
  /** Indent continuation lines (used for list items). */
  hangingIndent?: number;
  /** Text overflow behavior. Default: 'wrap'. Truncation modes collapse to a single line with ellipsis. */
  wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-start' | 'truncate-middle';
  children?: React.ReactNode;
  key?: React.Key;
}

/**
 * Register <box> and <text> as JSX intrinsic elements for our custom
 * react-reconciler renderer.
 *
 * With "jsx": "react-jsx", TypeScript resolves IntrinsicElements from
 * react/jsx-runtime, which re-exports from React.JSX. We augment the
 * 'react' module's JSX namespace so both paths pick up our types.
 *
 * @types/react declares <text> as SVGTextElementAttributes, and interface
 * merging is additive, so we can't remove it. The merged `text` type becomes
 * the intersection of SVGTextElementAttributes and TextProps, so TypeScript
 * requires props to satisfy both. We augment SVGTextElementAttributes with
 * the exact props from TextProps so our custom props pass the check.
 * This is scoped to only the props we use, not an open index signature.
 */
/**
 * Props for the `<raw-ansi>` intrinsic element. Bypasses text wrapping and
 * segment painting — writes pre-rendered ANSI strings directly to the cell buffer.
 */
export interface RawAnsiProps {
  /** Pre-rendered ANSI lines. Each element is one terminal row, already wrapped to width. */
  lines: string[];
  /** Column width the producer wrapped to. Used as fixed Yoga leaf width. */
  rawWidth: number;
  key?: React.Key;
}

declare module 'react' {
  // Augment SVGTextElementAttributes with our TextProps fields so the
  // intersection type (SVGTextElementAttributes & TextProps) accepts them.
  interface SVGTextElementAttributes<T> extends StyleProps {
    segments?: Segment[];
    hangingIndent?: number;
  }

  namespace JSX {
    interface IntrinsicElements {
      box: BoxProps;
      text: TextProps;
      'raw-ansi': RawAnsiProps;
    }
  }
}
