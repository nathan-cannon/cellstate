/** Runs the pipeline once and returns a styled ANSI string. Uses real newlines
 *  so output is safe to pipe or capture in tests. */
import React from 'react';
import { mountRoot } from './reconciler.js';
import { layout, contentHeight } from './layout.js';
import { rasterize } from './rasterizer.js';
import { serializeRowsReflow } from '../diff.js';
import type { TNode } from './nodes.js';

export interface RenderOnceOptions {
  columns?: number;
}

export function renderOnce(
  element: React.ReactElement,
  options?: RenderOnceOptions,
): Promise<string> {
  const cols = options?.columns ?? process.stdout.columns ?? 80;

  return new Promise<string>((resolve) => {
    mountRoot(element, (root: TNode) => {
      const rows = 1000;
      layout(root, cols, rows);

      const ch = contentHeight(root);
      if (ch <= 0) {
        resolve('');
        return;
      }

      const grid = rasterize(root, cols, ch, 0);
      const result = serializeRowsReflow(grid);
      resolve(result.output);
    });
  });
}
