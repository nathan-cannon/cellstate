/**
 * Hyperlink URI interning table. Maps URI strings to integer IDs.
 * ID 0 is reserved for "no hyperlink."
 */

/** ID meaning "no hyperlink" — always 0. */
export const NO_LINK = 0;

export class LinkTable {
  /** Reverse lookup: ID → URI. Index 0 is unused (reserved for NO_LINK). */
  private uris: string[] = [''];
  /** URI → ID. */
  private map = new Map<string, number>();

  /** Returns 0 for undefined/empty, otherwise the ID for the URI. */
  intern(uri: string | undefined): number {
    if (uri === undefined || uri === '') return NO_LINK;
    const existing = this.map.get(uri);
    if (existing !== undefined) return existing;
    const id = this.uris.length;
    this.uris.push(uri);
    this.map.set(uri, id);
    return id;
  }

  /** Returns undefined for ID 0, otherwise the URI string. */
  resolve(id: number): string | undefined {
    if (id === NO_LINK) return undefined;
    return this.uris[id];
  }

  /** Number of interned URIs (excluding the reserved 0 slot). */
  get size(): number {
    return this.uris.length - 1;
  }
}
