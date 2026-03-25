/**
 * ANSI-to-CellGrid parser for test assertions. Feeds ANSI into headless
 * xterm.js and reads the screen state into a CellGrid as ground truth.
 */
import XtermHeadless from "@xterm/headless";
const { Terminal } = XtermHeadless;
import { readBufferIntoGrid } from "./buffer-reader.js";
import type { CellGrid } from "../src/cell.js";

export function parseAnsi(
  ansi: string,
  cols: number,
  rows: number = 24
): CellGrid {
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  // term.write() is async by design (queues on the parser). We use the
  // private _core.writeSync to keep test code synchronous and simple.
  (term as any)._core.writeSync(ansi);
  const grid = readBufferIntoGrid(term.buffer, cols, rows);
  term.dispose();
  return grid;
}
