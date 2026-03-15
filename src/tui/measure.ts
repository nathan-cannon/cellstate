import type { TNode } from './nodes.js';

export interface ElementDimensions {
  width: number;
  height: number;
}

export function measureElement(node: TNode): ElementDimensions {
  if (!node.layout) {
    return { width: 0, height: 0 };
  }
  return {
    width: node.layout.width,
    height: node.layout.height,
  };
}
