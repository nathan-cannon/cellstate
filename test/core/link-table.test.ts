import { describe, test, expect } from 'bun:test';
import { LinkTable, NO_LINK } from '../../src/core/link-table.js';

describe('LinkTable', () => {
  test('undefined returns 0', () => {
    const t = new LinkTable();
    expect(t.intern(undefined)).toBe(NO_LINK);
  });

  test('empty string returns 0', () => {
    const t = new LinkTable();
    expect(t.intern('')).toBe(NO_LINK);
  });

  test('same URI interned twice returns same ID', () => {
    const t = new LinkTable();
    const id1 = t.intern('https://example.com');
    const id2 = t.intern('https://example.com');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(NO_LINK);
  });

  test('different URIs get different IDs', () => {
    const t = new LinkTable();
    const id1 = t.intern('https://example.com');
    const id2 = t.intern('https://other.com');
    expect(id1).not.toBe(id2);
  });

  test('resolve(0) returns undefined', () => {
    const t = new LinkTable();
    expect(t.resolve(NO_LINK)).toBeUndefined();
  });

  test('resolve round-trips correctly for non-zero IDs', () => {
    const t = new LinkTable();
    const uri = 'https://example.com/path?q=1';
    const id = t.intern(uri);
    expect(t.resolve(id)).toBe(uri);
  });

  test('size reflects unique URIs only', () => {
    const t = new LinkTable();
    expect(t.size).toBe(0);
    t.intern('https://a.com');
    expect(t.size).toBe(1);
    t.intern('https://b.com');
    expect(t.size).toBe(2);
    t.intern('https://a.com'); // duplicate
    expect(t.size).toBe(2);
    t.intern(undefined); // no-op
    expect(t.size).toBe(2);
    t.intern(''); // no-op
    expect(t.size).toBe(2);
  });
});
