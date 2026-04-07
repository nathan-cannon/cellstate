import type { FlexNode } from '../layout/flex-node.js';

export interface SegmentStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dim?: boolean;
  /** Swap foreground and background colors. */
  inverse?: boolean;
  fg?: string;
  /** Alias for `fg`. Takes priority when both are set. */
  color?: string;
  backgroundColor?: string;
}

export interface Segment {
  text: string;
  style?: SegmentStyle;
}

/** A styled run after text wrapping. Same shape as Segment, named for clarity in layout. */
export type StyledRun = { text: string; style?: SegmentStyle };

export type WrappedLine = StyledRun[];

export interface LayoutResult {
  x: number;
  y: number;
  width: number;
  height: number;
  wrappedLines?: WrappedLine[];
  hangingIndent?: number;
  /** Per-line text alignment inherited from parent's alignItems. */
  textAlign?: 'left' | 'center' | 'right';
}

export interface TNode {
  type: 'root' | 'box' | 'text' | 'divider' | 'raw-ansi';
  props: Record<string, any>;
  children: TNode[];
  parent: TNode | null;
  text: string | null;
  layout: LayoutResult | null;
  flexNode?: FlexNode;
  _dirty?: boolean;
  _childWasDetached?: boolean;
  _prevBounds?: { x: number; y: number; width: number; height: number } | null;
  _wrapCache?: {
    width: number;
    wrappedLines: WrappedLine[];
    hangingIndent?: number;
  } | null;
}

export function createNode(
  type: TNode['type'],
  props: Record<string, any> = {},
  flexNode?: FlexNode,
): TNode {
  return {
    type,
    props,
    children: [],
    parent: null,
    text: null,
    layout: null,
    flexNode,
  };
}

export function appendChild(parent: TNode, child: TNode): void {
  if (child.parent) {
    removeChild(child.parent, child);
  }
  child.parent = parent;
  parent.children.push(child);
  if (parent.flexNode && child.flexNode) {
    parent.flexNode.insertChild(child.flexNode, parent.children.length - 1);
  }
}

export function removeChild(parent: TNode, child: TNode): void {
  if (parent.flexNode && child.flexNode) {
    parent.flexNode.removeChild(child.flexNode);
  }
  const index = parent.children.indexOf(child);
  if (index >= 0) {
    parent.children.splice(index, 1);
  }
  child.parent = null;
}

export function insertBefore(
  parent: TNode,
  child: TNode,
  before: TNode,
): void {
  if (child.parent) {
    removeChild(child.parent, child);
  }
  child.parent = parent;
  const index = parent.children.indexOf(before);
  if (index >= 0) {
    parent.children.splice(index, 0, child);
    if (parent.flexNode && child.flexNode) {
      parent.flexNode.insertChild(child.flexNode, index);
    }
  } else {
    parent.children.push(child);
    if (parent.flexNode && child.flexNode) {
      parent.flexNode.insertChild(child.flexNode, parent.children.length - 1);
    }
  }
}
