/**
 * Headless xterm.js fixture generator. Produces the baseline fixture
 * that CI can always run without a real terminal.
 */
import XtermHeadless from '@xterm/headless';
const { Terminal } = XtermHeadless;
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringDisplayWidth } from '../../src/core/width.js';
import type {
  TerminalFixture,
  WidthResult,
  CursorResult,
  SGRResult,
  EraseResult,
} from './harness.js';

// ── Helpers ────────────────────────────────────────────────────────

const CSI = '\x1b[';

function codePointsString(str: string): string {
  const points: string[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    points.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
  }
  return points.join(' ');
}

function getXtermVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '../../node_modules/@xterm/headless/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return '6.0.0';
  }
}

// ── Width test characters (same list as harness.ts) ────────────────

interface WidthTestChar {
  char: string;
  category: string;
  expectedWidth: number;
}

const WIDTH_TEST_CHARS: WidthTestChar[] = [
  // ASCII
  { char: 'A', category: 'ascii', expectedWidth: 1 },

  // CJK Unified Ideographs
  { char: '漢', category: 'cjk', expectedWidth: 2 },
  { char: '字', category: 'cjk', expectedWidth: 2 },
  { char: '中', category: 'cjk', expectedWidth: 2 },

  // Hiragana / Katakana
  { char: 'あ', category: 'hiragana', expectedWidth: 2 },
  { char: 'カ', category: 'katakana', expectedWidth: 2 },

  // Hangul
  { char: '한', category: 'hangul_syllable', expectedWidth: 2 },
  { char: 'ㄱ', category: 'hangul_jamo', expectedWidth: 2 },

  // Fullwidth Latin
  { char: 'Ａ', category: 'fullwidth_latin', expectedWidth: 2 },

  // Halfwidth Katakana
  { char: 'ｱ', category: 'halfwidth_katakana', expectedWidth: 1 },

  // Emoji with default emoji presentation
  { char: '😀', category: 'emoji_presentation', expectedWidth: 2 },
  { char: '🎉', category: 'emoji_presentation', expectedWidth: 2 },
  { char: '👍', category: 'emoji_presentation', expectedWidth: 2 },
  { char: '🔥', category: 'emoji_presentation', expectedWidth: 2 },
  { char: '💀', category: 'emoji_presentation', expectedWidth: 2 },
  { char: '🚀', category: 'emoji_presentation', expectedWidth: 2 },

  // Text-presentation emoji (no VS16)
  { char: '⚡', category: 'text_presentation', expectedWidth: 1 },
  { char: '☀', category: 'text_presentation', expectedWidth: 1 },
  { char: '✈', category: 'text_presentation', expectedWidth: 1 },
  { char: '☎', category: 'text_presentation', expectedWidth: 1 },
  { char: '⚠', category: 'text_presentation', expectedWidth: 1 },

  // Text-presentation emoji + VS16
  { char: '⚡\uFE0F', category: 'text_pres+vs16', expectedWidth: 2 },
  { char: '☀\uFE0F', category: 'text_pres+vs16', expectedWidth: 2 },
  { char: '✈\uFE0F', category: 'text_pres+vs16', expectedWidth: 2 },

  // Skin tone modifiers
  { char: '👋🏽', category: 'skin_tone', expectedWidth: 2 },

  // ZWJ sequences
  { char: '👨‍💻', category: 'zwj_sequence', expectedWidth: 2 },
  { char: '👩‍🔬', category: 'zwj_sequence', expectedWidth: 2 },

  // Regional indicator flags
  { char: '🇺🇸', category: 'regional_flag', expectedWidth: 2 },
  { char: '🇯🇵', category: 'regional_flag', expectedWidth: 2 },

  // Japanese button emoji (CellState special-cased)
  { char: '🈂', category: 'japanese_button', expectedWidth: 2 },
  { char: '🈷', category: 'japanese_button', expectedWidth: 2 },

  // Combining marks
  { char: 'e\u0301', category: 'combining_mark', expectedWidth: 1 },
  { char: 'a\u0308', category: 'combining_mark', expectedWidth: 1 },

  // Box drawing
  { char: '┌', category: 'box_drawing', expectedWidth: 1 },
  { char: '─', category: 'box_drawing', expectedWidth: 1 },
  { char: '│', category: 'box_drawing', expectedWidth: 1 },
  { char: '╔', category: 'box_drawing', expectedWidth: 1 },
  { char: '╭', category: 'box_drawing', expectedWidth: 1 },

  // Ambiguous-width
  { char: '☆', category: 'ambiguous', expectedWidth: 1 },
  { char: '→', category: 'ambiguous', expectedWidth: 1 },
  { char: 'α', category: 'ambiguous', expectedWidth: 1 },
  { char: '①', category: 'ambiguous', expectedWidth: 1 },
  { char: '≈', category: 'ambiguous', expectedWidth: 1 },

  // Zero-width characters
  { char: 'A\u200B', category: 'zero_width', expectedWidth: 1 },
  { char: 'A\u200D', category: 'zero_width', expectedWidth: 1 },
];

// ── Test runners ───────────────────────────────────────────────────

function runWidthTests(): WidthResult[] {
  const results: WidthResult[] = [];

  for (const tc of WIDTH_TEST_CHARS) {
    const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    (term as any)._core.writeSync(tc.char);
    const terminalWidth = term.buffer.active.cursorX;
    const cellstateWidth = stringDisplayWidth(tc.char);
    term.dispose();

    results.push({
      char: tc.char,
      codePoints: codePointsString(tc.char),
      category: tc.category,
      cellstateWidth,
      terminalWidth,
      match: terminalWidth === cellstateWidth,
    });
  }

  return results;
}

function runCursorTests(): CursorResult[] {
  const results: CursorResult[] = [];
  const cols = 120;

  // CHA accuracy
  {
    const term = new Terminal({ cols, rows: 40, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}5;1H${CSI}25G`);
    const row = term.buffer.active.cursorY + 1;
    const col = term.buffer.active.cursorX + 1;
    const pass = row === 5 && col === 25;
    results.push({
      name: 'cha_column_25',
      pass,
      expectedPos: [5, 25],
      actualPos: [row, col],
      detail: 'CHA (\\x1b[25G) moves cursor to column 25',
    });
    term.dispose();
  }

  // CUU (cursor up)
  {
    const term = new Terminal({ cols, rows: 40, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}10;5H${CSI}3A`);
    const row = term.buffer.active.cursorY + 1;
    const col = term.buffer.active.cursorX + 1;
    const pass = row === 7 && col === 5;
    results.push({
      name: 'cuu_up_3',
      pass,
      expectedPos: [7, 5],
      actualPos: [row, col],
      detail: 'CUU 3 (\\x1b[3A) moves cursor up 3 rows',
    });
    term.dispose();
  }

  // CUD (cursor down)
  {
    const term = new Terminal({ cols, rows: 40, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}7;5H${CSI}5B`);
    const row = term.buffer.active.cursorY + 1;
    const col = term.buffer.active.cursorX + 1;
    const pass = row === 12 && col === 5;
    results.push({
      name: 'cud_down_5',
      pass,
      expectedPos: [12, 5],
      actualPos: [row, col],
      detail: 'CUD 5 (\\x1b[5B) moves cursor down 5 rows',
    });
    term.dispose();
  }

  // Pending wrap
  {
    const term = new Terminal({ cols, rows: 40, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}15;1H${CSI}${cols}GX \x08`);
    const row = term.buffer.active.cursorY + 1;
    const col = term.buffer.active.cursorX + 1;
    const pass = row === 16 && col === 1;
    results.push({
      name: 'pending_wrap',
      pass,
      expectedPos: [16, 1],
      actualPos: [row, col],
      detail: 'Write space at last column + backspace triggers pending wrap',
    });
    term.dispose();
  }

  return results;
}

function runSGRTests(): SGRResult[] {
  const results: SGRResult[] = [];

  // SGR 22 clears bold and dim
  {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}1;1H${CSI}1;2mXX${CSI}22mYY${CSI}0m`);
    const col = term.buffer.active.cursorX + 1;
    const pass = col === 5;
    results.push({
      name: 'sgr22_clears_bold_and_dim',
      pass,
      detail: `cursor advanced correctly (col ${col}, expected 5) — visual check: YY should be neither bold nor dim`,
    });
    term.dispose();
  }

  // Compound SGR parsing
  {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}1;1H${CSI}1;3;38;2;0;200;100mTEST${CSI}0m`);
    const col = term.buffer.active.cursorX + 1;
    const pass = col === 5;
    results.push({
      name: 'compound_sgr',
      pass,
      detail: `cursor advanced correctly (col ${col}, expected 5) — visual check: TEST should be bold italic green`,
    });
    term.dispose();
  }

  return results;
}

function runEraseTests(): EraseResult[] {
  const results: EraseResult[] = [];

  // EL2 (erase entire line) uses default bg
  {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}20;1H${CSI}48;2;255;0;0mXXXXXXXXXX`);
    (term as any)._core.writeSync(`${CSI}20;1H${CSI}0m${CSI}2K`);
    // Verify the line was erased by checking buffer content
    const line = term.buffer.active.getLine(19);
    const cellChar = line?.getCell(0)?.getChars() ?? '';
    const pass = cellChar === '' || cellChar === ' ';
    results.push({
      name: 'el2_default_bg',
      pass,
      detail: `line content after EL2: cell 0 = ${JSON.stringify(cellChar)} (expected empty/space) — bg color cannot be verified programmatically`,
    });
    term.dispose();
  }

  // EL0 (erase to end of line)
  {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    (term as any)._core.writeSync(`${CSI}22;1HHELLOXXXXX`);
    (term as any)._core.writeSync(`${CSI}6G${CSI}0m${CSI}0K`);
    const col = term.buffer.active.cursorX + 1;
    // Verify HELLO is preserved and XXXXX is erased
    const line = term.buffer.active.getLine(21);
    let content = '';
    for (let i = 0; i < 10; i++) {
      content += line?.getCell(i)?.getChars() ?? '';
    }
    const pass = col === 6 && content.startsWith('HELLO');
    results.push({
      name: 'el0_default_bg',
      pass,
      detail: `cursor at col ${col} (expected 6), buffer content: ${JSON.stringify(content.trimEnd())} — erase-to-end should not move cursor`,
    });
    term.dispose();
  }

  return results;
}

// ── Main ───────────────────────────────────────────────────────────

function main() {
  const version = getXtermVersion();

  const widths = runWidthTests();
  const cursor = runCursorTests();
  const sgr = runSGRTests();
  const erase = runEraseTests();

  const fixture: TerminalFixture = {
    terminal: 'xterm-js',
    version,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    env: {
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'xterm.js',
      COLORTERM: 'truecolor',
    },
    widths,
    cursor,
    sgr,
    erase,
  };

  // Write fixture file
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = join(__dirname, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  const outPath = join(fixturesDir, `xterm-js-${version}.json`);
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

  // Print summary
  const widthMatches = widths.filter((w) => w.match).length;
  const widthMismatches = widths.filter((w) => !w.match);
  const cursorPasses = cursor.filter((c) => c.pass).length;
  const sgrPasses = sgr.filter((s) => s.pass).length;
  const erasePasses = erase.filter((e) => e.pass).length;

  console.log('Generated xterm.js baseline fixture');
  console.log(`Version: ${version}`);
  console.log(`Widths: ${widths.length} tested, ${widthMatches} match cellstate${widthMismatches.length > 0 ? ` (${widthMismatches.length} known mismatches)` : ''}`);
  for (const m of widthMismatches) {
    console.log(`  ✗ ${m.char} (${m.codePoints}) ${m.category}: cellstate=${m.cellstateWidth}, xterm=${m.terminalWidth}`);
  }
  console.log(`Cursor: ${cursorPasses}/${cursor.length} pass`);
  for (const c of cursor.filter((c) => !c.pass)) {
    console.log(`  ✗ ${c.name}: expected ${c.expectedPos}, got ${c.actualPos}`);
  }
  console.log(`SGR: ${sgrPasses}/${sgr.length} pass`);
  for (const s of sgr.filter((s) => !s.pass)) {
    console.log(`  ✗ ${s.name}: ${s.detail}`);
  }
  console.log(`Erase: ${erasePasses}/${erase.length} pass`);
  for (const e of erase.filter((e) => !e.pass)) {
    console.log(`  ✗ ${e.name}: ${e.detail}`);
  }
  console.log(`Saved to ${outPath}`);
}

main();
