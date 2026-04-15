/**
 * Internal — registers lowercase intrinsics for CellState's own build.
 * Not shipped to consumers (tsc does not emit .d.ts source files to outDir).
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
import type { Segment } from '../core/nodes.js';
import type { StyleProps, BoxProps, TextProps, RawAnsiProps } from './types.js';

declare module 'react' {
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
