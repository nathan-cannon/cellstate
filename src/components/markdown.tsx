/**
 * Markdown renderer with RawAnsi fast path.
 *
 * Parses markdown via remark, highlights code blocks via kreuzberg tree-sitter
 * language pack, generates ANSI strings, and renders through <raw-ansi> —
 * bypassing React reconciliation, Yoga layout, and segment wrapping for the
 * markdown content.
 */
import React, { useMemo, useRef } from 'react';
import { RawAnsi, Box } from './elements.js';
import { useDimensions } from '../hooks/use-dimensions.js';
import {
  type MarkdownBlock,
  generateAnsiLines,
  parseMarkdownToBlocks,
  wrapAnsiText,
} from '../markdown/ansi-generator.js';
import { BlockCache } from '../markdown/block-cache.js';

import { initTreeSitter, ensureLanguage } from '../markdown/tree-sitter-init.js';

// ── Plain text fast path ──

const MD_SYNTAX_RE = /[#*`|[\]>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

// ── Shared block cache ──

const globalBlockCache = new BlockCache(500);

// ── Types ──

export interface MarkdownProps {
  children: string;
  /** When false, process incrementally (warm cache) but don't render. */
  visible?: boolean;
  /** Override terminal width. If not provided, uses useDimensions(). */
  width?: number;
}

export interface StreamingMarkdownProps {
  children: string;
}

// ── XML tag stripping for streaming content ──

const XML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9_]*(?:\s[^>]*)?\s*\/?>/g;

function stripXMLTags(text: string): string {
  return text.replace(XML_TAG_RE, '');
}

// ── Markdown Component ──

/**
 * Renders markdown content through the remark + raw-ansi pipeline.
 * Uses useDimensions for width unless overridden via props.
 */
export function Markdown({ children, visible = true, width: widthOverride }: MarkdownProps): React.ReactNode {
  // Initialize tree-sitter language pack on first Markdown render (idempotent).
  initTreeSitter();

  const dims = useDimensions();
  const width = widthOverride ?? dims.cols;

  // Generate ANSI lines from markdown
  const lines = useMemo(() => {
    const text = children ?? '';
    if (!text.trim()) return [];

    // Plain text fast path — skip parse when no markdown syntax detected
    if (!hasMarkdownSyntax(text)) {
      return wrapAnsiText(text, width);
    }

    // Parse markdown to blocks using remark
    const blocks = parseMarkdownToBlocks(text);

    // Render blocks through cache
    const allLines: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.type === 'space') continue;

      if (allLines.length > 0) {
        allLines.push(''); // gap between blocks
      }

      const cacheKey = BlockCache.key(
        block.type,
        block.type === 'code' ? (block.code ?? '') : block.raw,
        width,
        block.lang,
      );
      // Download grammar before rendering so highlightCode() can use it
      if (block.type === 'code' && block.lang) {
        ensureLanguage(block.lang);
      }

      const cached = globalBlockCache.get(cacheKey);
      if (cached) {
        allLines.push(...cached);
        continue;
      }

      // Render this block
      const blockLines = generateAnsiLines([block], width);
      globalBlockCache.set(cacheKey, blockLines);
      allLines.push(...blockLines);
    }

    return allLines;
  }, [children, width]);

  if (!visible) return null;
  if (lines.length === 0) return null;

  return React.createElement(RawAnsi, { lines, rawWidth: width });
}

// ── StreamingMarkdown Component ──

/**
 * Streaming markdown renderer. Splits content at the last block boundary:
 * stable prefix is memoized (all cache hits), only the growing tail is re-parsed.
 */
export function StreamingMarkdown({ children }: StreamingMarkdownProps): React.ReactNode {
  const stripped = stripXMLTags(children ?? '');
  const stablePrefixRef = useRef('');

  // Reset if text was replaced (not an append)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  // Find the last block boundary in the new content
  const boundary = stablePrefixRef.current.length;
  const tail = stripped.substring(boundary);

  // Find the last double-newline (block boundary) in the tail
  // Everything before that is "stable" — it won't change as more tokens arrive
  const lastBlockBoundary = tail.lastIndexOf('\n\n');

  if (lastBlockBoundary > 0) {
    const advance = lastBlockBoundary + 2; // include the \n\n
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }

  const stablePrefix = stablePrefixRef.current;
  const unstableSuffix = stripped.substring(stablePrefix.length);

  // Render stable prefix (all cache hits) + unstable tail (re-parsed each token)
  const stableEl = stablePrefix
    ? React.createElement(Markdown, { key: 'stable', children: stablePrefix })
    : null;

  const unstableEl = unstableSuffix
    ? React.createElement(Markdown, { key: 'unstable', children: unstableSuffix })
    : null;

  if (!stableEl && !unstableEl) return null;
  if (!stableEl) return unstableEl;
  if (!unstableEl) return stableEl;

  return React.createElement(Box, { flexDirection: 'column' }, stableEl, unstableEl);
}

// ── Legacy inline flattener (kept for backward compat) ──

// Re-export flattenInline for consumers that use the mdast → Segment conversion
export { flattenInline } from './markdown-inline.js';

// ── Legacy API compatibility ──

/**
 * Parse a markdown string and return React elements.
 *
 * @deprecated Use <Markdown>{text}</Markdown> instead.
 */
export function markdownToElements(input: string): React.ReactNode {
  return React.createElement(Markdown, { children: input });
}
