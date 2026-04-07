/**
 * Syntax highlight color theme — maps tree-sitter capture names to SGR codes.
 * Default: Nord-inspired palette matching the previous Shiki-based highlighter.
 */

export interface HighlightTheme {
  /** Map from tree-sitter capture name (without @) to SGR color string. */
  captures: Record<string, string>;
  /** Fallback color for unknown captures. */
  fallback: string;
}

/**
 * SGR helpers — produce the parameter portion (no ESC[ or m wrapper).
 * Callers wrap as `\x1b[${sgr}m`.
 */
function rgb(r: number, g: number, b: number): string {
  return `38;2;${r};${g};${b}`;
}

/**
 * Nord-inspired theme. Colors are from the Nord palette:
 *   nord7  #8FBCBB  (cyan)      — types
 *   nord8  #88C0D0  (light cyan) — functions
 *   nord9  #81A1C1  (blue)       — keywords
 *   nord10 #5E81AC  (dark blue)  — operators
 *   nord11 #BF616A  (red)        — errors / deletion markers
 *   nord12 #D08770  (orange)     — numbers, constants
 *   nord13 #EBCB8B  (yellow)     — strings, annotations
 *   nord14 #A3BE8C  (green)      — strings
 *   nord15 #B48EAD  (purple)     — special
 *   nord4  #D8DEE9  (light gray) — punctuation, default text
 *   nord3  #4C566A  (dark gray)  — comments
 */
export const nordTheme: HighlightTheme = {
  captures: {
    // Keywords & control flow
    'keyword': rgb(0x81, 0xa1, 0xc1),          // nord9
    'keyword.return': rgb(0x81, 0xa1, 0xc1),
    'keyword.function': rgb(0x81, 0xa1, 0xc1),
    'keyword.operator': rgb(0x81, 0xa1, 0xc1),
    'keyword.import': rgb(0x81, 0xa1, 0xc1),
    'keyword.conditional': rgb(0x81, 0xa1, 0xc1),
    'keyword.repeat': rgb(0x81, 0xa1, 0xc1),
    'keyword.exception': rgb(0x81, 0xa1, 0xc1),

    // Strings
    'string': rgb(0xa3, 0xbe, 0x8c),           // nord14
    'string.special': rgb(0xeb, 0xcb, 0x8b),   // nord13
    'string.escape': rgb(0xeb, 0xcb, 0x8b),

    // Numbers & constants
    'number': rgb(0xd0, 0x87, 0x70),           // nord12
    'float': rgb(0xd0, 0x87, 0x70),
    'constant': rgb(0xd0, 0x87, 0x70),
    'constant.builtin': rgb(0xd0, 0x87, 0x70),
    'boolean': rgb(0xd0, 0x87, 0x70),

    // Functions
    'function': rgb(0x88, 0xc0, 0xd0),         // nord8
    'function.call': rgb(0x88, 0xc0, 0xd0),
    'function.builtin': rgb(0x88, 0xc0, 0xd0),
    'function.method': rgb(0x88, 0xc0, 0xd0),
    'method': rgb(0x88, 0xc0, 0xd0),

    // Types
    'type': rgb(0x8f, 0xbc, 0xbb),             // nord7
    'type.builtin': rgb(0x8f, 0xbc, 0xbb),
    'type.definition': rgb(0x8f, 0xbc, 0xbb),
    'constructor': rgb(0x8f, 0xbc, 0xbb),

    // Variables & properties
    'variable': rgb(0xd8, 0xde, 0xe9),         // nord4
    'variable.builtin': rgb(0x81, 0xa1, 0xc1), // nord9
    'variable.parameter': rgb(0xd8, 0xde, 0xe9),
    'property': rgb(0xd8, 0xde, 0xe9),

    // Operators & punctuation
    'operator': rgb(0x81, 0xa1, 0xc1),         // nord9
    'punctuation': rgb(0xd8, 0xde, 0xe9),      // nord4
    'punctuation.bracket': rgb(0xd8, 0xde, 0xe9),
    'punctuation.delimiter': rgb(0xd8, 0xde, 0xe9),
    'punctuation.special': rgb(0xd8, 0xde, 0xe9),

    // Comments
    'comment': rgb(0x4c, 0x56, 0x6a),          // nord3

    // Special
    'tag': rgb(0x81, 0xa1, 0xc1),              // nord9
    'attribute': rgb(0x8f, 0xbc, 0xbb),        // nord7
    'label': rgb(0xd0, 0x87, 0x70),            // nord12
    'include': rgb(0x81, 0xa1, 0xc1),          // nord9
    'namespace': rgb(0xd8, 0xde, 0xe9),        // nord4

    // Embedded / injection
    'embedded': rgb(0xd8, 0xde, 0xe9),
  },
  fallback: rgb(0xd8, 0xde, 0xe9),             // nord4
};

/** Currently active theme. */
let activeTheme: HighlightTheme = nordTheme;

export function setHighlightTheme(theme: HighlightTheme): void {
  activeTheme = theme;
}

export function getHighlightTheme(): HighlightTheme {
  return activeTheme;
}

/**
 * Resolve a tree-sitter capture name to an SGR parameter string.
 * Tries exact match first, then walks up dot-separated hierarchy.
 * E.g. "keyword.return" → "keyword.return" → "keyword" → fallback.
 */
export function captureSgr(captureName: string): string {
  const theme = activeTheme;
  // Exact match
  if (theme.captures[captureName]) return theme.captures[captureName]!;
  // Walk up hierarchy
  let name = captureName;
  while (true) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) break;
    name = name.substring(0, dot);
    if (theme.captures[name]) return theme.captures[name]!;
  }
  return theme.fallback;
}
