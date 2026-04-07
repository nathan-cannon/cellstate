/**
 * Syntax highlighter using @kreuzberg/tree-sitter-language-pack.
 *
 * Uses the language pack's extract() API with bundled highlights.scm queries
 * to get proper tree-sitter query captures, then maps capture names to SGR
 * colors via the theme.
 */
import langPackDefault from '@kreuzberg/tree-sitter-language-pack';
import { hasLanguage, getHighlightsQuery } from '@kreuzberg/tree-sitter-language-pack';

// The `extract` function is on the default (CJS) export but not in the ESM type declarations.
const langPack = langPackDefault as typeof langPackDefault & {
  extract(source: string, config: any): any;
};
import { captureSgr } from './theme.js';
import { canonLang } from './tree-sitter-init.js';

const ESC = '\x1b[';
const RESET = '\x1b[0m';

/** A styled range within a line of code. */
interface StyledSpan {
  start: number; // column within the line
  end: number;
  sgr: string;   // SGR parameter string (e.g. "38;2;129;161;193")
}

/**
 * Highlight a code string using tree-sitter highlight queries.
 * Returns an array of ANSI-escaped strings, one per line.
 *
 * @param code Source code text
 * @param lang Language name (will be canonicalized)
 * @returns Array of lines with ANSI SGR escapes inline
 */
export function highlightCode(code: string, lang: string): string[] {
  const canonical = canonLang(lang);

  try {
    if (!hasLanguage(canonical)) {
      return code.split('\n');
    }

    // Some languages (e.g. typescript, tsx) don't have their own highlight queries
    // but are supersets of languages that do (javascript). Fall back accordingly.
    let highlightQuery = getHighlightsQuery(canonical);
    if (!highlightQuery) {
      const fallbacks: Record<string, string> = {
        typescript: 'javascript',
        tsx: 'javascript',
      };
      const fallback = fallbacks[canonical];
      highlightQuery = fallback ? getHighlightsQuery(fallback) : null;
    }
    if (!highlightQuery) {
      return code.split('\n');
    }

    const result = langPack.extract(code, {
      language: canonical,
      patterns: { h: { query: highlightQuery } },
    } as any);

    const lines = code.split('\n');
    const lineSpans: StyledSpan[][] = lines.map(() => []);

    for (const match of (result as any).results.h.matches) {
      for (const capture of match.captures) {
        const node = capture.node;
        const startRow = node.startRow;
        const endRow = node.endRow;
        const sgr = captureSgr(capture.name);

        if (startRow === endRow) {
          // Single-line span
          if (startRow < lineSpans.length) {
            lineSpans[startRow]!.push({
              start: node.startCol,
              end: node.endCol,
              sgr,
            });
          }
        } else {
          // Multi-line span (e.g. multi-line strings)
          for (let row = startRow; row <= endRow && row < lineSpans.length; row++) {
            const lineLen = lines[row]!.length;
            const start = row === startRow ? node.startCol : 0;
            const end = row === endRow ? node.endCol : lineLen;
            lineSpans[row]!.push({ start, end, sgr });
          }
        }
      }
    }

    // Sort spans per line by start position
    for (const spans of lineSpans) {
      spans.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    // Build ANSI strings
    const output: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const spans = lineSpans[i]!;
      if (spans.length === 0) {
        output.push(line);
        continue;
      }

      let out = '';
      let pos = 0;

      for (const span of spans) {
        if (span.start > pos) {
          // Unstyled gap
          out += line.substring(pos, span.start);
        }
        if (span.start >= pos) {
          out += ESC + span.sgr + 'm';
          out += line.substring(span.start, span.end);
          out += RESET;
          pos = span.end;
        }
      }

      // Trailing unstyled text
      if (pos < line.length) {
        out += line.substring(pos);
      }

      output.push(out);
    }

    return output;
  } catch {
    return code.split('\n');
  }
}
