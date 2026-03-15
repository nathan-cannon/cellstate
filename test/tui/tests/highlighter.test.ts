import { describe, it, expect } from 'bun:test';
import { highlightCode } from '../highlighter.js';

describe('highlightCode', () => {
  it('known language returns segments with fg colors', () => {
    const result = highlightCode('const x = 1;', 'typescript');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    const hasColor = result![0].some((s) => s.style?.fg !== undefined);
    expect(hasColor).toBe(true);
  });

  it('multi-line code — line count matches input', () => {
    const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const result = highlightCode(code, 'typescript');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  it('unknown language returns null', () => {
    const result = highlightCode('code', 'obscurelang');
    expect(result).toBeNull();
  });

  it('empty language returns null', () => {
    const result = highlightCode('code', '');
    expect(result).toBeNull();
  });

  it('segment style mapping — fontStyle bitmask', () => {
    // Use a language that produces styled tokens; test that style fields are set correctly
    const result = highlightCode('const x = 1;', 'typescript');
    expect(result).not.toBeNull();
    // All segments should have valid structure
    for (const line of result!) {
      for (const seg of line) {
        expect(typeof seg.text).toBe('string');
        if (seg.style) {
          if (seg.style.italic !== undefined) expect(typeof seg.style.italic).toBe('boolean');
          if (seg.style.bold !== undefined) expect(typeof seg.style.bold).toBe('boolean');
          if (seg.style.underline !== undefined) expect(typeof seg.style.underline).toBe('boolean');
          if (seg.style.fg !== undefined) expect(typeof seg.style.fg).toBe('string');
        }
      }
    }
  });

  it('empty lines preserved', () => {
    const code = 'line1\n\nline3';
    const result = highlightCode(code, 'typescript');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(3);
  });

  it('bash code block — shellscript alias works', () => {
    const result = highlightCode('echo hello', 'bash');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].length).toBeGreaterThan(0);
  });

  it('empty-content tokens are filtered out', () => {
    const result = highlightCode('const x = 1;', 'typescript');
    expect(result).not.toBeNull();
    for (const line of result!) {
      for (const seg of line) {
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
  });
});
