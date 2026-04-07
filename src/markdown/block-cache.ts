/**
 * LRU block-level cache for rendered markdown blocks.
 *
 * Key: (blockType, contentHash, lang?, width) → string[] (ANSI lines for that block)
 * Avoids re-rendering blocks whose content hasn't changed.
 */

/** Simple hash function for cache keys — FNV-1a 32-bit. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

interface CacheEntry {
  key: string;
  lines: string[];
  prev: CacheEntry | null;
  next: CacheEntry | null;
}

export class BlockCache {
  private map = new Map<string, CacheEntry>();
  private head: CacheEntry | null = null; // Most recently used
  private tail: CacheEntry | null = null; // Least recently used
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  /**
   * Build a cache key from block properties.
   */
  static key(
    blockType: string,
    content: string,
    width: number,
    lang?: string,
  ): string {
    const hash = fnv1a(content);
    return `${blockType}:${hash}:${width}${lang ? ':' + lang : ''}`;
  }

  /**
   * Look up cached ANSI lines for a block. Returns null on miss.
   * Moves the entry to MRU position on hit.
   */
  get(key: string): string[] | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    // Move to head (MRU)
    this.moveToHead(entry);
    return entry.lines;
  }

  /**
   * Store rendered ANSI lines for a block.
   */
  set(key: string, lines: string[]): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.lines = lines;
      this.moveToHead(existing);
      return;
    }

    const entry: CacheEntry = { key, lines, prev: null, next: null };
    this.map.set(key, entry);
    this.addToHead(entry);

    // Evict LRU if over capacity
    if (this.map.size > this.maxSize) {
      const evict = this.tail;
      if (evict) {
        this.removeEntry(evict);
        this.map.delete(evict.key);
      }
    }
  }

  /** Number of entries in the cache. */
  get size(): number {
    return this.map.size;
  }

  /** Clear all entries. */
  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  // ── Doubly-linked list operations ──

  private addToHead(entry: CacheEntry): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) {
      this.head.prev = entry;
    }
    this.head = entry;
    if (!this.tail) {
      this.tail = entry;
    }
  }

  private removeEntry(entry: CacheEntry): void {
    if (entry.prev) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }
    if (entry.next) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
    entry.prev = null;
    entry.next = null;
  }

  private moveToHead(entry: CacheEntry): void {
    if (this.head === entry) return;
    this.removeEntry(entry);
    this.addToHead(entry);
  }
}
