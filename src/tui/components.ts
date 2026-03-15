import React from 'react';
import type { BoxProps, TextProps } from './jsx.js';

export const Box = 'box' as unknown as React.FC<BoxProps>;
export const Text = 'text' as unknown as React.FC<TextProps>;
export const Divider = 'divider' as any;
export type { BoxProps, TextProps };

export { useApp } from './app-context.js';
export { useFocus } from './use-focus.js';
export { useFocusManager } from './use-focus-manager.js';
