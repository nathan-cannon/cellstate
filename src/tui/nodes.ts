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
  type: 'root' | 'box' | 'text' | 'divider';
  props: Record<string, any>;
  children: TNode[];
  parent: TNode | null;
  text: string | null;
  layout: LayoutResult | null;
}

export function createNode(
  type: TNode['type'],
  props: Record<string, any> = {},
): TNode {
  return {
    type,
    props,
    children: [],
    parent: null,
    text: null,
    layout: null,
  };
}

export function appendChild(parent: TNode, child: TNode): void {
  if (child.parent) {
    removeChild(child.parent, child);
  }
  child.parent = parent;
  parent.children.push(child);
}

export function removeChild(parent: TNode, child: TNode): void {
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
  } else {
    parent.children.push(child);
  }
}
