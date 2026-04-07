/**
 * Character interning table. Maps character strings to integer IDs for
 * compact storage in the packed cell buffer. Each unique string gets a
 * permanent integer ID; the table never shrinks.
 */

/** ID for space character — always 0. */
export const SPACE_CHAR = 0;
/** ID for empty string (wide-char continuation) — always 1. */
export const EMPTY_CHAR = 1;

export class CharTable {
  /** Reverse lookup: ID → string. */
  private strings: string[] = [];
  /** ASCII fast path: charCode → ID, -1 if not yet interned. */
  private ascii = new Int32Array(128).fill(-1);
  /** Non-ASCII lookup: string → ID. */
  private map = new Map<string, number>();

  constructor() {
    // Pre-register space at ID 0
    this.strings.push(' ');
    this.ascii[32] = SPACE_CHAR;
    // Pre-register empty string at ID 1
    this.strings.push('');
    this.map.set('', EMPTY_CHAR);
  }

  /** Returns the ID for a character string, creating a new entry if unseen. */
  intern(char: string): number {
    // ASCII fast path: single-byte string with charCode < 128
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;
        const id = this.strings.length;
        this.strings.push(char);
        this.ascii[code] = id;
        return id;
      }
    }

    // Non-ASCII / multi-byte path
    const existing = this.map.get(char);
    if (existing !== undefined) return existing;
    const id = this.strings.length;
    this.strings.push(char);
    this.map.set(char, id);
    return id;
  }

  /** Returns the string for an ID, defaulting to space if out of range. */
  resolve(id: number): string {
    if (id < 0 || id >= this.strings.length) return ' ';
    return this.strings[id]!;
  }

  /** Number of interned entries. */
  get size(): number {
    return this.strings.length;
  }
}
