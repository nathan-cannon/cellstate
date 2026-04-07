/**
 * Tests for the ANSI line generator — wrapping and inline style application.
 */
import { describe, it, expect } from 'bun:test';
import { wrapAnsiText } from '../../src/markdown/ansi-generator.js';
import stripAnsi from 'strip-ansi';

const ESC = '\x1b[';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const DIM = '\x1b[2m';

describe('wrapAnsiText', () => {
  it('does not wrap short text', () => {
    const lines = wrapAnsiText('Hello', 80);
    expect(lines).toEqual(['Hello']);
  });

  it('wraps plain text at the specified width', () => {
    const lines = wrapAnsiText('ABCDEFGHIJ', 5);
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('ABCDE');
    expect(lines[1]).toBe('FGHIJ');
  });

  it('wraps long text into multiple lines', () => {
    const text = 'A'.repeat(30);
    const lines = wrapAnsiText(text, 10);
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('A'.repeat(10));
    expect(lines[1]).toBe('A'.repeat(10));
    expect(lines[2]).toBe('A'.repeat(10));
  });

  it('preserves ANSI escapes in output', () => {
    const text = `${BOLD}Hello${RESET}`;
    const lines = wrapAnsiText(text, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('\x1b[1m');
    expect(lines[0]).toContain('\x1b[0m');
    expect(stripAnsi(lines[0]!)).toBe('Hello');
  });

  it('ANSI escapes do not count toward width', () => {
    const text = `${BOLD}ABCDE${RESET}FGHIJ`;
    const lines = wrapAnsiText(text, 10);
    // "ABCDE" + "FGHIJ" = 10 visible chars, should fit in one line
    expect(lines.length).toBe(1);
    expect(stripAnsi(lines[0]!)).toBe('ABCDEFGHIJ');
  });

  it('carries SGR state across line breaks', () => {
    // "ABCDE" (5 chars, all bold) + "FGHIJ" (5 chars, should also be bold on next line)
    const text = `${BOLD}ABCDEFGHIJ${RESET}`;
    const lines = wrapAnsiText(text, 5);
    expect(lines.length).toBe(2);

    // First line should end with RESET before the break
    expect(lines[0]).toContain(RESET);

    // Second line should re-open BOLD
    expect(lines[1]).toContain(BOLD);
    expect(stripAnsi(lines[1]!)).toBe('FGHIJ');
  });

  it('handles nested styles across wraps', () => {
    const text = `${BOLD}${ITALIC}ABCDEFGHIJ${RESET}`;
    const lines = wrapAnsiText(text, 5);
    expect(lines.length).toBe(2);

    // Second line should re-open both BOLD and ITALIC
    expect(lines[1]).toContain(BOLD);
    expect(lines[1]).toContain(ITALIC);
  });

  it('handles reset in the middle of text', () => {
    const text = `${BOLD}ABC${RESET}DEFGHIJ`;
    const lines = wrapAnsiText(text, 5);
    expect(lines.length).toBe(2);
    expect(stripAnsi(lines[0]!)).toBe('ABCDE');
    expect(stripAnsi(lines[1]!)).toBe('FGHIJ');

    // After RESET, the second line should NOT carry bold
    // (RESET clears the active escape stack)
  });

  it('handles empty input', () => {
    const lines = wrapAnsiText('', 80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('');
  });

  it('handles width of 0 or negative', () => {
    const lines = wrapAnsiText('Hello', 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('Hello');
  });

  it('handles CJK wide characters', () => {
    // Each CJK char is 2 columns wide
    const text = '你好世界'; // 4 chars, 8 columns
    const lines = wrapAnsiText(text, 5);
    // 你好 = 4 cols, 世 would need 2 more = 6 > 5, so wrap
    expect(lines.length).toBe(2);
    expect(stripAnsi(lines[0]!)).toBe('你好');
    expect(stripAnsi(lines[1]!)).toBe('世界');
  });
});
