/**
 * JSX component exports. These are string literals cast to React.FC for type
 * checking. The reconciler maps the strings to TNode creation; there are no
 * actual component functions, similar to how React DOM handles 'div'/'span'.
 */
import React from 'react';
import type { BoxProps, TextProps, RawAnsiProps } from './jsx.js';

export const Box = 'box' as unknown as React.FC<BoxProps>;
export const Text = 'text' as unknown as React.FC<TextProps>;
export const Divider = 'divider' as any;
export const RawAnsi = 'raw-ansi' as unknown as React.FC<RawAnsiProps>;
export type { BoxProps, TextProps, RawAnsiProps };

export { useApp } from '../hooks/app-context.js';
export { useFocus } from '../hooks/use-focus.js';
export { useFocusManager } from '../hooks/use-focus-manager.js';
