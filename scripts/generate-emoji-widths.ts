#!/usr/bin/env tsx
/**
 * Generates src/emoji-data.gen.ts from data/emoji-data.txt (Unicode 17.0).
 *
 * Usage: npx tsx scripts/generate-emoji-widths.ts > src/emoji-data.gen.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(__dirname, '..', 'data', 'emoji-data.txt');
const raw = readFileSync(dataPath, 'utf-8');

interface CodePointSet {
  points: Set<number>;
}

function parseSection(property: string): CodePointSet {
  const points = new Set<number>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([0-9A-Fa-f.]+)\s+;\s+(\S+)/);
    if (!match) continue;

    const [, cpRange, prop] = match;
    if (prop !== property) continue;

    if (cpRange!.includes('..')) {
      const [startStr, endStr] = cpRange!.split('..');
      const start = parseInt(startStr!, 16);
      const end = parseInt(endStr!, 16);
      for (let cp = start; cp <= end; cp++) {
        points.add(cp);
      }
    } else {
      points.add(parseInt(cpRange!, 16));
    }
  }
  return { points };
}

function collapseToRanges(points: Set<number>): [number, number][] {
  const sorted = [...points].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const ranges: [number, number][] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === end + 1) {
      end = sorted[i]!;
    } else {
      ranges.push([start, end]);
      start = sorted[i]!;
      end = sorted[i]!;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

function formatHex(n: number): string {
  return '0x' + n.toString(16).toUpperCase();
}

function formatRanges(ranges: [number, number][]): string {
  const lines = ranges.map(([s, e]) => `  [${formatHex(s)}, ${formatHex(e)}],`);
  return lines.join('\n');
}

// Parse both sections
const emoji = parseSection('Emoji');
const emojiPresentation = parseSection('Emoji_Presentation');

// Text-presentation emoji are width 1 by default but become width 2 when
// followed by VS16 (U+FE0F). We need this set separately from Emoji_Presentation
// (which is always width 2) so the width functions can detect the VS16 upgrade.
const textPresentationPoints = new Set<number>();
for (const cp of emoji.points) {
  if (!emojiPresentation.points.has(cp)) {
    textPresentationPoints.add(cp);
  }
}

const epRanges = collapseToRanges(emojiPresentation.points);
const tpRanges = collapseToRanges(textPresentationPoints);

// Output
const output = `// Auto-generated from Unicode 17.0 emoji-data.txt — do not edit manually
// Regenerate with: npx tsx scripts/generate-emoji-widths.ts > src/emoji-data.gen.ts

/** Code point ranges where Emoji_Presentation=Yes. Always width 2. */
export const EMOJI_PRESENTATION_RANGES: [number, number][] = [
${formatRanges(epRanges)}
];

/** Code point ranges where Emoji=Yes but Emoji_Presentation=No.
 *  Width 1 by default, width 2 when followed by U+FE0F. */
export const TEXT_PRESENTATION_EMOJI_RANGES: [number, number][] = [
${formatRanges(tpRanges)}
];
`;

process.stdout.write(output);
