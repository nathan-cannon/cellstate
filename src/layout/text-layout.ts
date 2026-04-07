/**
 * Text sizing for Yoga's measure function. Wraps text content and caches the
 * result on the TNode so the rasterizer can read wrappedLines without re-wrapping.
 */
import type { TNode, Segment, WrappedLine } from '../core/nodes.js';
import { SizeConstraint } from './flex-node.js';
import { wrapText, wrapSegments, truncateText } from '../core/layout.js';
import { stringDisplayWidth } from '../core/width.js';

/** Get the text content from a text node (may be on the node or text-instance children). */
function getTextContent(node: TNode): string {
  if (node.text !== null) return node.text;
  let result = '';
  for (const child of node.children) {
    if (child.text !== null) result += child.text;
  }
  return result;
}

/** Compute the maximum display width across all wrapped lines. */
function maxLineWidth(lines: WrappedLine[]): number {
  let max = 0;
  for (const line of lines) {
    let w = 0;
    for (const run of line) {
      w += stringDisplayWidth(run.text);
    }
    if (w > max) max = w;
  }
  return max;
}

/**
 * Compute a text node's intrinsic size. Called by Yoga during calculateLayout.
 * Caches wrappedLines on node._wrapCache for the rasterizer.
 */
export function computeTextLayout(
  node: TNode,
  width: number,
  widthMode: SizeConstraint,
): { width: number; height: number } {
  const segments = node.props.segments as Segment[] | undefined;
  const hangingIndent = node.props.hangingIndent as number | undefined;
  const wrapMode = node.props.wrap ?? 'wrap';

  // Determine available width from the size constraint
  let availableWidth: number;
  switch (widthMode) {
    case SizeConstraint.Exact:
      availableWidth = width;
      break;
    case SizeConstraint.AtMost:
      availableWidth = width;
      break;
    case SizeConstraint.None:
      availableWidth = 10000;
      break;
  }

  if (availableWidth <= 0) {
    node._wrapCache = { width: availableWidth, wrappedLines: [], hangingIndent: hangingIndent ?? undefined };
    return { width: availableWidth, height: 0 };
  }

  let wrappedLines: WrappedLine[];

  if (segments) {
    wrappedLines = wrapSegments(segments, availableWidth, hangingIndent);
    if (wrapMode !== 'wrap' && wrappedLines.length > 1) {
      const fullText = wrappedLines
        .map(line => line.map(run => run.text).join(''))
        .join(' ');
      const truncated = truncateText(fullText, availableWidth, wrapMode);
      wrappedLines = [[{ text: truncated }]];
    }
  } else {
    const content = getTextContent(node);

    if (!content) {
      node._wrapCache = { width: availableWidth, wrappedLines: [], hangingIndent: hangingIndent ?? undefined };
      return { width: availableWidth, height: 0 };
    }

    const lines = wrapText(content, availableWidth, hangingIndent);
    wrappedLines = lines.map(line => [{ text: line }]);

    if (wrapMode !== 'wrap' && wrappedLines.length > 1) {
      const fullText = wrappedLines
        .map(line => line.map(run => run.text).join(''))
        .join(' ');
      const truncated = truncateText(fullText, availableWidth, wrapMode);
      wrappedLines = [[{ text: truncated }]];
    }
  }

  // For Exact mode, the width is fixed — return availableWidth.
  // For AtMost/None modes, return the actual content width so Yoga can
  // properly size containers (e.g. flexGrow distribution in rows).
  let resultWidth: number;
  if (widthMode === SizeConstraint.Exact) {
    resultWidth = availableWidth;
  } else {
    resultWidth = maxLineWidth(wrappedLines);
  }

  node._wrapCache = { width: availableWidth, wrappedLines, hangingIndent: hangingIndent ?? undefined };
  return { width: resultWidth, height: wrappedLines.length };
}
