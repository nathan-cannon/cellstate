import XtermHeadless from "@xterm/headless";
const { Terminal } = XtermHeadless;
import { readBufferIntoGrid } from "./buffer-reader.js";
import type { CellGrid } from "./cell.js";

/**
 * VirtualScreen wraps a persistent @xterm/headless Terminal.
 * Unlike parseAnsi() which creates a fresh terminal per call,
 * this accumulates state across multiple write() calls — which is
 * how Ink actually works (it sends incremental cursor moves + partial
 * rewrites, not complete frames).
 */
type TerminalInstance = InstanceType<typeof Terminal>;

export class VirtualScreen {
  private _term: TerminalInstance;
  private _cols: number;
  private _rows: number;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    this._term = this._createTerminal(cols, rows);
  }

  private _createTerminal(cols: number, rows: number): TerminalInstance {
    return new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  }

  /**
   * Feed a chunk of ANSI output (from Ink via our proxy).
   * Uses the async write() API, not writeSync.
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this._term.write(data, resolve);
    });
  }

  /**
   * Read the current screen state as a CellGrid.
   * Reads from the persistent xterm buffer — same logic as parseAnsi
   * but on the long-lived instance.
   */
  readGrid(): CellGrid {
    return readBufferIntoGrid(this._term.buffer, this._cols, this._rows);
  }

  /**
   * Read only the viewport rows as a CellGrid.
   * When content has scrolled into scrollback (baseY > 0), readGrid()
   * reads from row 0 of the buffer which includes scrollback rows that
   * can't be updated on screen. This method reads only the visible
   * viewport — the bottom N rows where N is the terminal height.
   * The returned grid has the same dimensions as readGrid(), so the
   * diff engine doesn't know or care about scrollback.
   */
  readViewportGrid(): CellGrid {
    return readBufferIntoGrid(
      this._term.buffer,
      this._cols,
      this._rows,
      this._term.buffer.active.baseY,
    );
  }

  /**
   * Handle terminal resize. Creates a new xterm Terminal at the
   * new dimensions (xterm-headless doesn't support resize well).
   * Screen content is lost — caller is responsible for triggering
   * a full re-render from Ink after calling this.
   */
  resize(cols: number, rows: number): void {
    this._term.dispose();
    this._cols = cols;
    this._rows = rows;
    this._term = this._createTerminal(cols, rows);
  }

  /** The number of rows that have scrolled into scrollback. */
  get baseY(): number {
    return this._term.buffer.active.baseY;
  }

  /**
   * Reset the terminal to a fresh state at current dimensions.
   */
  reset(): void {
    this._term.dispose();
    this._term = this._createTerminal(this._cols, this._rows);
  }

  /** Return the current cursor position within the terminal viewport. */
  getCursorPos(): { row: number; col: number } {
    return {
      row: this._term.buffer.active.cursorY,
      col: this._term.buffer.active.cursorX,
    };
  }

  /** Clean up the terminal instance. */
  dispose(): void {
    this._term.dispose();
  }
}
