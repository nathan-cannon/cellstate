import type { TNode, Segment, WrappedLine, StyledRun } from './nodes.js';

function truncateText(
  text: string,
  width: number,
  mode: string,
): string {
  if (text.length <= width) return text;

  const ellipsis = '\u2026';
  const availWidth = width - 1; // reserve space for ellipsis

  if (availWidth <= 0) return ellipsis.slice(0, width);

  switch (mode) {
    case 'truncate':
    case 'truncate-end':
      return text.slice(0, availWidth) + ellipsis;
    case 'truncate-start':
      return ellipsis + text.slice(text.length - availWidth);
    case 'truncate-middle': {
      const half = Math.floor(availWidth / 2);
      const endLen = availWidth - half;
      return text.slice(0, half) + ellipsis + text.slice(text.length - endLen);
    }
    default:
      return text;
  }
}

/**
 * Wrap a single line of text (no \n characters) at the given width.
 * First wrapped line uses full width; continuation lines use width - hangingIndent.
 */
function wrapSingleLine(
  text: string,
  width: number,
  hangingIndent?: number,
): string[] {
  const indent = hangingIndent ?? 0;
  const lines: string[] = [];
  let remaining = text;
  let isFirstLine = true;

  while (remaining.length > 0) {
    const lineWidth = isFirstLine ? width : Math.max(width - indent, 1);

    if (remaining.length <= lineWidth) {
      lines.push(remaining);
      break;
    }

    // Find last space at or before lineWidth (space at lineWidth can be consumed as break)
    let breakAt = -1;
    const searchEnd = Math.min(lineWidth, remaining.length - 1);
    for (let i = searchEnd; i >= 0; i--) {
      if (remaining[i] === ' ') {
        breakAt = i;
        break;
      }
    }

    if (breakAt === -1) {
      // Hard break mid-word
      lines.push(remaining.slice(0, lineWidth));
      remaining = remaining.slice(lineWidth);
    } else {
      lines.push(remaining.slice(0, breakAt));
      // Consume the space at break point
      remaining = remaining.slice(breakAt + 1);
    }

    isFirstLine = false;
  }

  return lines;
}

/**
 * Wrap text into lines at the given width.
 * Embedded \n characters produce forced line breaks; each segment between
 * \n characters is wrapped independently. Empty segments between two \n
 * characters produce a blank line. Continuation lines within each hard
 * line are indented by hangingIndent.
 */
export function wrapText(
  text: string,
  width: number,
  hangingIndent?: number,
): string[] {
  if (width <= 0 || !text) return [];

  // Split on embedded newlines — each becomes a forced line break
  const hardLines = text.split('\n');
  const result: string[] = [];

  for (const hardLine of hardLines) {
    if (hardLine.length === 0) {
      // Empty segment between newlines — preserve as blank line
      result.push('');
      continue;
    }
    // Each hard line starts fresh: first wrapped sub-line gets no indent,
    // continuation sub-lines get hangingIndent (same rule as the single-line case).
    result.push(...wrapSingleLine(hardLine, width, hangingIndent));
  }

  return result;
}

/**
 * Wrap segments into styled lines. Uses wrapText for break-point calculation
 * on the concatenated plain text, then slices segments at those break points.
 */
function wrapSegments(
  segments: Segment[],
  width: number,
  hangingIndent?: number,
): WrappedLine[] {
  const filtered = segments.filter(s => s.text.length > 0);
  if (filtered.length === 0 || width <= 0) return [];

  const concat = filtered.map(s => s.text).join('');
  if (!concat) return [];

  // Compute segment boundaries in the concatenated string
  const bounds: { start: number; end: number; idx: number }[] = [];
  let offset = 0;
  for (let i = 0; i < filtered.length; i++) {
    const len = filtered[i]!.text.length;
    bounds.push({ start: offset, end: offset + len, idx: i });
    offset += len;
  }

  // Get plain wrapped lines for break-point calculation
  const plainLines = wrapText(concat, width, hangingIndent);
  if (plainLines.length === 0) return [];

  // Map each plain line back to styled runs
  const result: WrappedLine[] = [];
  let globalOffset = 0;

  for (let li = 0; li < plainLines.length; li++) {
    const line = plainLines[li]!;
    const lineStart = globalOffset;
    const lineEnd = lineStart + line.length;

    const runs: StyledRun[] = [];

    for (const b of bounds) {
      if (b.end <= lineStart) continue;
      if (b.start >= lineEnd) break;

      const runStart = Math.max(b.start, lineStart);
      const runEnd = Math.min(b.end, lineEnd);
      const text = concat.slice(runStart, runEnd);
      if (text.length > 0) {
        const style = filtered[b.idx]!.style;
        runs.push(style ? { text, style } : { text });
      }
    }

    result.push(runs);

    // Advance past this line + possible consumed break character (space or \n)
    if (li < plainLines.length - 1) {
      if (lineEnd < concat.length && (concat[lineEnd] === ' ' || concat[lineEnd] === '\n')) {
        globalOffset = lineEnd + 1;
      } else {
        globalOffset = lineEnd;
      }
    }
  }

  return result;
}

/** Resolve all four margin sides from shorthand + individual overrides. */
function resolveMargins(node: TNode): { top: number; bottom: number; left: number; right: number } {
  const m = node.props.margin ?? 0;
  return {
    top: node.props.marginTop ?? m,
    bottom: node.props.marginBottom ?? m,
    left: node.props.marginLeft ?? m,
    right: node.props.marginRight ?? m,
  };
}

/** Compute the natural (content) width of a laid-out node. */
function naturalWidth(node: TNode): number {
  if (node.type === 'text' && node.layout?.wrappedLines) {
    let max = 0;
    for (const line of node.layout.wrappedLines) {
      let lineLen = 0;
      for (const run of line) lineLen += run.text.length;
      max = Math.max(max, lineLen);
    }
    return max;
  }
  return node.layout?.width ?? 0;
}

/** Recursively shift a node and all its descendants by dx on the x-axis. */
function shiftNodeX(node: TNode, dx: number): void {
  if (!node.layout) return;
  node.layout.x += dx;
  for (const child of node.children) {
    shiftNodeX(child, dx);
  }
}

/** Recursively shift a node and all its descendants by dy on the y-axis. */
function shiftNodeY(node: TNode, dy: number): void {
  if (!node.layout) return;
  node.layout.y += dy;
  for (const child of node.children) {
    shiftNodeY(child, dy);
  }
}

/** Redistribute children along the main axis (column) when extra space exists. */
function applyJustifyContent(
  node: TNode,
  startY: number,
  contentHeight: number,
  containerHeight: number,
): void {
  const justify = node.props.justifyContent as string | undefined;
  if (!justify || justify === 'flex-start') return;

  const children = node.children.filter(c => c.layout && c.props.display !== 'none');
  if (children.length === 0) return;

  const extraSpace = containerHeight - contentHeight;
  if (extraSpace <= 0) return;

  let offset = 0;
  let gap = 0;

  switch (justify) {
    case 'flex-end':
      offset = extraSpace;
      break;
    case 'center':
      offset = Math.floor(extraSpace / 2);
      break;
    case 'space-between':
      if (children.length > 1) {
        gap = extraSpace / (children.length - 1);
      }
      break;
    case 'space-around': {
      const space = extraSpace / children.length;
      offset = Math.floor(space / 2);
      gap = space;
      break;
    }
    case 'space-evenly': {
      const space = extraSpace / (children.length + 1);
      offset = Math.floor(space);
      gap = space;
      break;
    }
  }

  let cumulativeGap = 0;
  for (let i = 0; i < children.length; i++) {
    const shift = Math.floor(offset + cumulativeGap);
    if (shift !== 0) {
      shiftNodeY(children[i]!, shift);
    }
    cumulativeGap += gap;
  }
}

/** Redistribute children along the main axis (row) when extra space exists. */
function applyJustifyContentRow(
  node: TNode,
  startX: number,
  contentWidth: number,
  containerWidth: number,
): void {
  const justify = node.props.justifyContent as string | undefined;
  if (!justify || justify === 'flex-start') return;

  const children = node.children.filter(c => c.layout && c.props.display !== 'none');
  if (children.length === 0) return;

  const extraSpace = containerWidth - contentWidth;
  if (extraSpace <= 0) return;

  let offset = 0;
  let gap = 0;

  switch (justify) {
    case 'flex-end':
      offset = extraSpace;
      break;
    case 'center':
      offset = Math.floor(extraSpace / 2);
      break;
    case 'space-between':
      if (children.length > 1) {
        gap = extraSpace / (children.length - 1);
      }
      break;
    case 'space-around': {
      const space = extraSpace / children.length;
      offset = Math.floor(space / 2);
      gap = space;
      break;
    }
    case 'space-evenly': {
      const space = extraSpace / (children.length + 1);
      offset = Math.floor(space);
      gap = space;
      break;
    }
  }

  let cumulativeGap = 0;
  for (let i = 0; i < children.length; i++) {
    const shift = Math.floor(offset + cumulativeGap);
    if (shift !== 0) {
      shiftNodeX(children[i]!, shift);
    }
    cumulativeGap += gap;
  }
}

/** Apply alignItems offset to a child after it has been laid out. */
function applyAlignment(
  align: string | undefined,
  child: TNode,
  childWidth: number,
): void {
  if (!align || align === 'stretch' || align === 'flex-start') return;

  // Text nodes: store alignment mode in layout for per-line centering by the rasterizer
  if (child.type === 'text' && child.layout) {
    child.layout.textAlign = align === 'center' ? 'center' : 'right';
    return;
  }

  // Box nodes: block-shift the entire subtree
  const nw = naturalWidth(child);
  const slack = childWidth - nw;
  if (slack <= 0) return;

  const dx = align === 'center' ? Math.floor(slack / 2) : slack; // flex-end
  shiftNodeX(child, dx);
}

/** Clear all layout fields in the tree before computing. */
function clearLayout(node: TNode): void {
  node.layout = null;
  for (const child of node.children) {
    clearLayout(child);
  }
}

/** Get the text content from a text node (may be on the node or a text-instance child). */
function getTextContent(node: TNode): string {
  if (node.text !== null) return node.text;
  // Text element's string content lives in a text-instance child
  for (const child of node.children) {
    if (child.text !== null) return child.text;
  }
  return '';
}

/**
 * Compute layout for the entire tree.
 * Mutates each node's `layout` field in place.
 * All children are laid out in normal document flow.
 */
export function layout(
  root: TNode,
  termWidth: number,
  _termHeight: number,
): void {
  clearLayout(root);

  root.layout = { x: 0, y: 0, width: termWidth, height: 0 };

  layoutChildrenList(root.children, root, 0, 0, termWidth);

  root.layout.height = computeChildrenHeightFromList(root.children, 0);
}

/**
 * Returns the total vertical space the content occupies after layout.
 */
export function contentHeight(root: TNode): number {
  if (!root.layout) return 0;
  return root.layout.height;
}

function layoutChildren(
  node: TNode,
  startX: number,
  startY: number,
  availableWidth: number,
): void {
  const flexDirection = node.props.flexDirection ?? 'column';

  if (flexDirection === 'row') {
    layoutRow(node, startX, startY, availableWidth);
  } else {
    layoutColumn(node, startX, startY, availableWidth);
  }
}

/** Layout an arbitrary list of children as a column (used for root's normal children). */
function layoutChildrenList(
  children: TNode[],
  parent: TNode,
  startX: number,
  startY: number,
  availableWidth: number,
): void {
  const gap = parent.props.gap ?? 0;
  const align = parent.props.alignItems as string | undefined;
  let y = startY;

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const margin = resolveMargins(child);
    y += margin.top;

    const childX = startX + margin.left;
    const childWidth = Math.max(availableWidth - margin.left - margin.right, 0);
    layoutNode(child, childX, y, childWidth);
    applyAlignment(align, child, childWidth);

    y += child.layout!.height + margin.bottom;
    if (i < children.length - 1) {
      y += gap;
    }
  }

  if (parent.props.height != null) {
    const border = parent.props.borderStyle ? 1 : 0;
    const pad = parent.props.padding ?? 0;
    const paddingTop = (parent.props.paddingTop ?? pad) + border;
    const paddingBottom = (parent.props.paddingBottom ?? pad) + border;
    const childrenHeight = computeChildrenHeightFromList(children, startY);
    applyJustifyContent(parent, startY, childrenHeight, parent.props.height - paddingTop - paddingBottom);
  }
}

/** Compute height from an arbitrary list of children (used for root's normal children). */
function computeChildrenHeightFromList(children: TNode[], startY: number): number {
  if (children.length === 0) return 0;

  let maxBottom = startY;
  for (const child of children) {
    if (child.layout) {
      const margin = resolveMargins(child);
      maxBottom = Math.max(maxBottom, child.layout.y + child.layout.height + margin.bottom);
    }
  }
  return maxBottom - startY;
}

function layoutColumn(
  node: TNode,
  startX: number,
  startY: number,
  availableWidth: number,
): void {
  const gap = node.props.gap ?? 0;
  const align = node.props.alignItems as string | undefined;
  let y = startY;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    const margin = resolveMargins(child);
    y += margin.top;

    const childX = startX + margin.left;
    const childWidth = Math.max(availableWidth - margin.left - margin.right, 0);
    layoutNode(child, childX, y, childWidth);
    applyAlignment(align, child, childWidth);

    y += child.layout!.height + margin.bottom;
    if (i < node.children.length - 1) {
      y += gap;
    }
  }

  if (node.props.height != null) {
    const border = node.props.borderStyle ? 1 : 0;
    const pad = node.props.padding ?? 0;
    const paddingTop = (node.props.paddingTop ?? pad) + border;
    const paddingBottom = (node.props.paddingBottom ?? pad) + border;
    const childrenHeight = computeChildrenHeight(node, startY);
    applyJustifyContent(node, startY, childrenHeight, node.props.height - paddingTop - paddingBottom);
  }
}

function layoutRow(
  node: TNode,
  startX: number,
  startY: number,
  availableWidth: number,
): void {
  const children = node.children;

  // Calculate fixed width consumption (including horizontal margins) and count fill children
  let fixedTotal = 0;
  let fillCount = 0;

  for (const child of children) {
    const margin = resolveMargins(child);
    const hMargin = margin.left + margin.right;
    if (child.props.width != null) {
      fixedTotal += Math.min(child.props.width, availableWidth) + hMargin;
    } else if (child.props.flexGrow) {
      fixedTotal += hMargin;
      fillCount++;
    } else {
      // Shrink-to-content: contributes 0 for boxes, need to compute for text
      // For now treat as 0 (spec says this case doesn't arise in practice)
      fixedTotal += hMargin;
    }
  }

  const remainingWidth = Math.max(availableWidth - fixedTotal, 0);
  const fillWidth = fillCount > 0 ? Math.floor(remainingWidth / fillCount) : 0;
  const fillRemainder = fillCount > 0 ? remainingWidth % fillCount : 0;

  let x = startX;
  let fillIndex = 0;
  let maxHeight = 0;

  for (const child of children) {
    const margin = resolveMargins(child);
    x += margin.left;
    let childWidth: number;

    if (child.props.width != null) {
      childWidth = Math.min(child.props.width, availableWidth);
    } else if (child.props.flexGrow) {
      childWidth = fillWidth;
      // First fill child gets the remainder from odd division
      if (fillIndex === 0) {
        childWidth += fillRemainder;
      }
      fillIndex++;
    } else {
      childWidth = 0;
    }

    childWidth = Math.max(childWidth, 0);
    layoutNode(child, x, startY, childWidth);

    x += childWidth + margin.right;
    maxHeight = Math.max(maxHeight, child.layout!.height);
  }

  // Set row children heights are already set; update parent awareness of row height
  // The parent reads child.layout.height, which is set by layoutNode

  // justifyContent along the x-axis for rows
  const usedWidth = x - startX;
  applyJustifyContentRow(node, startX, usedWidth, availableWidth);
}

function layoutNode(
  node: TNode,
  x: number,
  y: number,
  availableWidth: number,
): void {
  if (node.props.display === 'none') {
    node.layout = { x: 0, y: 0, width: 0, height: 0 };
    return;
  }

  if (node.type === 'divider') {
    node.layout = { x, y, width: availableWidth, height: 1 };
    return;
  }

  if (node.type === 'text') {
    layoutTextNode(node, x, y, availableWidth);
    return;
  }

  // Box node
  const border = node.props.borderStyle ? 1 : 0;
  const pad = node.props.padding ?? 0;
  const paddingLeft = (node.props.paddingLeft ?? pad) + border;
  const paddingRight = (node.props.paddingRight ?? pad) + border;
  const paddingTop = (node.props.paddingTop ?? pad) + border;
  const paddingBottom = (node.props.paddingBottom ?? pad) + border;
  const nodeWidth = Math.min(node.props.width ?? availableWidth, availableWidth);
  const contentWidth = Math.max(nodeWidth - paddingLeft - paddingRight, 0);
  const contentX = x + paddingLeft;
  const contentY = y + paddingTop;

  node.layout = { x, y, width: nodeWidth, height: 0 };

  layoutChildren(node, contentX, contentY, contentWidth);

  // Compute height from children
  node.layout.height = computeChildrenHeight(node, contentY) + paddingTop + paddingBottom;

  // Fixed height overrides computed height
  if (node.props.height != null) {
    node.layout.height = Math.max(node.props.height, 0);
  }
}

function layoutTextNode(
  node: TNode,
  x: number,
  y: number,
  availableWidth: number,
): void {
  if (node.props.display === 'none') {
    node.layout = { x: 0, y: 0, width: 0, height: 0 };
    return;
  }

  const hangingIndent = node.props.hangingIndent as number | undefined;
  const segments = node.props.segments as Segment[] | undefined;

  if (segments) {
    let wrappedLines = wrapSegments(segments, availableWidth, hangingIndent);
    const wrapMode = node.props.wrap ?? 'wrap';
    if (wrapMode !== 'wrap' && wrappedLines.length > 1) {
      // Truncation collapses segments into plain text, losing per-segment styles.
      // Acceptable for v1 — truncated text is typically short (file paths, labels).
      const fullText = wrappedLines.map(line =>
        line.map(run => run.text).join('')
      ).join(' ');
      const truncated = truncateText(fullText, availableWidth, wrapMode);
      wrappedLines = [[{ text: truncated }]];
    }
    node.layout = {
      x,
      y,
      width: availableWidth,
      height: wrappedLines.length,
      wrappedLines,
      hangingIndent: hangingIndent ?? undefined,
    };
    return;
  }

  const content = getTextContent(node);

  if (!content || availableWidth <= 0) {
    node.layout = {
      x,
      y,
      width: availableWidth,
      height: 0,
      wrappedLines: [],
      hangingIndent: hangingIndent ?? undefined,
    };
    return;
  }

  const lines = wrapText(content, availableWidth, hangingIndent);
  let wrappedLines: WrappedLine[] = lines.map(line => [{ text: line }]);
  const wrapMode = node.props.wrap ?? 'wrap';
  if (wrapMode !== 'wrap' && wrappedLines.length > 1) {
    const fullText = wrappedLines.map(line =>
      line.map(run => run.text).join('')
    ).join(' ');
    const truncated = truncateText(fullText, availableWidth, wrapMode);
    wrappedLines = [[{ text: truncated }]];
  }
  node.layout = {
    x,
    y,
    width: availableWidth,
    height: wrappedLines.length,
    wrappedLines,
    hangingIndent: hangingIndent ?? undefined,
  };
}

function computeChildrenHeight(node: TNode, startY: number): number {
  if (node.children.length === 0) return 0;

  const flexDirection = node.props.flexDirection ?? 'column';

  if (flexDirection === 'row') {
    let maxHeight = 0;
    for (const child of node.children) {
      if (child.layout) {
        maxHeight = Math.max(maxHeight, child.layout.height);
      }
    }
    return maxHeight;
  }

  // Column: height = bottom of last child (including marginBottom) - startY
  let maxBottom = startY;
  for (const child of node.children) {
    if (child.layout) {
      const margin = resolveMargins(child);
      maxBottom = Math.max(maxBottom, child.layout.y + child.layout.height + margin.bottom);
    }
  }
  return maxBottom - startY;
}
