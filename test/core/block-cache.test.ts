/**
 * Tests for the BlockCache LRU cache.
 */
import { describe, it, expect } from 'bun:test';
import { BlockCache } from '../../src/markdown/block-cache.js';

describe('BlockCache', () => {
  it('returns null on cache miss', () => {
    const cache = new BlockCache();
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('stores and retrieves entries', () => {
    const cache = new BlockCache();
    const key = BlockCache.key('paragraph', 'hello world', 80);
    const lines = ['hello world'];
    cache.set(key, lines);
    expect(cache.get(key)).toEqual(lines);
  });

  it('tracks size correctly', () => {
    const cache = new BlockCache();
    expect(cache.size).toBe(0);

    cache.set('a', ['line a']);
    expect(cache.size).toBe(1);

    cache.set('b', ['line b']);
    expect(cache.size).toBe(2);

    // Overwrite existing
    cache.set('a', ['line a updated']);
    expect(cache.size).toBe(2);
  });

  it('evicts LRU entries when over capacity', () => {
    const cache = new BlockCache(3);

    cache.set('a', ['a']);
    cache.set('b', ['b']);
    cache.set('c', ['c']);
    expect(cache.size).toBe(3);

    // Adding 'd' should evict 'a' (LRU)
    cache.set('d', ['d']);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toEqual(['b']);
    expect(cache.get('c')).toEqual(['c']);
    expect(cache.get('d')).toEqual(['d']);
  });

  it('promotes accessed entries to MRU', () => {
    const cache = new BlockCache(3);

    cache.set('a', ['a']);
    cache.set('b', ['b']);
    cache.set('c', ['c']);

    // Access 'a' — promotes it to MRU
    cache.get('a');

    // Adding 'd' should now evict 'b' (LRU), not 'a'
    cache.set('d', ['d']);
    expect(cache.get('a')).toEqual(['a']);
    expect(cache.get('b')).toBeNull();
  });

  it('generates width-sensitive keys', () => {
    const key80 = BlockCache.key('paragraph', 'hello', 80);
    const key120 = BlockCache.key('paragraph', 'hello', 120);
    expect(key80).not.toBe(key120);
  });

  it('generates language-sensitive keys for code blocks', () => {
    const keyTs = BlockCache.key('code', 'const x = 1', 80, 'typescript');
    const keyJs = BlockCache.key('code', 'const x = 1', 80, 'javascript');
    const keyNoLang = BlockCache.key('code', 'const x = 1', 80);
    expect(keyTs).not.toBe(keyJs);
    expect(keyTs).not.toBe(keyNoLang);
  });

  it('clears all entries', () => {
    const cache = new BlockCache();
    cache.set('a', ['a']);
    cache.set('b', ['b']);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  it('handles updating existing entries', () => {
    const cache = new BlockCache();
    cache.set('k', ['old']);
    cache.set('k', ['new']);
    expect(cache.get('k')).toEqual(['new']);
    expect(cache.size).toBe(1);
  });

  it('handles large number of entries with eviction', () => {
    const cache = new BlockCache(10);

    for (let i = 0; i < 20; i++) {
      cache.set(`key-${i}`, [`line-${i}`]);
    }

    expect(cache.size).toBe(10);

    // First 10 should be evicted
    for (let i = 0; i < 10; i++) {
      expect(cache.get(`key-${i}`)).toBeNull();
    }

    // Last 10 should still be present
    for (let i = 10; i < 20; i++) {
      expect(cache.get(`key-${i}`)).toEqual([`line-${i}`]);
    }
  });
});
