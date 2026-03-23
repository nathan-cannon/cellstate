#!/usr/bin/env tsx
/**
 * Measures actual terminal display width of every emoji/symbol in emoji-data.txt
 * by querying cursor position, then compares against CellState's width functions.
 *
 * Usage: npx tsx scripts/test-terminal-widths.ts
 * Results written to data/width-test-results.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { charDisplayWidth, stringDisplayWidth } from '../src/width.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(__dirname, '..', 'data', 'emoji-data.txt');
const outputPath = resolve(__dirname, '..', 'data', 'width-test-results.json');

// ---------------------------------------------------------------------------
// Parse emoji-data.txt
// ---------------------------------------------------------------------------

interface ParsedEntry {
  codePoint: number;
  sections: Set<string>;
}

function parseEmojiData(): Map<number, ParsedEntry> {
  const raw = readFileSync(dataPath, 'utf-8');
  const entries = new Map<number, ParsedEntry>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([0-9A-Fa-f.]+)\s+;\s+(\S+)/);
    if (!match) continue;

    const [, cpRange, property] = match;
    let start: number, end: number;

    if (cpRange!.includes('..')) {
      const [s, e] = cpRange!.split('..');
      start = parseInt(s!, 16);
      end = parseInt(e!, 16);
    } else {
      start = end = parseInt(cpRange!, 16);
    }

    for (let cp = start; cp <= end; cp++) {
      const existing = entries.get(cp);
      if (existing) {
        existing.sections.add(property!);
      } else {
        entries.set(cp, { codePoint: cp, sections: new Set([property!]) });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Terminal width measurement via DSR
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function measureWidth(char: string, timeoutMs = 500): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.off('data', onData);
        resolve(null);
      }
    }, timeoutMs);

    const onData = (data: Buffer) => {
      if (settled) return;
      const str = data.toString();
      const match = str.match(/\x1b\[(\d+);(\d+)R/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        process.stdin.off('data', onData);
        resolve(parseInt(match[2]!, 10) - 1);
      }
    };

    process.stdin.on('data', onData);
    process.stdout.write('\x1b[1G');  // move to col 1
    process.stdout.write(char);       // write character
    process.stdout.write('\x1b[6n'); // query cursor position
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function toUPlus(cp: number): string {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function codePointsStr(str: string): string {
  return [...str].map((ch) => toUPlus(ch.codePointAt(0)!)).join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const entries = parseEmojiData();

  // Setup terminal
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l'); // hide cursor
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen

  const singleMismatches: any[] = [];
  const vs16Tests: any[] = [];
  const sequenceTests: any[] = [];
  let totalTested = 0;
  let totalMatches = 0;
  let totalMismatches = 0;
  let timedOut = 0;

  // ── Phase 1: Single code points ──
  const allCps = [...entries.keys()].sort((a, b) => a - b);
  const total1 = allCps.length;
  let idx = 0;

  for (const cp of allCps) {
    idx++;
    if (idx % 50 === 0 || idx === total1) {
      process.stderr.write(`\rTesting single code points... ${idx}/${total1}`);
    }

    const char = String.fromCodePoint(cp);
    const termWidth = await measureWidth(char);
    await sleep(5);

    if (termWidth === null) {
      timedOut++;
      continue;
    }

    const csWidth = charDisplayWidth(cp);
    totalTested++;

    if (termWidth === csWidth) {
      totalMatches++;
    } else {
      totalMismatches++;
      const entry = entries.get(cp)!;
      singleMismatches.push({
        char,
        codePoints: toUPlus(cp),
        section: [...entry.sections].join(', '),
        terminalWidth: termWidth,
        cellstateWidth: csWidth,
        delta: csWidth - termWidth,
      });
    }
  }
  process.stderr.write(`\rTesting single code points... ${total1}/${total1}\n`);
  process.stderr.write(`  Mismatches: ${singleMismatches.length}\n`);

  // ── Phase 2: VS16 sequences ──
  // Text-presentation emoji: Emoji=Yes but Emoji_Presentation=No
  const textPresentationCps: number[] = [];
  for (const [cp, entry] of entries) {
    if (entry.sections.has('Emoji') && !entry.sections.has('Emoji_Presentation')) {
      textPresentationCps.push(cp);
    }
  }
  textPresentationCps.sort((a, b) => a - b);
  const total2 = textPresentationCps.length;
  let vs16Mismatches = 0;
  idx = 0;

  for (const cp of textPresentationCps) {
    idx++;
    if (idx % 20 === 0 || idx === total2) {
      process.stderr.write(`\rTesting VS16 sequences... ${idx}/${total2}`);
    }

    const base = String.fromCodePoint(cp);
    const withVS16 = base + '\uFE0F';

    const baseTermWidth = await measureWidth(base);
    await sleep(5);
    const vs16TermWidth = await measureWidth(withVS16);
    await sleep(5);

    if (baseTermWidth === null || vs16TermWidth === null) {
      timedOut += (baseTermWidth === null ? 1 : 0) + (vs16TermWidth === null ? 1 : 0);
      continue;
    }

    const baseCsWidth = charDisplayWidth(cp);
    const vs16CsWidth = stringDisplayWidth(withVS16);
    totalTested += 2;

    const baseMatch = baseTermWidth === baseCsWidth;
    const vs16Match = vs16TermWidth === vs16CsWidth;

    if (baseMatch) totalMatches++;
    else totalMismatches++;
    if (vs16Match) totalMatches++;
    else { totalMismatches++; vs16Mismatches++; }

    vs16Tests.push({
      base,
      baseCodePoint: toUPlus(cp),
      baseTerminalWidth: baseTermWidth,
      baseCellstateWidth: baseCsWidth,
      withVS16TerminalWidth: vs16TermWidth,
      withVS16CellstateWidth: vs16CsWidth,
      baseMatch,
      vs16Match,
    });
  }
  process.stderr.write(`\rTesting VS16 sequences... ${total2}/${total2}\n`);
  process.stderr.write(`  Mismatches: ${vs16Mismatches}\n`);

  // ── Phase 3: Common sequences ──
  const SEQUENCES: [string, string][] = [
    // Flags
    ['🇺🇸', 'Flag: US'],
    ['🇬🇧', 'Flag: GB'],
    ['🇯🇵', 'Flag: JP'],
    ['🇩🇪', 'Flag: DE'],
    ['🇫🇷', 'Flag: FR'],
    ['🇰🇷', 'Flag: KR'],
    ['🇨🇳', 'Flag: CN'],
    ['🇧🇷', 'Flag: BR'],
    ['🇮🇳', 'Flag: IN'],
    ['🇦🇺', 'Flag: AU'],
    // Skin tone variants
    ['👋🏻', 'Wave: light skin'],
    ['👋🏼', 'Wave: medium-light skin'],
    ['👋🏽', 'Wave: medium skin'],
    ['👋🏾', 'Wave: medium-dark skin'],
    ['👋🏿', 'Wave: dark skin'],
    ['👍🏻', 'Thumbs up: light skin'],
    ['👍🏼', 'Thumbs up: medium-light skin'],
    ['👍🏽', 'Thumbs up: medium skin'],
    ['👍🏾', 'Thumbs up: medium-dark skin'],
    ['👍🏿', 'Thumbs up: dark skin'],
    // ZWJ sequences
    ['👨‍👩‍👧‍👦', 'Family: man, woman, girl, boy'],
    ['👩‍💻', 'Woman technologist'],
    ['👨‍🍳', 'Man cook'],
    ['🧑‍🌾', 'Farmer'],
    ['👩‍🚀', 'Woman astronaut'],
    ['🏳️‍🌈', 'Rainbow flag'],
    ['🏴‍☠️', 'Pirate flag'],
    ['👨‍👩‍👧', 'Family: man, woman, girl'],
    ['👩‍❤️‍👨', 'Couple with heart'],
    // Keycap sequences
    ['#️⃣', 'Keycap: #'],
    ['0️⃣', 'Keycap: 0'],
    ['1️⃣', 'Keycap: 1'],
    ['2️⃣', 'Keycap: 2'],
    ['*️⃣', 'Keycap: *'],
    // Compound emoji
    ['❤️‍🔥', 'Heart on fire'],
    ['❤️‍🩹', 'Mending heart'],
    ['😮‍💨', 'Face exhaling'],
    ['😵‍💫', 'Face with spiral eyes'],
  ];

  const total3 = SEQUENCES.length;
  let seqMismatches = 0;
  idx = 0;

  for (const [seq, desc] of SEQUENCES) {
    idx++;
    process.stderr.write(`\rTesting common sequences... ${idx}/${total3}`);

    const termWidth = await measureWidth(seq);
    await sleep(5);

    if (termWidth === null) {
      timedOut++;
      continue;
    }

    const csWidth = stringDisplayWidth(seq);
    totalTested++;
    const match = termWidth === csWidth;

    if (match) totalMatches++;
    else { totalMismatches++; seqMismatches++; }

    sequenceTests.push({
      sequence: seq,
      description: desc,
      codePoints: codePointsStr(seq),
      terminalWidth: termWidth,
      cellstateWidth: csWidth,
      match,
    });
  }
  process.stderr.write(`\rTesting common sequences... ${total3}/${total3}\n`);
  process.stderr.write(`  Mismatches: ${seqMismatches}\n`);

  // ── Restore terminal ──
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen
  process.stdout.write('\x1b[?25h'); // show cursor
  process.stdin.setRawMode(false);
  process.stdin.pause();

  // ── Write JSON results ──
  const results = {
    terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown',
    terminalVersion: process.env.TERM_PROGRAM_VERSION ?? 'unknown',
    timestamp: new Date().toISOString(),
    summary: {
      totalTested,
      matches: totalMatches,
      mismatches: totalMismatches,
      mismatchRate: ((totalMismatches / totalTested) * 100).toFixed(2) + '%',
      timedOut,
    },
    mismatches: singleMismatches,
    vs16Tests,
    sequenceTests,
  };

  writeFileSync(outputPath, JSON.stringify(results, null, 2));

  // ── Print readable summary ──
  console.log('\n=== TERMINAL EMOJI WIDTH TEST RESULTS ===\n');
  console.log(`Terminal: ${results.terminal} ${results.terminalVersion}`);
  console.log(`Total tested: ${totalTested}`);
  console.log(`Matches: ${totalMatches}`);
  console.log(`Mismatches: ${totalMismatches} (${results.summary.mismatchRate})`);
  if (timedOut > 0) console.log(`Timed out: ${timedOut}`);

  if (singleMismatches.length > 0) {
    console.log(`\nSINGLE CODE POINT MISMATCHES (CellState disagrees with terminal):`);
    for (const m of singleMismatches) {
      const dir = m.delta > 0 ? 'cellstate overestimates' : 'cellstate underestimates';
      console.log(`  ${m.codePoints}  ${m.char}   terminal=${m.terminalWidth}  cellstate=${m.cellstateWidth}  (${dir})`);
    }
  }

  const vs16Fails = vs16Tests.filter((t: any) => !t.vs16Match);
  if (vs16Fails.length > 0) {
    console.log(`\nVS16 MISMATCHES:`);
    for (const t of vs16Fails) {
      const dir = t.withVS16CellstateWidth > t.withVS16TerminalWidth
        ? 'cellstate overestimates' : 'cellstate underestimates';
      console.log(`  ${t.baseCodePoint}  ${t.base} + VS16  terminal=${t.withVS16TerminalWidth}  cellstate=${t.withVS16CellstateWidth}  (${dir})`);
    }
  }

  const seqFails = sequenceTests.filter((t: any) => !t.match);
  if (seqFails.length > 0) {
    console.log(`\nSEQUENCE MISMATCHES:`);
    for (const t of seqFails) {
      const dir = t.cellstateWidth > t.terminalWidth
        ? 'cellstate overestimates' : 'cellstate underestimates';
      console.log(`  ${t.sequence}  ${t.codePoints}  terminal=${t.terminalWidth}  cellstate=${t.cellstateWidth}  (${t.description}: ${dir})`);
    }
  }

  console.log(`\nResults written to data/width-test-results.json`);
}

main().catch((err) => {
  // Restore terminal on error
  process.stdout.write('\x1b[?25h');
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  console.error(err);
  process.exit(1);
});
