/** Runs the pipeline once and returns a styled ANSI string. Uses real newlines
 *  so output is safe to pipe or capture in tests. */
import React from 'react';
import { mountRoot, setFlexNodeFactory } from './reconciler.js';
import { createFlexNodeFactory } from '../layout/yoga-flex.js';
import { paintTree } from './paint.js';
import { createCellBuffer } from './cell-buffer.js';
import { CharTable } from './char-table.js';
import { StyleTable } from './style-table.js';
import { LinkTable } from './link-table.js';
import { serializeRowsForExit } from './emit.js';
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
    const charTable = new CharTable();
    const styleTable = new StyleTable();
    const linkTable = new LinkTable();

    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(element, (root: TNode) => {
      root.flexNode!.setWidth(cols);
      root.flexNode!.calculateLayout(cols);

      const ch = root.flexNode!.getComputedHeight();
      if (ch <= 0) {
        resolve('');
        return;
      }

      const buf = createCellBuffer(cols, ch);
      paintTree(root, buf, null, charTable, styleTable, linkTable, 0);
      const result = serializeRowsForExit(buf, styleTable, charTable, linkTable, false);
      resolve(result.output);
    });
  });
}
