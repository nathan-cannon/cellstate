import { describe, test, expect } from 'bun:test';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { ColorMode, Attr } from '../../src/core/cell.js';

describe('StyleTable', () => {
  test('default style is always ID 0', () => {
    const t = new StyleTable();
    const id = t.intern(0, ColorMode.Default, 0, ColorMode.Default, 0);
    expect(id).toBe(DEFAULT_STYLE);
    expect(DEFAULT_STYLE).toBe(0);
  });

  test('same tuple interned twice returns same ID', () => {
    const t = new StyleTable();
    const id1 = t.intern(Attr.Bold, ColorMode.Palette, 1, ColorMode.Default, 0);
    const id2 = t.intern(Attr.Bold, ColorMode.Palette, 1, ColorMode.Default, 0);
    expect(id1).toBe(id2);
  });

  test('different tuples get different IDs', () => {
    const t = new StyleTable();
    const id1 = t.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);
    const id2 = t.intern(Attr.Italic, ColorMode.Default, 0, ColorMode.Default, 0);
    const id3 = t.intern(0, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });

  test('resolve round-trips correctly', () => {
    const t = new StyleTable();
    const id = t.intern(
      Attr.Bold | Attr.Underline,
      ColorMode.RGB, 0x00ff00,
      ColorMode.Palette, 42,
    );
    const resolved = t.resolve(id);
    expect(resolved.attrs).toBe(Attr.Bold | Attr.Underline);
    expect(resolved.fgMode).toBe(ColorMode.RGB);
    expect(resolved.fgValue).toBe(0x00ff00);
    expect(resolved.bgMode).toBe(ColorMode.Palette);
    expect(resolved.bgValue).toBe(42);
  });

  test('transition between identical IDs returns empty string', () => {
    const t = new StyleTable();
    const id = t.intern(Attr.Bold, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    expect(t.transition(id, id)).toBe('');
  });

  test('transition from default to bold-red produces correct SGR', () => {
    const t = new StyleTable();
    const defaultId = DEFAULT_STYLE;
    const boldRed = t.intern(Attr.Bold, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    const sgr = t.transition(defaultId, boldRed);
    // From default, should emit full style: bold (1), fg RGB 255;0;0, bg default (49)
    expect(sgr).toBe('\x1b[1;38;2;255;0;0;49m');
  });

  test('transition from bold-red to bold-blue produces minimal fg-only change', () => {
    const t = new StyleTable();
    const boldRed = t.intern(Attr.Bold, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    const boldBlue = t.intern(Attr.Bold, ColorMode.RGB, 0x0000ff, ColorMode.Default, 0);
    const sgr = t.transition(boldRed, boldBlue);
    // Only fg changed, attrs and bg are same → fg-only fast path
    expect(sgr).toBe('\x1b[38;2;0;0;255m');
  });

  test('transition to default produces reset', () => {
    const t = new StyleTable();
    const styled = t.intern(Attr.Bold, ColorMode.RGB, 0xff0000, ColorMode.Default, 0);
    const sgr = t.transition(styled, DEFAULT_STYLE);
    expect(sgr).toBe('\x1b[0m');
  });

  test('transition is cached (second call returns same string reference)', () => {
    const t = new StyleTable();
    const a = t.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);
    const b = t.intern(Attr.Italic, ColorMode.Default, 0, ColorMode.Default, 0);
    const first = t.transition(a, b);
    const second = t.transition(a, b);
    // Same reference, not just same value
    expect(first).toBe(second);
    // Verify it's actually a string transition
    expect(first.length).toBeGreaterThan(0);
  });

  test('size reports correctly', () => {
    const t = new StyleTable();
    expect(t.size).toBe(1); // default style
    t.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);
    expect(t.size).toBe(2);
    t.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0); // duplicate
    expect(t.size).toBe(2);
  });

  test('transitionCacheSize reports correctly', () => {
    const t = new StyleTable();
    expect(t.transitionCacheSize).toBe(0);
    const a = t.intern(Attr.Bold, ColorMode.Default, 0, ColorMode.Default, 0);
    t.transition(DEFAULT_STYLE, a);
    expect(t.transitionCacheSize).toBe(1);
    t.transition(a, DEFAULT_STYLE);
    expect(t.transitionCacheSize).toBe(2);
    // Same pair again doesn't increase cache size
    t.transition(DEFAULT_STYLE, a);
    expect(t.transitionCacheSize).toBe(2);
  });
});
