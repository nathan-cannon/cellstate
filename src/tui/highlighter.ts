import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlighterCore } from 'shiki/core';
import type { Segment, SegmentStyle } from './nodes.js';

import langTypescript from '@shikijs/langs/typescript';
import langTsx from '@shikijs/langs/tsx';
import langJavascript from '@shikijs/langs/javascript';
import langJsx from '@shikijs/langs/jsx';
import langBash from '@shikijs/langs/bash';
import langJson from '@shikijs/langs/json';
import langYaml from '@shikijs/langs/yaml';
import langHtml from '@shikijs/langs/html';
import langCss from '@shikijs/langs/css';
import langGo from '@shikijs/langs/go';
import langRust from '@shikijs/langs/rust';
import langPython from '@shikijs/langs/python';
import themeNord from '@shikijs/themes/nord';

const THEME = 'nord';

const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [themeNord],
  langs: [
    langTypescript,
    langTsx,
    langJavascript,
    langJsx,
    langBash,
    langJson,
    langYaml,
    langHtml,
    langCss,
    langGo,
    langRust,
    langPython,
  ],
  engine: createJavaScriptRegexEngine(),
});

const loadedLangs = new Set(highlighter.getLoadedLanguages());

export function highlightCode(code: string, lang: string): Segment[][] | null {
  if (!lang) return null;
  if (!loadedLangs.has(lang)) return null;

  const tokens = highlighter.codeToTokensBase(code, { lang, theme: THEME });

  return tokens.map((line) => {
    const segments: Segment[] = [];
    for (const token of line) {
      if (token.content === '') continue;
      const style: SegmentStyle = {};
      if (token.color) style.fg = token.color;
      if (token.fontStyle) {
        if (token.fontStyle & 1) style.italic = true;
        if (token.fontStyle & 2) style.bold = true;
        if (token.fontStyle & 4) style.underline = true;
      }
      const hasStyle = style.fg !== undefined || style.italic || style.bold || style.underline;
      segments.push(hasStyle ? { text: token.content, style } : { text: token.content });
    }
    return segments;
  });
}
