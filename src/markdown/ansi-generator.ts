/**
 * ANSI line generator — converts parsed markdown blocks into wrapped ANSI strings.
 *
 * Each output line is exactly one terminal row with inline SGR escapes.
 * The caller provides a target width; text is soft-wrapped to that width.
 *
 * Uses chalk for SGR generation so output respects the terminal's color level.
 */
import { stringDisplayWidth } from '../core/width.js';
import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import { highlightCode } from './highlighter.js';

// ── Markdown block types ──

export interface MarkdownBlock {
  type: 'paragraph' | 'heading' | 'code' | 'blockquote' | 'list' | 'thematic_break' | 'table' | 'html' | 'space';
  raw: string;         // Original markdown source for this block
  rawLength: number;   // Byte length in the original document
  // Type-specific fields:
  depth?: number;      // heading depth (1-6)
  lang?: string;       // code block language
  code?: string;       // code block content (without fences)
  ordered?: boolean;   // list ordered vs unordered
  start?: number;      // ordered list start number
  items?: string[];    // list item texts
  children?: MarkdownBlock[]; // blockquote children
  rows?: string[][];   // table rows (first row = header)
}

// ── Remark parser (lazy singleton) ──

let remarkProcessor: { parse(source: string): Root } | null = null;

function getRemarkProcessor(): { parse(source: string): Root } {
  if (!remarkProcessor) {
    remarkProcessor = unified().use(remarkParse).use(remarkGfm);
  }
  return remarkProcessor;
}

// ── Main entry point ──

/**
 * Generate wrapped ANSI lines from markdown blocks.
 *
 * @param blocks Parsed markdown block list
 * @param width Target terminal width
 * @returns Array of ANSI-escaped strings, one per terminal row
 */
export function generateAnsiLines(
  blocks: MarkdownBlock[],
  width: number,
): string[] {
  const result: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    // Add blank line between blocks (matching gap={1} behavior)
    if (i > 0 && block.type !== 'space') {
      result.push('');
    }

    switch (block.type) {
      case 'paragraph':
        result.push(...renderParagraph(block.raw, width));
        break;
      case 'heading':
        result.push(...renderHeading(block.raw, block.depth ?? 1, width));
        break;
      case 'code':
        result.push(...renderCodeBlock(block.code ?? '', block.lang, width));
        break;
      case 'blockquote':
        result.push(...renderBlockquote(block.children ?? [], width));
        break;
      case 'list':
        result.push(...renderList(block.items ?? [], block.ordered ?? false, block.start ?? 1, width));
        break;
      case 'thematic_break':
        result.push(renderThematicBreak(width));
        break;
      case 'table':
        result.push(...renderTable(block.rows ?? [], width));
        break;
      case 'html':
        result.push(...wrapAnsiText(block.raw, width));
        break;
      case 'space':
        // Skip — spacing handled by gap between blocks
        break;
    }
  }

  return result;
}

// ── Block renderers ──

function renderParagraph(text: string, width: number): string[] {
  const inlineStyled = applyInlineStyles(text.trim());
  return wrapAnsiText(inlineStyled, width);
}

function renderHeading(text: string, depth: number, width: number): string[] {
  // Strip heading markers (# chars)
  const content = text.replace(/^#{1,6}\s*/, '').trim();
  const styled = chalk.bold(applyInlineStyles(content));
  return wrapAnsiText(styled, width);
}

function renderCodeBlock(
  code: string,
  lang: string | undefined,
  width: number,
): string[] {
  const indent = '  '; // paddingLeft: 2
  const innerWidth = Math.max(width - 2, 1);
  let highlighted: string[];

  if (lang) {
    try {
      highlighted = highlightCode(code, lang);
    } catch {
      highlighted = code.split('\n');
    }
  } else {
    highlighted = code.split('\n');
  }

  const result: string[] = [];
  for (const line of highlighted) {
    const wrapped = wrapAnsiText(line, innerWidth);
    for (const w of wrapped) {
      result.push(indent + w);
    }
  }
  return result;
}

function renderBlockquote(children: MarkdownBlock[], width: number): string[] {
  const prefix = chalk.dim('│ ');
  const innerWidth = Math.max(width - 2, 1);
  const innerLines = generateAnsiLines(children, innerWidth);
  return innerLines.map(line => prefix + line);
}

function renderList(
  items: string[],
  ordered: boolean,
  start: number,
  width: number,
): string[] {
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const prefix = ordered ? `${start + i}. ` : '• ';
    const prefixLen = stringDisplayWidth(prefix);
    const innerWidth = Math.max(width - prefixLen, 1);
    const content = applyInlineStyles(items[i]!.trim());
    const wrapped = wrapAnsiText(content, innerWidth);
    for (let j = 0; j < wrapped.length; j++) {
      const pfx = j === 0 ? prefix : ' '.repeat(prefixLen);
      result.push(pfx + wrapped[j]!);
    }
  }
  return result;
}

function renderThematicBreak(width: number): string {
  const dashes = '─'.repeat(Math.min(width, 80));
  return chalk.dim(dashes);
}

function renderTable(rows: string[][], width: number): string[] {
  if (rows.length === 0) return [];

  // Compute column widths
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const w = stringDisplayWidth(row[c]!.trim());
      if (w > colWidths[c]!) colWidths[c] = w;
    }
  }

  // Clamp total to width (shrink proportionally if needed)
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + (colCount - 1) * 3 + 4; // │ + spaces
  if (totalWidth > width) {
    const scale = (width - (colCount - 1) * 3 - 4) / colWidths.reduce((a, b) => a + b, 0);
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(Math.floor(colWidths[c]! * scale), 1);
    }
  }

  const result: string[] = [];
  const separator = chalk.dim('├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤');
  const topBorder = chalk.dim('┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
  const bottomBorder = chalk.dim('└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');

  result.push(topBorder);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    let line = chalk.dim('│');
    for (let c = 0; c < colCount; c++) {
      const cell = (row[c] ?? '').trim();
      const cellWidth = stringDisplayWidth(cell);
      const pad = Math.max(colWidths[c]! - cellWidth, 0);
      const styled = r === 0 ? chalk.bold(cell) : cell;
      line += ' ' + styled + ' '.repeat(pad + 1) + chalk.dim('│');
    }
    result.push(line);

    // Separator after header
    if (r === 0 && rows.length > 1) {
      result.push(separator);
    }
  }

  result.push(bottomBorder);
  return result;
}

// ── Inline markdown styling ──

/**
 * Apply inline markdown styles (bold, italic, code, strikethrough, links)
 * to a text string, producing ANSI SGR escapes via chalk.
 */
function applyInlineStyles(text: string): string {
  let result = text;

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_, p1) => chalk.bold(p1));
  result = result.replace(/__(.+?)__/g, (_, p1) => chalk.bold(p1));

  // Italic: *text* or _text_ (not inside bold markers)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, p1) => chalk.italic(p1));
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, p1) => chalk.italic(p1));

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, (_, p1) => chalk.strikethrough(p1));

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, (_, p1) => chalk.dim(p1));

  // Links: [text](url) → underlined text + dim url
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    (_, p1, p2) => chalk.underline(p1) + ' ' + chalk.dim(`(${p2})`));

  return result;
}

// ── Text wrapping with ANSI awareness ──

/**
 * Wrap an ANSI-styled string to the given width.
 * Handles SGR escape sequences correctly — carries open styles across
 * line breaks so continuation lines maintain the correct styling.
 */
export function wrapAnsiText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const wrapped = wrapAnsi(text, width, { hard: true, trim: true });
  return wrapped.split('\n');
}

// ── Markdown block parser (remark mdast → MarkdownBlock[]) ──

/**
 * Parse a markdown string into MarkdownBlock objects using remark.
 */
export function parseMarkdownToBlocks(source: string): MarkdownBlock[] {
  const processor = getRemarkProcessor();
  const tree = processor.parse(source);
  return mdastToBlocks(tree, source);
}

/**
 * Convert a remark AST into MarkdownBlock objects.
 */
function mdastToBlocks(root: Root, source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const node of root.children) {
    const block = mdastNodeToBlock(node, source);
    if (block) blocks.push(block);
  }
  return blocks;
}

function mdastNodeToBlock(node: RootContent, source: string): MarkdownBlock | null {
  const pos = node.position;
  const startOffset = pos?.start.offset ?? 0;
  const endOffset = pos?.end.offset ?? 0;
  const raw = source.substring(startOffset, endOffset);
  const rawLength = endOffset - startOffset;

  switch (node.type) {
    case 'heading':
      return {
        type: 'heading',
        raw,
        rawLength,
        depth: node.depth,
      };

    case 'paragraph':
      return {
        type: 'paragraph',
        raw,
        rawLength,
      };

    case 'code':
      return {
        type: 'code',
        raw,
        rawLength,
        lang: node.lang || undefined,
        code: node.value,
      };

    case 'blockquote': {
      const children: MarkdownBlock[] = [];
      for (const child of node.children) {
        const childBlock = mdastNodeToBlock(child as RootContent, source);
        if (childBlock) children.push(childBlock);
      }
      return {
        type: 'blockquote',
        raw,
        rawLength,
        children,
      };
    }

    case 'list': {
      const items: string[] = [];
      for (const item of node.children) {
        // Extract text content from list item's children
        let itemText = '';
        for (const child of item.children) {
          if (child.position) {
            itemText += source.substring(child.position.start.offset!, child.position.end.offset!);
          }
        }
        items.push(itemText);
      }
      return {
        type: 'list',
        raw,
        rawLength,
        ordered: node.ordered ?? false,
        start: node.start ?? 1,
        items,
      };
    }

    case 'thematicBreak':
      return {
        type: 'thematic_break',
        raw,
        rawLength,
      };

    case 'table': {
      const rows: string[][] = [];
      for (const row of node.children) {
        const cells: string[] = [];
        for (const cell of row.children) {
          cells.push(phrasingToText(cell.children));
        }
        rows.push(cells);
      }
      return {
        type: 'table',
        raw,
        rawLength,
        rows,
      };
    }

    case 'html':
      return {
        type: 'html',
        raw: node.value,
        rawLength,
      };

    default:
      if (raw.trim()) {
        return {
          type: 'paragraph',
          raw: raw.trim(),
          rawLength,
        };
      }
      return null;
  }
}

/** Extract plain text from phrasing (inline) content nodes. */
function phrasingToText(nodes: PhrasingContent[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      text += node.value;
    } else if (node.type === 'inlineCode') {
      text += node.value;
    } else if ('children' in node) {
      text += phrasingToText(node.children as PhrasingContent[]);
    } else if ('value' in node) {
      text += (node as any).value;
    }
  }
  return text;
}

// ── Legacy API ──

/**
 * @deprecated Use parseMarkdownToBlocks() instead. Kept for backward compatibility.
 * Parses markdown source into blocks using remark (ignores the tree parameter).
 */
export function astToBlocks(_tree: unknown, source: string): MarkdownBlock[] {
  return parseMarkdownToBlocks(source);
}
