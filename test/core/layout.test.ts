import { describe, it, expect } from 'bun:test';
import { wrapText } from '../../src/core/layout.js';

describe('wrapText', () => {
  it('no wrapping needed', () => {
    expect(wrapText('hello', 40)).toEqual(['hello']);
  });

  it('wraps on space', () => {
    expect(wrapText('hello world', 5)).toEqual(['hello', 'world']);
  });

  it('hard breaks mid-word', () => {
    expect(wrapText('abcdefghij', 5)).toEqual(['abcde', 'fghij']);
  });

  it('returns [] for empty text', () => {
    expect(wrapText('', 40)).toEqual([]);
  });

  it('returns [] for zero width', () => {
    expect(wrapText('hello', 0)).toEqual([]);
  });

  it('returns [] for negative width', () => {
    expect(wrapText('hello', -5)).toEqual([]);
  });

  it('hanging indent narrows continuation lines', () => {
    const lines = wrapText('aaaa bbbb cccc dddd', 10, 2);
    expect(lines).toEqual(['aaaa bbbb', 'cccc', 'dddd']);
  });

  it('hanging indent with hard break', () => {
    // Width 5, hangingIndent 2 → continuation width 3
    const lines = wrapText('hello abcdef', 5, 2);
    expect(lines).toEqual(['hello', 'abc', 'def']);
  });
});

describe('wide character wrapping', () => {
  it('CJK characters count as 2 columns', () => {
    expect(wrapText('你好', 4)).toEqual(['你好']);
    expect(wrapText('你好', 3)).toEqual(['你', '好']);
  });

  it('mixed ASCII and CJK wrapping', () => {
    expect(wrapText('hi你好', 6)).toEqual(['hi你好']);
    expect(wrapText('hi你好', 5)).toEqual(['hi你', '好']);
    expect(wrapText('hi你好', 4)).toEqual(['hi你', '好']);
  });

  it('CJK wraps on space boundaries', () => {
    expect(wrapText('ab 你好', 5)).toEqual(['ab', '你好']);
  });

  it('hard break between CJK characters', () => {
    expect(wrapText('你好世界', 4)).toEqual(['你好', '世界']);
    expect(wrapText('你好世界', 5)).toEqual(['你好', '世界']);
  });

  it('emoji (surrogate pairs) wrapping', () => {
    expect(wrapText('😀😀', 4)).toEqual(['😀😀']);
    expect(wrapText('😀😀', 3)).toEqual(['😀', '😀']);
    expect(wrapText('😀😀', 2)).toEqual(['😀', '😀']);
  });

  it('CJK with hanging indent', () => {
    const lines = wrapText('你好 世界abc', 6, 2);
    expect(lines).toEqual(['你好', '世界', 'abc']);
  });

  it('wide char wider than line does not infinite loop', () => {
    const lines = wrapText('你', 1);
    expect(lines).toEqual(['你']);
  });
});
