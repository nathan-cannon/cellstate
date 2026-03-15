import XtermHeadless from "@xterm/headless";
const { Terminal } = XtermHeadless;
import { readBufferIntoGrid } from "./buffer-reader.js";
import type { CellGrid } from "./cell.js";

export function parseAnsi(
  ansi: string,
  cols: number,
  rows: number = 24
): CellGrid {
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  // term.write() is async; use the internal synchronous write
  // so callers don't need to await.
  (term as any)._core.writeSync(ansi);
  const grid = readBufferIntoGrid(term.buffer, cols, rows);
  term.dispose();
  return grid;
}
