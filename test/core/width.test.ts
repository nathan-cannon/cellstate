import { describe, it, expect } from 'bun:test';
import {
  charDisplayWidth,
  stringDisplayWidth,
  sliceToWidth,
  sliceFromEndToWidth,
  isTextPresentationEmoji,
} from '../../src/core/width.js';

describe('charDisplayWidth', () => {
  it('returns 1 for ASCII', () => {
    expect(charDisplayWidth('a'.codePointAt(0)!)).toBe(1);
    expect(charDisplayWidth(' '.codePointAt(0)!)).toBe(1);
    expect(charDisplayWidth('Z'.codePointAt(0)!)).toBe(1);
  });

  it('returns 2 for CJK ideographs', () => {
    expect(charDisplayWidth('你'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('好'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('世'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('界'.codePointAt(0)!)).toBe(2);
  });

  it('returns 2 for Hangul syllables', () => {
    expect(charDisplayWidth('한'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('글'.codePointAt(0)!)).toBe(2);
  });

  it('returns 2 for Hiragana and Katakana', () => {
    expect(charDisplayWidth('あ'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('カ'.codePointAt(0)!)).toBe(2);
  });

  it('returns 2 for fullwidth forms', () => {
    // Fullwidth A (U+FF21)
    expect(charDisplayWidth(0xff21)).toBe(2);
    // Fullwidth exclamation (U+FF01)
    expect(charDisplayWidth(0xff01)).toBe(2);
  });

  it('returns 2 for emoji', () => {
    expect(charDisplayWidth('😀'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('🎉'.codePointAt(0)!)).toBe(2);
    expect(charDisplayWidth('🚀'.codePointAt(0)!)).toBe(2);
  });

  it('returns 0 for combining diacritical marks', () => {
    // U+0301 combining acute accent
    expect(charDisplayWidth(0x0301)).toBe(0);
    // U+0308 combining diaeresis
    expect(charDisplayWidth(0x0308)).toBe(0);
  });

  it('returns 0 for zero-width spaces and joiners', () => {
    expect(charDisplayWidth(0x200b)).toBe(0); // zero-width space
    expect(charDisplayWidth(0x200c)).toBe(0); // ZWNJ
    expect(charDisplayWidth(0x200d)).toBe(0); // ZWJ
    expect(charDisplayWidth(0xfeff)).toBe(0); // BOM
  });

  it('returns 0 for variation selectors', () => {
    expect(charDisplayWidth(0xfe0f)).toBe(0); // VS16 (emoji presentation)
    expect(charDisplayWidth(0xfe0e)).toBe(0); // VS15 (text presentation)
  });

  it('returns 2 for CJK Extension B', () => {
    // U+20000 is CJK Extension B
    expect(charDisplayWidth(0x20000)).toBe(2);
  });
});

describe('stringDisplayWidth', () => {
  it('returns length for ASCII', () => {
    expect(stringDisplayWidth('hello')).toBe(5);
    expect(stringDisplayWidth('')).toBe(0);
  });

  it('counts CJK characters as 2', () => {
    expect(stringDisplayWidth('你好')).toBe(4);
    expect(stringDisplayWidth('你好世界')).toBe(8);
  });

  it('handles mixed ASCII and CJK', () => {
    expect(stringDisplayWidth('hi你好')).toBe(6); // 2 + 4
  });

  it('handles emoji (surrogate pairs)', () => {
    expect(stringDisplayWidth('😀')).toBe(2);
    expect(stringDisplayWidth('a😀b')).toBe(4); // 1 + 2 + 1
  });

  it('handles combining marks as zero width', () => {
    // e + combining acute = display width 1
    expect(stringDisplayWidth('e\u0301')).toBe(1);
  });

  it('handles variation selectors as zero width', () => {
    // emoji + VS16
    expect(stringDisplayWidth('😀\uFE0F')).toBe(2);
  });
});

describe('sliceToWidth', () => {
  it('returns full string if it fits', () => {
    expect(sliceToWidth('hello', 10)).toBe('hello');
  });

  it('slices ASCII correctly', () => {
    expect(sliceToWidth('hello', 3)).toBe('hel');
  });

  it('slices CJK without splitting a wide char', () => {
    expect(sliceToWidth('你好世界', 5)).toBe('你好');
    expect(sliceToWidth('你好世界', 4)).toBe('你好');
    expect(sliceToWidth('你好世界', 3)).toBe('你');
  });

  it('handles mixed ASCII + CJK', () => {
    expect(sliceToWidth('a你好b', 4)).toBe('a你');
    expect(sliceToWidth('a你好b', 5)).toBe('a你好');
    expect(sliceToWidth('a你好b', 6)).toBe('a你好b');
  });

  it('does not split surrogate pairs', () => {
    expect(sliceToWidth('😀test', 2)).toBe('😀');
    expect(sliceToWidth('😀test', 1)).toBe('');
  });

  it('handles zero-width characters', () => {
    // e + combining acute: display width 1, should include the combining mark
    expect(sliceToWidth('e\u0301x', 1)).toBe('e\u0301');
  });
});

describe('sliceFromEndToWidth', () => {
  it('returns full string if it fits', () => {
    expect(sliceFromEndToWidth('hello', 10)).toBe('hello');
  });

  it('slices from end for ASCII', () => {
    expect(sliceFromEndToWidth('hello', 3)).toBe('llo');
  });

  it('slices CJK from end without splitting', () => {
    expect(sliceFromEndToWidth('你好世界', 5)).toBe('世界');
    expect(sliceFromEndToWidth('你好世界', 4)).toBe('世界');
    expect(sliceFromEndToWidth('你好世界', 3)).toBe('界');
  });

  it('handles mixed text', () => {
    expect(sliceFromEndToWidth('abc你好', 4)).toBe('你好');
    expect(sliceFromEndToWidth('abc你好', 5)).toBe('c你好');
  });

  it('does not split surrogate pairs', () => {
    expect(sliceFromEndToWidth('test😀', 2)).toBe('😀');
    expect(sliceFromEndToWidth('test😀', 1)).toBe('');
  });
});

describe('emoji presentation precision', () => {
  it('emoji_presentation=yes code points are width 2', () => {
    // ⚡ U+26A1 — Emoji_Presentation=Yes
    expect(charDisplayWidth(0x26a1)).toBe(2);
    // ✨ U+2728 — Emoji_Presentation=Yes
    expect(charDisplayWidth(0x2728)).toBe(2);
    // ☕ U+2615 — Emoji_Presentation=Yes
    expect(charDisplayWidth(0x2615)).toBe(2);
    // ⭐ U+2B50 — Emoji_Presentation=Yes
    expect(charDisplayWidth(0x2b50)).toBe(2);
    // ❤ U+2764 — Emoji=Yes but Emoji_Presentation=No (text-presentation)
    // Width 1 without VS16, width 2 with VS16
    expect(charDisplayWidth(0x2764)).toBe(1);
    expect(stringDisplayWidth('❤\uFE0F')).toBe(2);
  });

  it('text-presentation emoji without VS16 are width 1', () => {
    // ☀ U+2600 — Emoji=Yes, Emoji_Presentation=No
    expect(charDisplayWidth(0x2600)).toBe(1);
    // ♠ U+2660 — Emoji=Yes, Emoji_Presentation=No
    expect(charDisplayWidth(0x2660)).toBe(1);
    // ♣ U+2663
    expect(charDisplayWidth(0x2663)).toBe(1);
    // ← U+2190 — not even Emoji
    expect(charDisplayWidth(0x2190)).toBe(1);
    // → U+2192
    expect(charDisplayWidth(0x2192)).toBe(1);
  });

  it('common emoji with emoji presentation are all width 2', () => {
    // All Emoji_Presentation=Yes — always width 2 without VS16
    const emoji = '🚀🎯💡🔥⚡🌟✨🎉🎊💎🏆🥇🧠💪🔑🌈🌙🎵🎸🎬📚💻📱🔧🧩🪄🦄🐱🐶🦋🌸🍕🍺🎲🃏🎁💌😄🤖👽🌊⭐';
    for (const ch of emoji) {
      const cp = ch.codePointAt(0)!;
      expect(charDisplayWidth(cp)).toBe(2);
    }
  });

  it('text-presentation emoji with VS16 are width 2 in strings', () => {
    // ❤️ ☀️ ☕ — text-presentation emoji need VS16 for width 2
    expect(stringDisplayWidth('❤\uFE0F')).toBe(2);
    expect(stringDisplayWidth('☀\uFE0F')).toBe(2);
  });

  it('non-emoji code points in old broad range are width 1', () => {
    // U+1F000 (Mahjong Tile Back) is NOT Emoji_Presentation — should be 1
    // Actually check: it may be in the ranges. Let's test known non-emoji.
    // U+1FB00 (Block Sextant-1) — not emoji
    expect(charDisplayWidth(0x1fb00)).toBe(1);
  });
});

describe('isTextPresentationEmoji', () => {
  it('identifies text-presentation emoji', () => {
    // ☀ U+2600
    expect(isTextPresentationEmoji(0x2600)).toBe(true);
    // ☎ U+260E
    expect(isTextPresentationEmoji(0x260e)).toBe(true);
    // ✏ U+270F
    expect(isTextPresentationEmoji(0x270f)).toBe(true);
  });

  it('rejects emoji_presentation=yes code points', () => {
    // ⚡ U+26A1 — Emoji_Presentation=Yes, NOT text-presentation
    expect(isTextPresentationEmoji(0x26a1)).toBe(false);
    // 🚀 U+1F680
    expect(isTextPresentationEmoji(0x1f680)).toBe(false);
  });

  it('rejects non-emoji', () => {
    expect(isTextPresentationEmoji('a'.codePointAt(0)!)).toBe(false);
    expect(isTextPresentationEmoji(0x4e00)).toBe(false); // CJK
  });
});

describe('stringDisplayWidth grapheme clusters', () => {
  it('skin tone modifier', () => {
    expect(stringDisplayWidth('👋🏽')).toBe(2);
  });

  it('ZWJ sequence', () => {
    expect(stringDisplayWidth('👨‍💻')).toBe(2);
    expect(stringDisplayWidth('👩‍🔬')).toBe(2);
  });

  it('regional indicator flag', () => {
    expect(stringDisplayWidth('🇺🇸')).toBe(2);
    expect(stringDisplayWidth('🇯🇵')).toBe(2);
  });

  it('three regional indicators = flag + standalone', () => {
    // First two pair into a flag (width 2), third is standalone (width 2)
    expect(stringDisplayWidth('🇺🇸🇯')).toBe(4);
  });

  it('ZWJ at end of string (dangling)', () => {
    expect(stringDisplayWidth('👨\u200D')).toBe(2);
  });

  it('multiple ZWJ sequences', () => {
    // 👨‍👩‍👧 = family emoji
    expect(stringDisplayWidth('👨\u200D👩\u200D👧')).toBe(2);
  });

  it('skin tone on non-emoji (should not cluster)', () => {
    expect(stringDisplayWidth('A\u{1F3FD}')).toBe(3);
  });
});

describe('sliceToWidth with grapheme clusters', () => {
  it('slices around ZWJ sequence', () => {
    expect(sliceToWidth('AB👨‍💻CD', 4)).toBe('AB👨‍💻');
    expect(sliceToWidth('AB👨‍💻CD', 3)).toBe('AB');
  });

  it('slices around flag', () => {
    expect(sliceToWidth('🇺🇸hello', 2)).toBe('🇺🇸');
    expect(sliceToWidth('🇺🇸hello', 1)).toBe('');
  });
});

describe('stringDisplayWidth with VS16', () => {
  it('text-presentation emoji + VS16 = width 2', () => {
    // ☀️ = U+2600 + U+FE0F
    expect(stringDisplayWidth('☀\uFE0F')).toBe(2);
  });

  it('text-presentation emoji without VS16 = width 1', () => {
    expect(stringDisplayWidth('☀')).toBe(1);
  });

  it('emoji_presentation emoji + VS16 stays width 2 (no double-counting)', () => {
    // 🚀 is already width 2, adding VS16 should not make it 3
    expect(stringDisplayWidth('🚀\uFE0F')).toBe(2);
  });

  it('VS16 after non-emoji is width 0', () => {
    // 'a' + VS16 — not an emoji, VS16 is just zero-width
    expect(stringDisplayWidth('a\uFE0F')).toBe(1);
  });

  it('mixed text with VS16 emoji', () => {
    // "hi☀️" = 2 + 2 = 4
    expect(stringDisplayWidth('hi☀\uFE0F')).toBe(4);
    // "☀️☀️" = 2 + 2 = 4
    expect(stringDisplayWidth('☀\uFE0F☀\uFE0F')).toBe(4);
  });
});
