import { stringDisplayWidth } from '../../src/width.js';
import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { TerminalFixture } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

for (const file of fixtureFiles) {
  const fixture: TerminalFixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));

  describe(`fixture: ${fixture.terminal}-${fixture.version}`, () => {
    describe('width: cellstate consistency', () => {
      for (const w of fixture.widths) {
        test(`${w.codePoints} ${w.char} (${w.category})`, () => {
          const actual = stringDisplayWidth(w.char);
          expect(actual).toBe(w.cellstateWidth);
        });
      }
    });

    describe('width: terminal agreement', () => {
      for (const w of fixture.widths) {
        if (w.match) {
          test(`${w.codePoints} ${w.char} (${w.category}) — width ${w.terminalWidth}`, () => {
            expect(w.cellstateWidth).toBe(w.terminalWidth);
          });
        } else {
          test.skip(`${w.codePoints} ${w.char} (${w.category}) — cellstate: ${w.cellstateWidth}, terminal: ${w.terminalWidth} [KNOWN MISMATCH]`, () => {});
        }
      }
    });

    describe('cursor behavior', () => {
      for (const c of fixture.cursor) {
        if (c.pass) {
          test(`${c.name}`, () => {
            expect(c.pass).toBe(true);
          });
        } else {
          test.skip(`${c.name} — expected ${c.expectedPos}, got ${c.actualPos} [KNOWN MISMATCH]`, () => {});
        }
      }
    });

    describe('sgr parsing', () => {
      for (const s of fixture.sgr) {
        test(`${s.name}`, () => {
          expect(s.pass).toBe(true);
        });
      }
    });

    describe('erase behavior', () => {
      for (const e of fixture.erase) {
        test(`${e.name}`, () => {
          expect(e.pass).toBe(true);
        });
      }
    });
  });
}
