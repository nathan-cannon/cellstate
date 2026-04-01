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
  /** Spacing between children in rows. */
  gap?: number;
  /** Fixed width in columns. If omitted, fills available width. */
  width?: number;
  /** Fixed height in rows. If omitted, shrinks to fit children. */
  height?: number;
  /** Fill remaining space in a row layout. */
  flexGrow?: number | boolean;
  /** Margin on all four sides (shorthand). Individual sides override. */
  margin?: number;
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
  /** Main-axis distribution of children. Only effective when the container has extra space (e.g. fixed height). Default: 'flex-start'. */
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
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
    }
  }
}
