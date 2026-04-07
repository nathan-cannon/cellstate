import { describe, it, expect } from 'bun:test';
import { paintTree } from '../../src/core/paint.js';
import { createNode, appendChild, type TNode, type LayoutResult, type WrappedLine } from '../../src/core/nodes.js';
import { Attr, ColorMode } from '../../src/core/cell.js';
import { CharTable, SPACE_CHAR, EMPTY_CHAR } from '../../src/core/char-table.js';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { LinkTable, NO_LINK } from '../../src/core/link-table.js';
import {
  createCellBuffer,
  clearBuffer,
  readCell,
  bufferToText,
  NORMAL_WIDTH,
  WIDE_WIDTH,
  CONTINUATION_WIDTH,
  type CellBuffer,
} from '../../src/core/cell-buffer.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';

const _factory = createFlexNodeFactory();

/** Attach FlexNodes to a TNode tree and run Yoga layout. */
function layout(root: TNode, width: number, _height: number): void {
  attachFlexNodes(root);
  root.flexNode!.setWidth(width);
  root.flexNode!.calculateLayout(width);
  populateLayoutResults(root);
}

function attachFlexNodes(node: TNode): void {
  const fn = _factory();
  node.flexNode = fn;
  if (node.type === 'text') {
    if (node.text === null) {
      fn.setMeasureFunc((w, wm) => computeTextLayout(node, w, wm));
    }
  } else if (node.type === 'divider') {
    applyBoxProps(fn, node.props);
    fn.setHeight(1);
  } else {
    applyBoxProps(fn, node.props, node.type === 'root');
  }
  for (const child of node.children) {
    if (child.text !== null) continue;
    attachFlexNodes(child);
    fn.insertChild(child.flexNode!, fn.getChildCount());
  }
}

function makeTables() {
  return { ct: new CharTable(), st: new StyleTable(), lt: new LinkTable() };
}

/** Convert plain strings to WrappedLine format */
function wl(...lines: string[]): WrappedLine[] {
  return lines.map(line => [{ text: line }]);
}

/** Helper: create a node with layout set directly */
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

/** Helper: create a text element node with layout */
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

/** Paint a tree into a fresh buffer */
function paint(root: TNode, width: number, height: number, scrollOffset = 0) {
  const tables = makeTables();
  const buf = createCellBuffer(width, height);
  paintTree(root, buf, null, tables.ct, tables.st, tables.lt, scrollOffset);
  return { buf, ...tables };
}

/** Read a row of chars from the buffer as a string */
function rowText(buf: CellBuffer, ct: CharTable, row: number, startCol = 0, len?: number): string {
  const end = len != null ? startCol + len : buf.width;
  let s = '';
  for (let c = startCol; c < end && c < buf.width; c++) {
    const cell = readCell(buf, row, c);
    if (!cell) break;
    if (cell.width === CONTINUATION_WIDTH) {
      s += ct.resolve(cell.charId);
      continue;
    }
    s += ct.resolve(cell.charId);
  }
  return s;
}

/** Read a full row as a string (including continuation cells as their chars) */
function fullRow(buf: CellBuffer, ct: CharTable, row: number): string {
  let s = '';
  for (let c = 0; c < buf.width; c++) {
    const cell = readCell(buf, row, c)!;
    s += ct.resolve(cell.charId);
  }
  return s;
}

describe('paint — basic text', () => {
  it('single text renders at correct position', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, ct } = paint(root, 40, 10);

    expect(rowText(buf, ct, 0, 0, 5)).toBe('hello');
    expect(ct.resolve(readCell(buf, 0, 5)!.charId)).toBe(' ');
  });

  it('text at offset position', () => {
    const t = textNode('hello', {}, {
      x: 4, y: 0, width: 36, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, ct } = paint(root, 40, 10);

    expect(ct.resolve(readCell(buf, 0, 3)!.charId)).toBe(' ');
    expect(rowText(buf, ct, 0, 4, 5)).toBe('hello');
  });

  it('wrapped text', () => {
    const t = textNode('hello world', {}, {
      x: 0, y: 0, width: 5, height: 2, wrappedLines: wl('hello', 'world'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, ct } = paint(root, 40, 10);

    expect(rowText(buf, ct, 0, 0, 5)).toBe('hello');
    expect(rowText(buf, ct, 1, 0, 5)).toBe('world');
  });

  it('hanging indent rendering', () => {
    const t = textNode('aaaa bbbb cccc dddd', {}, {
      x: 0, y: 0, width: 10, height: 3,
      wrappedLines: wl('aaaa bbbb', 'cccc', 'dddd'),
      hangingIndent: 2,
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, ct } = paint(root, 40, 10);

    expect(rowText(buf, ct, 0, 0, 9)).toBe('aaaa bbbb');
    expect(ct.resolve(readCell(buf, 1, 0)!.charId)).toBe(' ');
    expect(ct.resolve(readCell(buf, 1, 1)!.charId)).toBe(' ');
    expect(rowText(buf, ct, 1, 2, 4)).toBe('cccc');
    expect(rowText(buf, ct, 2, 2, 4)).toBe('dddd');
  });
});

describe('paint — styles', () => {
  it('foreground color produces correct style ID', () => {
    const t = textNode('hi', { color: '#ff0000' }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hi'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, st } = paint(root, 40, 10);

    const cell = readCell(buf, 0, 0)!;
    expect(cell.styleId).not.toBe(DEFAULT_STYLE);
    const style = st.resolve(cell.styleId);
    expect(style.fgMode).toBe(ColorMode.RGB);
    expect(style.fgValue).toBe(0xff0000);
  });

  it('bold attribute', () => {
    const t = textNode('hi', { bold: true }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hi'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, st } = paint(root, 40, 10);

    const style = st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(style.attrs & Attr.Bold).toBe(Attr.Bold);
    expect(st.resolve(readCell(buf, 0, 1)!.styleId).attrs & Attr.Bold).toBe(Attr.Bold);
  });

  it('multiple attributes combined', () => {
    const t = textNode('x', { bold: true, italic: true, underline: true }, {
      x: 0, y: 0, width: 10, height: 1, wrappedLines: wl('x'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, st } = paint(root, 10, 1);

    const style = st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(style.attrs & Attr.Bold).toBe(Attr.Bold);
    expect(style.attrs & Attr.Italic).toBe(Attr.Italic);
    expect(style.attrs & Attr.Underline).toBe(Attr.Underline);
  });

  it('nested style inheritance (parent bold + child color)', () => {
    const t = textNode('hello', { color: '#00ff00' }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const box = node('box', { bold: true }, { x: 0, y: 0, width: 40, height: 1 }, [t]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [box]);
    const { buf, st } = paint(root, 40, 10);

    const style = st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(style.attrs & Attr.Bold).toBe(Attr.Bold);
    expect(style.fgMode).toBe(ColorMode.RGB);
    expect(style.fgValue).toBe(0x00ff00);
  });

  it('style inheritance three levels deep', () => {
    const t = textNode('hello', {}, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hello'),
    });
    const inner = node('box', {}, { x: 0, y: 0, width: 40, height: 1 }, [t]);
    const outer = node('box', { color: '#ff0000' }, { x: 0, y: 0, width: 40, height: 1 }, [inner]);
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [outer]);
    const { buf, st } = paint(root, 40, 10);

    const style = st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(style.fgMode).toBe(ColorMode.RGB);
    expect(style.fgValue).toBe(0xff0000);
  });
});

describe('paint — background fills', () => {
  it('background color on text fills full width', () => {
    const t = textNode('hello', { backgroundColor: '#303030' }, {
      x: 0, y: 0, width: 20, height: 1, wrappedLines: wl('hello'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 10 }, [t]);
    const { buf, st } = paint(root, 40, 10);

    for (let c = 0; c < 20; c++) {
      const style = st.resolve(readCell(buf, 0, c)!.styleId);
      expect(style.bgMode).toBe(ColorMode.RGB);
      expect(style.bgValue).toBe(0x303030);
    }
    // Cell outside text's width should be default
    expect(readCell(buf, 0, 20)!.styleId).toBe(DEFAULT_STYLE);
  });
});

describe('paint — wide characters', () => {
  it('CJK characters produce wide + continuation cells', () => {
    const t = textNode('你好', {}, {
      x: 0, y: 0, width: 10, height: 1, wrappedLines: [[{ text: '你好' }]],
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    const c0 = readCell(buf, 0, 0)!;
    expect(ct.resolve(c0.charId)).toBe('你');
    expect(c0.width).toBe(WIDE_WIDTH);
    const c1 = readCell(buf, 0, 1)!;
    expect(c1.charId).toBe(EMPTY_CHAR);
    expect(c1.width).toBe(CONTINUATION_WIDTH);
    const c2 = readCell(buf, 0, 2)!;
    expect(ct.resolve(c2.charId)).toBe('好');
    expect(c2.width).toBe(WIDE_WIDTH);
  });

  it('emoji with VS16 produces correct width', () => {
    const t = textNode('', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: [[{ text: '☀\uFE0F' }]],
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    const c0 = readCell(buf, 0, 0)!;
    expect(ct.resolve(c0.charId)).toBe('☀\uFE0F');
    expect(c0.width).toBe(WIDE_WIDTH);
    expect(readCell(buf, 0, 1)!.width).toBe(CONTINUATION_WIDTH);
  });

  it('text-presentation emoji without VS16 stays width 1', () => {
    const t = textNode('', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: [[{ text: '☀' }]],
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    const c0 = readCell(buf, 0, 0)!;
    expect(ct.resolve(c0.charId)).toBe('☀');
    expect(c0.width).toBe(NORMAL_WIDTH);
  });

  it('combining marks attach to previous cell', () => {
    const t = textNode('e\u0301x', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: [[{ text: 'e\u0301x' }]],
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    expect(ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('e\u0301');
    expect(readCell(buf, 0, 0)!.width).toBe(NORMAL_WIDTH);
    expect(ct.resolve(readCell(buf, 0, 1)!.charId)).toBe('x');
  });

  it('ZWJ sequences stay as single cells', () => {
    // 👨‍👩‍👧 = U+1F468 ZWJ U+1F469 ZWJ U+1F467
    const family = '👨\u200D👩\u200D👧';
    const t = textNode('', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: [[{ text: family }]],
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    // The entire ZWJ sequence should be in one cell
    const c0 = readCell(buf, 0, 0)!;
    expect(ct.resolve(c0.charId)).toBe(family);
    expect(c0.width).toBe(WIDE_WIDTH);
  });
});

describe('paint — borders', () => {
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
    const tables = makeTables();
    const buf = createCellBuffer(10, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    expect(tables.ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('┌');
    expect(tables.ct.resolve(readCell(buf, 0, 1)!.charId)).toBe('─');
    expect(tables.ct.resolve(readCell(buf, 0, 9)!.charId)).toBe('┐');
    expect(tables.ct.resolve(readCell(buf, 1, 0)!.charId)).toBe('│');
    expect(tables.ct.resolve(readCell(buf, 1, 1)!.charId)).toBe('h');
    expect(tables.ct.resolve(readCell(buf, 1, 2)!.charId)).toBe('i');
    expect(tables.ct.resolve(readCell(buf, 1, 9)!.charId)).toBe('│');
    expect(tables.ct.resolve(readCell(buf, 2, 0)!.charId)).toBe('└');
    expect(tables.ct.resolve(readCell(buf, 2, 9)!.charId)).toBe('┘');
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
    const tables = makeTables();
    const buf = createCellBuffer(6, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    expect(tables.ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('╔');
    expect(tables.ct.resolve(readCell(buf, 0, 5)!.charId)).toBe('╗');
    expect(tables.ct.resolve(readCell(buf, 1, 0)!.charId)).toBe('║');
    expect(tables.ct.resolve(readCell(buf, 2, 0)!.charId)).toBe('╚');
    expect(tables.ct.resolve(readCell(buf, 2, 5)!.charId)).toBe('╝');
  });

  it('round border style', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'round' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'x';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 6, 10);
    const tables = makeTables();
    const buf = createCellBuffer(6, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    expect(tables.ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('╭');
    expect(tables.ct.resolve(readCell(buf, 2, 5)!.charId)).toBe('╯');
  });

  it('bold border style', () => {
    const root = createNode('root', {});
    const b = createNode('box', { borderStyle: 'bold' });
    const t = createNode('text', {});
    const inst = createNode('text', {});
    inst.text = 'x';
    appendChild(t, inst);
    appendChild(b, t);
    appendChild(root, b);

    layout(root, 6, 10);
    const tables = makeTables();
    const buf = createCellBuffer(6, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    expect(tables.ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('┏');
    expect(tables.ct.resolve(readCell(buf, 0, 5)!.charId)).toBe('┓');
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
    const tables = makeTables();
    const buf = createCellBuffer(6, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    const borderStyle = tables.st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(borderStyle.fgMode).toBe(ColorMode.RGB);
    expect(borderStyle.fgValue).toBe(0xff0000);
    // Content should NOT have border color
    expect(readCell(buf, 1, 1)!.styleId).toBe(DEFAULT_STYLE);
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
    const tables = makeTables();
    const buf = createCellBuffer(6, 10);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    expect(tables.ct.resolve(readCell(buf, 0, 0)!.charId)).toBe('╭');
    // Background on border character
    const borderStyle = tables.st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(borderStyle.bgMode).toBe(ColorMode.RGB);
    expect(borderStyle.bgValue).toBe(0x303030);
    // Background on content area
    const contentStyle = tables.st.resolve(readCell(buf, 1, 1)!.styleId);
    expect(contentStyle.bgMode).toBe(ColorMode.RGB);
    expect(contentStyle.bgValue).toBe(0x303030);
  });
});

describe('paint — text alignment', () => {
  it('center alignment positions text correctly', () => {
    const t = textNode('hi', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: wl('hi'),
      textAlign: 'center',
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    // "hi" = 2 chars, slack = 8, offset = 4
    expect(fullRow(buf, ct, 0)).toBe('    hi    ');
  });

  it('right alignment positions text correctly', () => {
    const t = textNode('hi', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: wl('hi'),
      textAlign: 'right',
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    expect(fullRow(buf, ct, 0)).toBe('        hi');
  });

  it('center alignment accounts for display width of CJK', () => {
    const t = textNode('你好', {}, {
      x: 0, y: 0, width: 10, height: 1,
      wrappedLines: [[{ text: '你好' }]],
      textAlign: 'center',
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 1 }, [t]);
    const { buf, ct } = paint(root, 10, 1);

    // 你好 = 4 display cols, slack = 6, offset = 3
    expect(ct.resolve(readCell(buf, 0, 3)!.charId)).toBe('你');
    expect(readCell(buf, 0, 3)!.width).toBe(WIDE_WIDTH);
  });
});

describe('paint — segment styles', () => {
  it('renders segment styles correctly', () => {
    const t = createNode('text', {
      segments: [
        { text: 'bold ', style: { bold: true } },
        { text: 'normal' },
      ],
    });
    const root = createNode('root', {});
    appendChild(root, t);

    layout(root, 40, 24);
    const tables = makeTables();
    const buf = createCellBuffer(40, 24);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    // "bold " at cols 0-4 should be bold
    for (let c = 0; c < 5; c++) {
      const style = tables.st.resolve(readCell(buf, 0, c)!.styleId);
      expect(style.attrs & Attr.Bold).toBe(Attr.Bold);
    }
    // "normal" at cols 5-10 should not be bold
    for (let c = 5; c < 11; c++) {
      const style = tables.st.resolve(readCell(buf, 0, c)!.styleId);
      expect(style.attrs & Attr.Bold).toBe(0);
    }

    expect(bufferToText(buf, tables.ct).split('\n')[0]!.trimEnd()).toContain('bold normal');
  });

  it('segment style merges with inherited parent style', () => {
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
    const tables = makeTables();
    const buf = createCellBuffer(40, 24);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt);

    // "both" should have red fg AND bold
    const s0 = tables.st.resolve(readCell(buf, 0, 0)!.styleId);
    expect(s0.fgMode).toBe(ColorMode.RGB);
    expect(s0.fgValue).toBe(0xff0000);
    expect(s0.attrs & Attr.Bold).toBe(Attr.Bold);

    // "justcolor" should have red fg but no bold
    const s4 = tables.st.resolve(readCell(buf, 0, 4)!.styleId);
    expect(s4.fgMode).toBe(ColorMode.RGB);
    expect(s4.fgValue).toBe(0xff0000);
    expect(s4.attrs & Attr.Bold).toBe(0);
  });
});

describe('paint — display: none', () => {
  it('display none produces no output', () => {
    const t = textNode('hidden', { display: 'none' }, {
      x: 0, y: 0, width: 40, height: 1, wrappedLines: wl('hidden'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 5 }, [t]);
    const { buf, ct } = paint(root, 10, 5);

    expect(bufferToText(buf, ct)).toBe('\n\n\n\n');
  });
});

describe('paint — divider', () => {
  it('divider renders as a full-width line', () => {
    const d = createNode('divider', { char: '─' });
    d.layout = { x: 0, y: 0, width: 10, height: 1 };
    const root = node('root', {}, { x: 0, y: 0, width: 10, height: 5 }, [d]);
    const { buf, ct } = paint(root, 10, 5);

    for (let c = 0; c < 10; c++) {
      expect(ct.resolve(readCell(buf, 0, c)!.charId)).toBe('─');
    }
  });
});

describe('paint — scroll offset', () => {
  it('scroll offset shifts content correctly', () => {
    const children: TNode[] = [];
    for (let i = 0; i < 6; i++) {
      children.push(
        textNode(`line${i}`, {}, {
          x: 0, y: i, width: 40, height: 1, wrappedLines: wl(`line${i}`),
        }),
      );
    }
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 6 }, children);
    const { buf, ct } = paint(root, 40, 4, 2);

    expect(rowText(buf, ct, 0, 0, 5)).toBe('line2');
    expect(rowText(buf, ct, 1, 0, 5)).toBe('line3');
    expect(rowText(buf, ct, 2, 0, 5)).toBe('line4');
    expect(rowText(buf, ct, 3, 0, 5)).toBe('line5');
  });

  it('node entirely above viewport — no content', () => {
    const t = textNode('gone', {}, {
      x: 0, y: 0, width: 40, height: 2, wrappedLines: wl('gone', 'also'),
    });
    const root = node('root', {}, { x: 0, y: 0, width: 40, height: 2 }, [t]);
    const { buf, ct } = paint(root, 40, 4, 5);

    expect(rowText(buf, ct, 0, 0, 4)).toBe('    ');
  });

  it('partially clipped parent with visible child', () => {
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
    const { buf, ct } = paint(root, 40, 4, 5);

    expect(rowText(buf, ct, 0, 0, 3)).toBe('ddd');
    expect(rowText(buf, ct, 1, 0, 3)).toBe('eee');
    expect(rowText(buf, ct, 2, 0, 3)).toBe('fff');
  });
});

