/**
 * Text wrapping and truncation utilities.
 * All measurements are in terminal columns (display width), not string length.
 */
import type { Segment, WrappedLine, StyledRun } from './nodes.js';
import { stringDisplayWidth, sliceToWidth, sliceFromEndToWidth, charDisplayWidth, isTextPresentationEmoji, isSkinToneModifier, isRegionalIndicator } from './width.js';
import type { Perf } from './perf.js';

export function truncateText(
  text: string,
  width: number,
  mode: string,
  perf?: Perf,
): string {
  if (perf) {
    perf.count('truncateTextCalls');
    perf.timeStart('truncateText');
    perf.count('stringDisplayWidthCalls');
  }
  if (stringDisplayWidth(text) <= width) {
    if (perf) perf.timeEnd('truncateText');
    return text;
  }

  const ellipsis = '\u2026';
  const availWidth = width - 1; // reserve space for ellipsis

  if (availWidth <= 0) {
    if (perf) perf.timeEnd('truncateText');
    return ellipsis.slice(0, width);
  }

  let result: string;
  switch (mode) {
    case 'truncate':
    case 'truncate-end':
      if (perf) perf.count('sliceToWidthCalls');
      result = sliceToWidth(text, availWidth) + ellipsis;
      break;
    case 'truncate-start':
      if (perf) perf.count('sliceFromEndToWidthCalls');
      result = ellipsis + sliceFromEndToWidth(text, availWidth);
      break;
    case 'truncate-middle': {
      const half = Math.floor(availWidth / 2);
      const endLen = availWidth - half;
      if (perf) {
        perf.count('sliceToWidthCalls');
        perf.count('sliceFromEndToWidthCalls');
      }
      result = sliceToWidth(text, half) + ellipsis + sliceFromEndToWidth(text, endLen);
      break;
    }
    default:
      result = text;
  }
  if (perf) perf.timeEnd('truncateText');
  return result;
}

/**
 * Wrap a single line of text (no \n characters) at the given width.
 * First wrapped line uses full width; continuation lines use width - hangingIndent.
 */
function wrapSingleLine(
  text: string,
  width: number,
  hangingIndent?: number,
  perf?: Perf,
): string[] {
  if (perf) {
    perf.count('wrapSingleLineCalls');
    perf.timeStart('wrapSingleLine');
  }
  const indent = hangingIndent ?? 0;
  const lines: string[] = [];
  let remaining = text;
  let isFirstLine = true;

  while (remaining.length > 0) {
    const lineWidth = isFirstLine ? width : Math.max(width - indent, 1);

    if (perf) perf.count('stringDisplayWidthCalls');
    if (stringDisplayWidth(remaining) <= lineWidth) {
      lines.push(remaining);
      break;
    }

    let cols = 0;
    let overflowStrIdx = 0;
    let prevCp: number | null = null;
    let prevStrIdx = 0;
    let prevWasZWJ = false;
    let prevWasRI = false;
    let clusterStartStrIdx = 0;
    for (const ch of remaining) {
      const cp = ch.codePointAt(0)!;
      let w = charDisplayWidth(cp);
      let partOfCluster = false;
      // VS16 after a width-1 text-presentation emoji upgrades it to width 2
      if (cp === 0xfe0f && prevCp !== null && charDisplayWidth(prevCp) === 1 && isTextPresentationEmoji(prevCp)) {
        w = 1;
        partOfCluster = true;
        if (perf) perf.count('vs16Upgrades');
        if (cols + w > lineWidth) {
          // VS16 upgrade overflows, break before the base character
          overflowStrIdx = clusterStartStrIdx;
          break;
        }
      } else if (isSkinToneModifier(cp) && prevCp !== null && charDisplayWidth(prevCp) === 2) {
        w = 0;
        partOfCluster = true;
        if (perf) perf.count('skinToneJoins');
      } else if (isRegionalIndicator(cp) && prevWasRI) {
        w = 0;
        partOfCluster = true;
        if (perf) perf.count('regionalIndicatorJoins');
      } else if (prevWasZWJ && w === 2) {
        w = 0;
        partOfCluster = true;
        if (perf) perf.count('zwjJoins');
      }
      if (cols + w > lineWidth) {
        if (partOfCluster) {
          // Cluster overflows — break before the entire cluster
          overflowStrIdx = clusterStartStrIdx;
        }
        break;
      }
      if (!partOfCluster) {
        clusterStartStrIdx = overflowStrIdx;
      }
      prevStrIdx = overflowStrIdx;
      cols += w;
      overflowStrIdx += ch.length;
      prevWasZWJ = cp === 0x200d;
      prevWasRI = isRegionalIndicator(cp) && !partOfCluster;
      prevCp = cp;
    }

    // Guard: first character is wider than the line (e.g. CJK char with lineWidth=1)
    if (overflowStrIdx === 0) {
      // Push it anyway. Visually overflows by one column, but avoids infinite loop.
      const firstChar = [...remaining][0]!;
      lines.push(firstChar);
      remaining = remaining.slice(firstChar.length);
      isFirstLine = false;
      continue;
    }

    // Backward pass: scan for a space to break at (include overflowStrIdx;
    // a space there can be consumed as a break without contributing to line width)
    let breakAt = -1;
    for (let i = overflowStrIdx; i >= 0; i--) {
      if (remaining[i] === ' ') {
        breakAt = i;
        break;
      }
    }

    if (breakAt === -1) {
      // Hard break mid-word
      if (perf) perf.count('hardBreaks');
      lines.push(remaining.slice(0, overflowStrIdx));
      remaining = remaining.slice(overflowStrIdx);
    } else {
      if (perf) perf.count('spaceBreaks');
      lines.push(remaining.slice(0, breakAt));
      // Consume the space at break point
      remaining = remaining.slice(breakAt + 1);
    }

    isFirstLine = false;
  }

  if (perf) perf.timeEnd('wrapSingleLine');
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
  perf?: Perf,
): string[] {
  if (perf) {
    perf.count('wrapTextCalls');
    perf.timeStart('wrapText');
  }
  if (width <= 0 || !text) {
    if (perf) perf.timeEnd('wrapText');
    return [];
  }

  // Split on embedded newlines. Each becomes a forced line break.
  const hardLines = text.split('\n');
  const result: string[] = [];

  for (const hardLine of hardLines) {
    if (hardLine.length === 0) {
      // Empty segment between newlines, preserve as blank line
      result.push('');
      continue;
    }
    // Each hard line starts fresh: first wrapped sub-line gets no indent,
    // continuation sub-lines get hangingIndent (same rule as the single-line case).
    result.push(...wrapSingleLine(hardLine, width, hangingIndent, perf));
  }

  if (perf) {
    perf.count('wrappedLinesProduced', result.length);
    perf.timeEnd('wrapText');
  }
  return result;
}

/**
 * Wrap segments into styled lines. Uses wrapText for break-point calculation
 * on the concatenated plain text, then slices segments at those break points.
 */
export function wrapSegments(
  segments: Segment[],
  width: number,
  hangingIndent?: number,
  perf?: Perf,
): WrappedLine[] {
  if (perf) {
    perf.count('wrapSegmentsCalls');
    perf.timeStart('wrapSegments');
  }
  const filtered = segments.filter(s => s.text.length > 0);
  if (filtered.length === 0 || width <= 0) {
    if (perf) perf.timeEnd('wrapSegments');
    return [];
  }

  // --- Single-segment fast path ---
  if (filtered.length === 1) {
    const seg = filtered[0]!;
    const plainLines = wrapText(seg.text, width, hangingIndent, perf);
    if (plainLines.length === 0) {
      if (perf) perf.timeEnd('wrapSegments');
      return [];
    }
    const style = seg.style;
    const result: WrappedLine[] = [];
    for (let i = 0; i < plainLines.length; i++) {
      const text = plainLines[i]!;
      result.push(style ? [{ text, style }] : [{ text }]);
    }
    if (perf) perf.timeEnd('wrapSegments');
    return result;
  }

  const concat = filtered.map(s => s.text).join('');
  if (!concat) {
    if (perf) perf.timeEnd('wrapSegments');
    return [];
  }

  // --- No-wrap fast path ---
  if (!concat.includes('\n') && stringDisplayWidth(concat) <= width) {
    const runs: StyledRun[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const seg = filtered[i]!;
      const style = seg.style;
      runs.push(style ? { text: seg.text, style } : { text: seg.text });
    }
    if (perf) perf.timeEnd('wrapSegments');
    return [runs];
  }

  // Compute segment boundaries in the concatenated string
  const bounds: { start: number; end: number; idx: number }[] = [];
  let offset = 0;
  for (let i = 0; i < filtered.length; i++) {
    const len = filtered[i]!.text.length;
    bounds.push({ start: offset, end: offset + len, idx: i });
    offset += len;
  }

  // Get plain wrapped lines for break-point calculation
  const plainLines = wrapText(concat, width, hangingIndent, perf);
  if (plainLines.length === 0) {
    if (perf) perf.timeEnd('wrapSegments');
    return [];
  }

  // Map each plain line back to styled runs (advancing scan index)
  const result: WrappedLine[] = [];
  let globalOffset = 0;
  let scanStart = 0;

  for (let li = 0; li < plainLines.length; li++) {
    const line = plainLines[li]!;
    const lineStart = globalOffset;
    const lineEnd = lineStart + line.length;

    // Advance scanStart past bounds fully consumed by earlier lines
    while (scanStart < bounds.length && bounds[scanStart]!.end <= lineStart) {
      scanStart++;
    }

    const runs: StyledRun[] = [];

    for (let bi = scanStart; bi < bounds.length; bi++) {
      const b = bounds[bi]!;
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

  if (perf) perf.timeEnd('wrapSegments');
  return result;
}

