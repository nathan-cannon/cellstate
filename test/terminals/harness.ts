import { charDisplayWidth, stringDisplayWidth } from '../../src/core/width.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Fixture types ──────────────────────────────────────────────────

export interface TerminalFixture {
  terminal: string;
  version: string;
  timestamp: string;
  platform: string;
  env: {
    TERM?: string;
    TERM_PROGRAM?: string;
    COLORTERM?: string;
  };
  widths: WidthResult[];
  cursor: CursorResult[];
  sgr: SGRResult[];
  erase: EraseResult[];
}

export interface WidthResult {
  char: string;
  codePoints: string;
  category: string;
  cellstateWidth: number;
  terminalWidth: number;
  match: boolean;
}

export interface CursorResult {
  name: string;
  pass: boolean;
  expectedPos: [number, number];
  actualPos: [number, number] | null;
  detail: string;
}

export interface SGRResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface EraseResult {
  name: string;
  pass: boolean;
  detail: string;
}

// ── Helpers ────────────────────────────────────────────────────────

const CSI = '\x1b[';

function write(s: string): void {
  process.stdout.write(s);
}

function moveTo(row: number, col: number): void {
  write(`${CSI}${row};${col}H`);
}

function clearLine(): void {
  write(`${CSI}2K`);
}

function hideCursor(): void {
  write(`${CSI}?25l`);
}

function showCursor(): void {
  write(`${CSI}?25h`);
}

function codePointsString(str: string): string {
  const points: string[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    points.push('U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
  }
  return points.join(' ');
}

/** Read a DSR (CPR) response from stdin with timeout. Returns [row, col] or null. */
function queryCursorPosition(): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    let buf = '';
    const timeout = setTimeout(() => {
      process.stdin.removeListener('data', onData);
      resolve(null);
    }, 300);

    function onData(data: Buffer) {
      buf += data.toString();
      // CPR response: ESC [ row ; col R
      const match = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (match) {
        clearTimeout(timeout);
        process.stdin.removeListener('data', onData);
        resolve([parseInt(match[1], 10), parseInt(match[2], 10)]);
      }
    }

    process.stdin.on('data', onData);
    // Send DSR query
    write(`${CSI}6n`);
  });
}

// ── Width test characters ──────────────────────────────────────────

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

async function runWidthTests(): Promise<WidthResult[]> {
  const results: WidthResult[] = [];

  for (const tc of WIDTH_TEST_CHARS) {
    moveTo(1, 1);
    clearLine();
    write(tc.char);

    const pos = await queryCursorPosition();
    const terminalWidth = pos ? pos[1] - 1 : -1;
    const cellstateWidth = stringDisplayWidth(tc.char);

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

async function runCursorTests(): Promise<CursorResult[]> {
  const results: CursorResult[] = [];
  const cols = process.stdout.columns || 80;

  // CHA accuracy
  moveTo(5, 1);
  write(`${CSI}25G`);
  let pos = await queryCursorPosition();
  results.push({
    name: 'cha_column_25',
    pass: pos !== null && pos[0] === 5 && pos[1] === 25,
    expectedPos: [5, 25],
    actualPos: pos,
    detail: 'CHA (\\x1b[25G) moves cursor to column 25',
  });

  // CUU (cursor up)
  moveTo(10, 5);
  write(`${CSI}3A`);
  pos = await queryCursorPosition();
  results.push({
    name: 'cuu_up_3',
    pass: pos !== null && pos[0] === 7 && pos[1] === 5,
    expectedPos: [7, 5],
    actualPos: pos,
    detail: 'CUU 3 (\\x1b[3A) moves cursor up 3 rows',
  });

  // CUD (cursor down)
  write(`${CSI}5B`);
  pos = await queryCursorPosition();
  results.push({
    name: 'cud_down_5',
    pass: pos !== null && pos[0] === 12 && pos[1] === 5,
    expectedPos: [12, 5],
    actualPos: pos,
    detail: 'CUD 5 (\\x1b[5B) moves cursor down 5 rows',
  });

  // Pending wrap
  moveTo(15, 1);
  write(`${CSI}${cols}GX`);
  write(' \x08');
  pos = await queryCursorPosition();
  results.push({
    name: 'pending_wrap',
    pass: pos !== null && pos[0] === 16 && pos[1] === 1,
    expectedPos: [16, 1],
    actualPos: pos,
    detail: 'Write space at last column + backspace triggers pending wrap',
  });

  return results;
}

async function runSGRTests(): Promise<SGRResult[]> {
  const results: SGRResult[] = [];

  // SGR 22 clears bold and dim
  moveTo(17, 1);
  clearLine();
  write(`${CSI}1;2mXX${CSI}22mYY${CSI}0m`);
  let pos = await queryCursorPosition();
  const pass1 = pos !== null && pos[1] === 5;
  results.push({
    name: 'sgr22_clears_bold_and_dim',
    pass: pass1,
    detail: `cursor advanced correctly (col ${pos?.[1] ?? '?'}, expected 5) — visual check: YY should be neither bold nor dim`,
  });

  // Compound SGR parsing
  moveTo(18, 1);
  clearLine();
  write(`${CSI}1;3;38;2;0;200;100mTEST${CSI}0m`);
  pos = await queryCursorPosition();
  const pass2 = pos !== null && pos[1] === 5;
  results.push({
    name: 'compound_sgr',
    pass: pass2,
    detail: `cursor advanced correctly (col ${pos?.[1] ?? '?'}, expected 5) — visual check: TEST should be bold italic green`,
  });

  return results;
}

async function runEraseTests(): Promise<EraseResult[]> {
  const results: EraseResult[] = [];

  // EL2 (erase entire line) uses default bg
  moveTo(20, 1);
  write(`${CSI}48;2;255;0;0mXXXXXXXXXX`);
  moveTo(20, 1);
  write(`${CSI}0m${CSI}2K`);
  moveTo(20, 1);
  write(' ');
  let pos = await queryCursorPosition();
  const pass1 = pos !== null && pos[1] === 2;
  results.push({
    name: 'el2_default_bg',
    pass: pass1,
    detail: `cursor at col ${pos?.[1] ?? '?'} (expected 2) after EL2 and writing space — bg color cannot be verified programmatically`,
  });

  // EL0 (erase to end of line)
  moveTo(22, 1);
  write('HELLOXXXXX');
  write(`${CSI}6G`);
  write(`${CSI}0m${CSI}0K`);
  pos = await queryCursorPosition();
  const pass2 = pos !== null && pos[1] === 6;
  results.push({
    name: 'el0_default_bg',
    pass: pass2,
    detail: `cursor at col ${pos?.[1] ?? '?'} (expected 6) — erase-to-end should not move cursor`,
  });

  return results;
}

// ── Main ───────────────────────────────────────────────────────────

function parseArgs(): { terminal: string; version: string } {
  const args = process.argv.slice(2);
  let terminal = '';
  let version = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--terminal' && i + 1 < args.length) {
      terminal = args[++i];
    } else if (args[i] === '--version' && i + 1 < args.length) {
      version = args[++i];
    }
  }

  if (!terminal || !version) {
    console.error('Usage: npx tsx test/terminals/harness.ts --terminal <name> --version <version>');
    process.exit(1);
  }

  return { terminal, version };
}

async function main() {
  const { terminal, version } = parseArgs();
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Set up raw mode and hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  hideCursor();

  // Clear screen
  write(`${CSI}2J`);

  try {
    console.error(`\nCellState Terminal Fixture Generator`);
    console.error(`Terminal: ${terminal}`);
    console.error(`Version:  ${version}`);
    console.error(`Columns:  ${cols}`);
    console.error(`Rows:     ${rows}`);

    console.error(`\nRunning width tests... ${WIDTH_TEST_CHARS.length} characters`);
    const widths = await runWidthTests();

    console.error(`Running cursor tests... 4 tests`);
    const cursor = await runCursorTests();

    console.error(`Running SGR tests... 2 tests`);
    const sgr = await runSGRTests();

    console.error(`Running erase tests... 2 tests`);
    const erase = await runEraseTests();

    // Build fixture
    const fixture: TerminalFixture = {
      terminal,
      version,
      timestamp: new Date().toISOString(),
      platform: process.platform,
      env: {
        TERM: process.env.TERM,
        TERM_PROGRAM: process.env.TERM_PROGRAM,
        COLORTERM: process.env.COLORTERM,
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
    const outPath = join(fixturesDir, `${terminal}-${version}.json`);
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

    // Print summary
    const widthMatches = widths.filter((w) => w.match).length;
    const widthMismatches = widths.filter((w) => !w.match);
    const cursorPasses = cursor.filter((c) => c.pass).length;
    const sgrPasses = sgr.filter((s) => s.pass).length;
    const erasePasses = erase.filter((e) => e.pass).length;

    console.error(`\nResults:`);
    console.error(`  Widths: ${widthMatches}/${widths.length} match${widthMismatches.length > 0 ? ` (${widthMismatches.length} mismatches)` : ''}`);
    for (const m of widthMismatches) {
      console.error(`    ✗ ${m.char} (${m.codePoints}) ${m.category}: cellstate=${m.cellstateWidth}, terminal=${m.terminalWidth}`);
    }
    console.error(`  Cursor: ${cursorPasses}/${cursor.length} pass`);
    for (const c of cursor.filter((c) => !c.pass)) {
      console.error(`    ✗ ${c.name}: expected ${c.expectedPos}, got ${c.actualPos}`);
    }
    console.error(`  SGR: ${sgrPasses}/${sgr.length} pass`);
    for (const s of sgr.filter((s) => !s.pass)) {
      console.error(`    ✗ ${s.name}: ${s.detail}`);
    }
    console.error(`  Erase: ${erasePasses}/${erase.length} pass`);
    for (const e of erase.filter((e) => !e.pass)) {
      console.error(`    ✗ ${e.name}: ${e.detail}`);
    }

    console.error(`\nFixture saved to ${outPath}`);
  } finally {
    // Restore terminal state
    write(`${CSI}0m`);
    showCursor();
    moveTo(rows, 1);
    write('\n');
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

main().catch((err) => {
  // Emergency cleanup
  try {
    showCursor();
    write(`${CSI}0m`);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  } catch {}
  console.error(err);
  process.exit(1);
});
