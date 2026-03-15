import { describe, it, expect } from 'bun:test';
import { rasterize } from '../../../src/tui/rasterizer.js';
import { layout } from '../../../src/tui/layout.js';
import { createNode, appendChild, type TNode, type LayoutResult, type WrappedLine } from '../../../src/tui/nodes.js';
import { Attr, ColorMode, type CellGrid } from '../../../src/cell.js';

/** Convert plain strings to WrappedLine format */
function wl(...lines: string[]): WrappedLine[] {
  return lines.map(line => [{ text: line }]);
}

/** Helper: create a node with layout set directly (no layout() call) */
function node(
  type: TNode['type'],
  props: Record<string, any>,
  layoutResult: LayoutResult,
  children: TNode[] = [],
): TNode {
  const n = createNode(type, props);
  n.layout = layoutResult;
  for (const c of children) {
    appendChild(n, c);
  }
  return n;
}

/** Helper: create a text element node with a text-instance child and layout set */
function textNode(
  content: string,
  props: Record<string, any>,
  layoutResult: LayoutResult,
): TNode {
  const el = createNode('text', props);
  el.layout = layoutResult;
  const inst = createNode('text', {});
  inst.text = content;
  inst.layout = null;
  appendChild(el, inst);
  return el;
}

/** Read a row of chars from the grid as a string */
function rowText(grid: CellGrid, row: number, startCol = 0, len?: number): string {
  const r = grid.cells[row]!;
  const end = len != null ? startCol + len : r.length;
  let s = '';
  for (let c = startCol; c < end && c < r.length; c++) {
    s += r[c]!.char;
  }
  return s;
}

describe('rasterizer', () => {
  it('single text', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    expect(rowText(grid, 0, 0, 5)).toBe('hello');
    // Remaining cells are spaces
    expect(grid.cells[0]![5]!.char).toBe(' ');
    expect(grid.cells[0]![39]!.char).toBe(' ');
  });

  it('text position offset', () => {
    const t = textNode('hello', {}, {
      x: 4, y: 0, width: 36, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    expect(grid.cells[0]![0]!.char).toBe(' ');
    expect(grid.cells[0]![3]!.char).toBe(' ');
    expect(rowText(grid, 0, 4, 5)).toBe('hello');
  });

  it('wrapped text', () => {
    const t = textNode('hello world', {}, {
      x: 0, y: 0, width: 5, height: 2, wrappedLines: wl('hello', 'world'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    expect(rowText(grid, 0, 0, 5)).toBe('hello');
    expect(rowText(grid, 1, 0, 5)).toBe('world');
  });

  it('hanging indent rendering', () => {
    const t = textNode('aaaa bbbb cccc dddd', {}, {
      x: 0, y: 0, width: 10, height: 3,
      wrappedLines: wl('aaaa bbbb', 'cccc', 'dddd'),
      hangingIndent: 2,
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    // First line at column 0
    expect(rowText(grid, 0, 0, 9)).toBe('aaaa bbbb');
    // Continuation lines at column 2
    expect(grid.cells[1]![0]!.char).toBe(' ');
    expect(grid.cells[1]![1]!.char).toBe(' ');
    expect(rowText(grid, 1, 2, 4)).toBe('cccc');
    expect(rowText(grid, 2, 2, 4)).toBe('dddd');
  });

  it('foreground color', () => {
    const t = textNode('hi', { color: '#ff0000' }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hi'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
    expect(grid.cells[0]![1]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![1]!.fg.value).toBe(0xff0000);
  });

  it('background color on text — fills full width', () => {
    const t = textNode('hello', { backgroundColor: '#303030' }, {
      x: 0, y: 0, width: 20, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    // All 20 cells in the text's width should have the background
    for (let c = 0; c < 20; c++) {
      expect(grid.cells[0]![c]!.bg.mode).toBe(ColorMode.RGB);
      expect(grid.cells[0]![c]!.bg.value).toBe(0x303030);
    }
    // Cell outside text's width should be default
    expect(grid.cells[0]![20]!.bg.mode).toBe(ColorMode.Default);
  });

  it('background fill with wrapped text', () => {
    const t = textNode('hello world', { backgroundColor: '#303030' }, {
      x: 0, y: 0, width: 10, height: 2, wrappedLines: wl('hello', 'world'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    // Both rows, all 10 columns should have background
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 10; col++) {
        expect(grid.cells[row]![col]!.bg.mode).toBe(ColorMode.RGB);
        expect(grid.cells[row]![col]!.bg.value).toBe(0x303030);
      }
    }
  });

  it('bold attribute', () => {
    const t = textNode('hi', { bold: true }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hi'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    // Attr.Bold = 1
    expect(grid.cells[0]![0]!.attrs & 1).toBe(1);
    expect(grid.cells[0]![1]!.attrs & 1).toBe(1);
  });

  it('style inheritance parent→child', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const box = node('box', { color: '#ff0000' }, { x: 0, y: 0, width: 40, height: 1 }, [t]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [box]);

    const grid = rasterize(root, 40, 10);

    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
  });

  it('style override child overrides parent', () => {
    const t = textNode('hello', { color: '#00ff00' }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const box = node('box', { color: '#ff0000' }, { x: 0, y: 0, width: 40, height: 1 }, [t]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [box]);

    const grid = rasterize(root, 40, 10);

    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0x00ff00);
  });

  it('style inheritance three levels deep', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const inner = node('box', {}, { x: 0, y: 0, width: 40, height: 1 }, [t]);
    const outer = node('box', { color: '#ff0000' }, { x: 0, y: 0, width: 40, height: 1 }, [inner]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [outer]);

    const grid = rasterize(root, 40, 10);

    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
  });

  it('vertical stack rendering', () => {
    const t1 = textNode('first', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('first'),
    });
    const t2 = textNode('second', {}, {
      x: 0, y: 1, width: 40, height: 1, wrappedLines: wl('second'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t1, t2]);

    const grid = rasterize(root, 40, 10);

    expect(rowText(grid, 0, 0, 5)).toBe('first');
    expect(rowText(grid, 1, 0, 6)).toBe('second');
  });

  it('horizontal split rendering', () => {
    const tA = textNode('AB', {}, {
      x: 0, y: 0, width: 2, height: 1, wrappedLines: wl('AB'),
    });
    const tB = textNode('hello', {}, {
      x: 2, y: 0, width: 18, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 20, height: 10 }, [tA, tB]);

    const grid = rasterize(root, 20, 10);

    expect(rowText(grid, 0, 0, 2)).toBe('AB');
    expect(rowText(grid, 0, 2, 5)).toBe('hello');
  });

  it('out of bounds — no crash', () => {
    const t1 = textNode('hello', {}, {
      x: 0, y: 9, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const t2 = textNode('gone', {}, {
      x: 0, y: 10, width: 40, height: 1, wrappedLines: wl('gone'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t1, t2]);

    const grid = rasterize(root, 40, 10);

    // Row 9 is within bounds
    expect(rowText(grid, 9, 0, 5)).toBe('hello');
    // Row 10 is out of bounds — no crash, nothing written
    expect(grid.cells).toHaveLength(10);
  });

  it('end-to-end integration with layout()', () => {
    // Column box > row box > [2-wide bullet, flexGrow text]
    const root = createNode('root', {});
    const col = createNode('box', {});
    const row = createNode('box', { flexDirection: 'row' });
    const bulletBox = createNode('box', { width: 2 });
    const bulletText = createNode('text', {});
    const bulletInst = createNode('text', {});
    bulletInst.text = '● ';
    appendChild(bulletText, bulletInst);
    appendChild(bulletBox, bulletText);

    const msgBox = createNode('box', { flexGrow: 1 });
    const msgText = createNode('text', {});
    const msgInst = createNode('text', {});
    msgInst.text = 'Hello, this is a longer message that should wrap';
    appendChild(msgText, msgInst);
    appendChild(msgBox, msgText);

    appendChild(row, bulletBox);
    appendChild(row, msgBox);
    appendChild(col, row);
    appendChild(root, col);

    layout(root, 30, 24);
    const grid = rasterize(root, 30, 24);

    // Bullet at (0, 0)
    expect(grid.cells[0]![0]!.char).toBe('●');
    expect(grid.cells[0]![1]!.char).toBe(' ');
    // Message text starts at column 2
    expect(grid.cells[0]![2]!.char).toBe('H');

    // Verify wrapping happened — message text should appear on row 1+ at column 2
    const msgLayout = msgText.layout!;
    expect(msgLayout.x).toBe(2);
    expect(msgLayout.height).toBeGreaterThan(1);
    // Continuation line starts at column 2 (no hanging indent, just the row split)
    expect(grid.cells[1]![2]!.char).not.toBe(' ');
  });

  it('empty grid — no children', () => {
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 });

    const grid = rasterize(root, 40, 10);

    // All cells should be default spaces
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 40; c++) {
        expect(grid.cells[r]![c]!.char).toBe(' ');
        expect(grid.cells[r]![c]!.bg.mode).toBe(ColorMode.Default);
      }
    }
  });

  it('marginTop spacing — text at y=1', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 1, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10);

    // Row 0 is empty
    expect(rowText(grid, 0, 0, 5)).toBe('     ');
    // Row 1 has the text
    expect(rowText(grid, 1, 0, 5)).toBe('hello');
  });
});

describe('rasterizer — scroll offset', () => {
  it('scroll offset 0 — existing behavior unchanged', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);

    const grid = rasterize(root, 40, 10, 0);

    expect(rowText(grid, 0, 0, 5)).toBe('hello');
  });

  it('scroll offset skips top rows', () => {
    // 6 text lines at y=0..5, scrollOffset=2, grid height=4
    const children: TNode[] = [];
    for (let i = 0; i < 6; i++) {
      children.push(
        textNode(`line${i}`, {}, {
          x: 0, y: i, width: 40, height: 1, wrappedLines: wl(`line${i}`),
        }),
      );
    }
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 6 }, children);

    const grid = rasterize(root, 40, 4, 2);

    // y=0 and y=1 skipped. y=2 at grid row 0, y=5 at grid row 3.
    expect(rowText(grid, 0, 0, 5)).toBe('line2');
    expect(rowText(grid, 1, 0, 5)).toBe('line3');
    expect(rowText(grid, 2, 0, 5)).toBe('line4');
    expect(rowText(grid, 3, 0, 5)).toBe('line5');
  });

  it('node entirely above viewport — no crash', () => {
    const t = textNode('gone', {}, {
      x: 0, y: 0, width: 40, height: 2, wrappedLines: wl('gone', 'also'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 2 }, [t]);

    const grid = rasterize(root, 40, 4, 5);

    // Nothing written, all default spaces
    expect(rowText(grid, 0, 0, 4)).toBe('    ');
    expect(rowText(grid, 1, 0, 4)).toBe('    ');
  });

  it('node partially above viewport — partial top-clipping', () => {
    // Text node at y=3 with 4 wrapped lines, scrollOffset=5, viewportHeight=4
    // clippedLines = 5-3 = 2, so wrappedLines[2] ("line3") at grid row 0
    const t = textNode('line1 line2 line3 line4', {}, {
      x: 0, y: 3, width: 40, height: 4,
      wrappedLines: wl('line1', 'line2', 'line3', 'line4'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 7 }, [t]);

    const grid = rasterize(root, 40, 4, 5);

    expect(rowText(grid, 0, 0, 5)).toBe('line3');
    expect(rowText(grid, 1, 0, 5)).toBe('line4');
    // Rows 2 and 3 should be empty
    expect(rowText(grid, 2, 0, 5)).toBe('     ');
    expect(rowText(grid, 3, 0, 5)).toBe('     ');
  });

  it('partially clipped parent with visible child', () => {
    // Column box at y=2, height=6, containing two text children
    // First child at y=2, height=3 (fully clipped at scrollOffset=5)
    // Second child at y=5, height=3 (partially visible)
    const child1 = textNode('aaa bbb ccc', {}, {
      x: 0, y: 2, width: 40, height: 3,
      wrappedLines: wl('aaa', 'bbb', 'ccc'),
    });
    const child2 = textNode('ddd eee fff', {}, {
      x: 0, y: 5, width: 40, height: 3,
      wrappedLines: wl('ddd', 'eee', 'fff'),
    });
    const container = node('box', {}, { x: 0, y: 2, width: 40, height: 6 }, [child1, child2]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 8 }, [container]);

    const grid = rasterize(root, 40, 4, 5);

    // child1 at y=2..4 fully above scrollOffset=5 — skipped
    // child2 at y=5..7: grid row 0=ddd, row 1=eee, row 2=fff
    expect(rowText(grid, 0, 0, 3)).toBe('ddd');
    expect(rowText(grid, 1, 0, 3)).toBe('eee');
    expect(rowText(grid, 2, 0, 3)).toBe('fff');
    expect(rowText(grid, 3, 0, 3)).toBe('   ');
  });

  it('partially clipped parent with background', () => {
    // Parent box at y=2, height=6, backgroundColor="#303030"
    // First child at y=2, height=3 (fully clipped at scrollOffset=5)
    // Second child at y=5, height=3 (partially visible)
    const child1 = textNode('aaa bbb ccc', {}, {
      x: 0, y: 2, width: 10, height: 3,
      wrappedLines: wl('aaa', 'bbb', 'ccc'),
    });
    const child2 = textNode('ddd eee fff', {}, {
      x: 0, y: 5, width: 10, height: 3,
      wrappedLines: wl('ddd', 'eee', 'fff'),
    });
    const container = node('box', { backgroundColor: '#303030' },
      { x: 0, y: 2, width: 10, height: 6 }, [child1, child2]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 8 }, [container]);

    const grid = rasterize(root, 40, 4, 5);

    // Visible portion of parent's background: grid rows 0-2 (y=5,6,7 - scrollOffset=5)
    // Row 0 (y=5): background + text 'ddd'
    // Row 1 (y=6): background + text 'eee'
    // Row 2 (y=7): background + text 'fff'
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 10; col++) {
        expect(grid.cells[row]![col]!.bg.mode).toBe(ColorMode.RGB);
        expect(grid.cells[row]![col]!.bg.value).toBe(0x303030);
      }
    }
    // Row 3 should have no background (outside parent)
    expect(grid.cells[3]![0]!.bg.mode).toBe(ColorMode.Default);

    // Child text renders on top of background
    expect(rowText(grid, 0, 0, 3)).toBe('ddd');
    expect(rowText(grid, 1, 0, 3)).toBe('eee');
  });

  it('node below viewport — no crash', () => {
    const t = textNode('below', {}, {
      x: 0, y: 20, width: 40, height: 1, wrappedLines: wl('below'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 21 }, [t]);

    const grid = rasterize(root, 40, 10, 0);

    // Nothing written in the viewport — node is at y=20, viewport=10
    for (let r = 0; r < 10; r++) {
      expect(rowText(grid, r, 0, 5)).toBe('     ');
    }
  });
});

describe('rasterizer — segment styles', () => {
  it('renders segment styles on cell grid', () => {
    // Two segments: "bold " (bold) + "normal" (no style)
    const t = createNode('text', {
      segments: [
        { text: 'bold ', style: { bold: true } },
        { text: 'normal' },
      ],
    });
    const root = createNode('root', {});
    appendChild(root, t);

    layout(root, 40, 24);
    const grid = rasterize(root, 40, 24);

    // "bold " at cols 0-4 should be bold
    for (let c = 0; c < 5; c++) {
      expect(grid.cells[0]![c]!.attrs & Attr.Bold).toBe(Attr.Bold);
    }
    // "normal" at cols 5-10 should not be bold
    for (let c = 5; c < 11; c++) {
      expect(grid.cells[0]![c]!.attrs & Attr.Bold).toBe(0);
    }

    // Verify the text content
    expect(rowText(grid, 0, 0, 11)).toBe('bold normal');
  });

  it('segment fg color overrides inherited', () => {
    const t = createNode('text', {
      segments: [
        { text: 'red', style: { fg: '#ff0000' } },
        { text: 'blue', style: { fg: '#0000ff' } },
      ],
    });
    const root = createNode('root', {});
    appendChild(root, t);

    layout(root, 40, 24);
    const grid = rasterize(root, 40, 24);

    // "red" at cols 0-2
    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
    // "blue" at cols 3-6
    expect(grid.cells[0]![3]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![3]!.fg.value).toBe(0x0000ff);
  });

  it('segment style merges with inherited parent style', () => {
    // Parent box sets color red, segment adds bold
    const t = createNode('text', {
      segments: [
        { text: 'both', style: { bold: true } },
        { text: 'justcolor' },
      ],
    });
    const boxNode = createNode('box', { color: '#ff0000' });
    appendChild(boxNode, t);
    const root = createNode('root', {});
    appendChild(root, boxNode);

    layout(root, 40, 24);
    const grid = rasterize(root, 40, 24);

    // "both" should have red fg AND bold
    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
    expect(grid.cells[0]![0]!.attrs & Attr.Bold).toBe(Attr.Bold);

    // "justcolor" should have red fg but no bold
    expect(grid.cells[0]![4]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![4]!.fg.value).toBe(0xff0000);
    expect(grid.cells[0]![4]!.attrs & Attr.Bold).toBe(0);
  });
});


describe('rasterizer — borderStyle', () => {
  it('single border characters at correct positions', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'single' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hi';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 10, 10);
    const grid = rasterize(root, 10, 10);

    // Top row: ┌────────┐
    expect(grid.cells[0]![0]!.char).toBe('┌');
    expect(grid.cells[0]![1]!.char).toBe('─');
    expect(grid.cells[0]![8]!.char).toBe('─');
    expect(grid.cells[0]![9]!.char).toBe('┐');
    // Content row: │hi      │
    expect(grid.cells[1]![0]!.char).toBe('│');
    expect(grid.cells[1]![1]!.char).toBe('h');
    expect(grid.cells[1]![2]!.char).toBe('i');
    expect(grid.cells[1]![9]!.char).toBe('│');
    // Bottom row: └────────┘
    expect(grid.cells[2]![0]!.char).toBe('└');
    expect(grid.cells[2]![1]!.char).toBe('─');
    expect(grid.cells[2]![9]!.char).toBe('┘');
  });

  it('double border style', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'double' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'x';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 6, 10);
    const grid = rasterize(root, 6, 10);

    expect(grid.cells[0]![0]!.char).toBe('╔');
    expect(grid.cells[0]![1]!.char).toBe('═');
    expect(grid.cells[0]![5]!.char).toBe('╗');
    expect(grid.cells[1]![0]!.char).toBe('║');
    expect(grid.cells[1]![5]!.char).toBe('║');
    expect(grid.cells[2]![0]!.char).toBe('╚');
    expect(grid.cells[2]![5]!.char).toBe('╝');
  });

  it('borderColor applies to border characters', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'single', borderColor: '#ff0000' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'x';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 6, 10);
    const grid = rasterize(root, 6, 10);

    // Border chars should have red fg
    expect(grid.cells[0]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.fg.value).toBe(0xff0000);
    expect(grid.cells[1]![0]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[1]![0]!.fg.value).toBe(0xff0000);
    // Content should NOT have the border color (inherits default)
    expect(grid.cells[1]![1]!.fg.mode).toBe(ColorMode.Default);
  });

  it('border with background fills inside border', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'round', backgroundColor: '#303030' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'x';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 6, 10);
    const grid = rasterize(root, 6, 10);

    // Border corners
    expect(grid.cells[0]![0]!.char).toBe('╭');
    expect(grid.cells[2]![5]!.char).toBe('╯');
    // Background on border row
    expect(grid.cells[0]![0]!.bg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![0]!.bg.value).toBe(0x303030);
    // Background on content row
    expect(grid.cells[1]![1]!.bg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[1]![1]!.bg.value).toBe(0x303030);
  });
});

describe('per-line text alignment via alignItems', () => {
  function readRow(grid: CellGrid, row: number): string {
    return grid.cells[row]!.map(c => c.char).join('');
  }

  it('center — short text centered per-line', () => {
    const root = createNode('root', {});
    const b = createNode('box', { alignItems: 'center' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hi';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 10, 5);
    const grid = rasterize(root, 10, 5);

    // "hi" is 2 chars, width=10, slack=8, offset=4
    const row = readRow(grid, 0);
    expect(row).toBe('    hi    ');
  });

  it('center — wrapped text centers each line independently', () => {
    const root = createNode('root', {});
    const b = createNode('box', { alignItems: 'center' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hello world';  // wraps to ["hello", "world"] at width 8
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 8, 5);
    const grid = rasterize(root, 8, 5);

    // "hello" = 5 chars, slack = 3, offset = 1
    const row0 = readRow(grid, 0);
    expect(row0).toBe(' hello  ');
    // "world" = 5 chars, slack = 3, offset = 1
    const row1 = readRow(grid, 1);
    expect(row1).toBe(' world  ');
  });

  it('flex-end — text right-aligned per-line', () => {
    const root = createNode('root', {});
    const b = createNode('box', { alignItems: 'flex-end' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hi';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 10, 5);
    const grid = rasterize(root, 10, 5);

    // "hi" = 2 chars, slack = 8, right-aligned
    const row = readRow(grid, 0);
    expect(row).toBe('        hi');
  });

  it('center — segments centered per-line', () => {
    const root = createNode('root', {});
    const b = createNode('box', { alignItems: 'center' });
    const t = createNode('text', {
      segments: [
        { text: 'AB', style: { bold: true } },
        { text: 'CD', style: { fg: '#ff0000' } },
      ],
    });
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 10, 5);
    const grid = rasterize(root, 10, 5);

    // "ABCD" = 4 chars, slack = 6, offset = 3
    const row = readRow(grid, 0);
    expect(row).toBe('   ABCD   ');
    // Verify styles at correct positions
    expect(grid.cells[0]![3]!.attrs & Attr.Bold).toBe(Attr.Bold);
    expect(grid.cells[0]![5]!.fg.mode).toBe(ColorMode.RGB);
    expect(grid.cells[0]![5]!.fg.value).toBe(0xff0000);
  });

  it('center with border — text centered within border content area', () => {
    const root = createNode('root', {});
    const b = createNode('box', { alignItems: 'center', borderStyle: 'single' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hi';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 12, 5);
    const grid = rasterize(root, 12, 5);

    // Border at cols 0 and 11, content width = 10
    // "hi" = 2 chars, slack = 8, offset = 4
    // content starts at col 1, so "hi" at col 1+4=5
    const row1 = readRow(grid, 1);
    expect(row1).toBe('│    hi    │');
  });

  it('no alignment — text stays left', () => {
    const root = createNode('root', {});
    const b = createNode('box', {});
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'hi';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 10, 5);
    const grid = rasterize(root, 10, 5);

    const row = readRow(grid, 0);
    expect(row).toBe('hi        ');
  });
});
