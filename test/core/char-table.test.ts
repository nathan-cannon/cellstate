import { describe, test, expect } from 'bun:test';
import { CharTable, SPACE_CHAR, EMPTY_CHAR } from '../../src/core/char-table.js';

describe('CharTable', () => {
  test('space is always ID 0', () => {
    const t = new CharTable();
    expect(t.intern(' ')).toBe(SPACE_CHAR);
    expect(SPACE_CHAR).toBe(0);
  });

  test('empty string is always ID 1', () => {
    const t = new CharTable();
    expect(t.intern('')).toBe(EMPTY_CHAR);
    expect(EMPTY_CHAR).toBe(1);
  });

  test('interning the same string twice returns the same ID', () => {
    const t = new CharTable();
    const id1 = t.intern('A');
    const id2 = t.intern('A');
    expect(id1).toBe(id2);
  });

  test('ASCII fast path works for all printable ASCII', () => {
    const t = new CharTable();
    const ids = new Map<string, number>();
    for (let code = 33; code < 127; code++) {
      const ch = String.fromCharCode(code);
      const id = t.intern(ch);
      ids.set(ch, id);
    }
    // Verify all are unique
    const uniqueIds = new Set(ids.values());
    expect(uniqueIds.size).toBe(ids.size);
    // Verify re-interning returns same IDs
    for (const [ch, expectedId] of ids) {
      expect(t.intern(ch)).toBe(expectedId);
    }
  });

  test('non-ASCII strings get unique IDs', () => {
    const t = new CharTable();
    const chars = ['中', '🎉', '👨‍👩‍👧‍👦', 'é', '漢'];
    const ids = chars.map(ch => t.intern(ch));
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(chars.length);
  });

  test('CJK characters get unique IDs', () => {
    const t = new CharTable();
    const id1 = t.intern('中');
    const id2 = t.intern('文');
    expect(id1).not.toBe(id2);
    expect(t.intern('中')).toBe(id1);
  });

  test('emoji get unique IDs', () => {
    const t = new CharTable();
    const id1 = t.intern('🎉');
    const id2 = t.intern('🚀');
    expect(id1).not.toBe(id2);
  });

  test('grapheme cluster family emoji gets a unique ID', () => {
    const t = new CharTable();
    const family = '👨‍👩‍👧‍👦';
    const id = t.intern(family);
    expect(id).toBeGreaterThan(EMPTY_CHAR);
    expect(t.intern(family)).toBe(id);
  });

  test('resolve returns the original string', () => {
    const t = new CharTable();
    const id = t.intern('X');
    expect(t.resolve(id)).toBe('X');
    expect(t.resolve(SPACE_CHAR)).toBe(' ');
    expect(t.resolve(EMPTY_CHAR)).toBe('');
  });

  test('resolve returns the original string for non-ASCII', () => {
    const t = new CharTable();
    const emoji = '👨‍👩‍👧‍👦';
    const id = t.intern(emoji);
    expect(t.resolve(id)).toBe(emoji);
  });

  test('resolve on out-of-range ID returns space', () => {
    const t = new CharTable();
    expect(t.resolve(-1)).toBe(' ');
    expect(t.resolve(9999)).toBe(' ');
  });

  test('size reflects the number of unique entries', () => {
    const t = new CharTable();
    // Starts with 2 pre-registered entries (space + empty)
    expect(t.size).toBe(2);
    t.intern('A');
    expect(t.size).toBe(3);
    t.intern('A'); // duplicate
    expect(t.size).toBe(3);
    t.intern('B');
    expect(t.size).toBe(4);
    t.intern('🎉');
    expect(t.size).toBe(5);
  });
});
