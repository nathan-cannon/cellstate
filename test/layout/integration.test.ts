import { describe, test, expect } from 'bun:test';
import { createNode, appendChild, type TNode } from '../../src/core/nodes.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';
import type { FlexNode, FlexNodeFactory } from '../../src/layout/flex-node.js';

const factory = createFlexNodeFactory();

/** Helper: create a box TNode with a FlexNode and apply props. */
function box(props: Record<string, any> = {}): TNode {
  const fn = factory();
  const node = createNode('box', props, fn);
  applyBoxProps(fn, props);
  return node;
}

/** Helper: create a root TNode with a FlexNode. */
function root(width: number, props: Record<string, any> = {}): TNode {
  const fn = factory();
  const node = createNode('root', props, fn);
  applyBoxProps(fn, props, true);
  fn.setWidth(width);
  return node;
}

/** Helper: create a text TNode with a measure function. */
function text(content: string, props: Record<string, any> = {}): TNode {
  const fn = factory();
  const node = createNode('text', props, fn);
  // Text content lives on a text-instance child (same as reconciler)
  const inst = createNode('text', {});
  inst.text = content;
  appendChild(node, inst);
  fn.setMeasureFunc((width, widthMode) => computeTextLayout(node, width, widthMode));
  return node;
}

/** Helper: create a text TNode with segments. */
function segText(
  segments: { text: string; style?: Record<string, any> }[],
  props: Record<string, any> = {},
): TNode {
  const fn = factory();
  const fullProps = { ...props, segments };
  const node = createNode('text', fullProps, fn);
  fn.setMeasureFunc((width, widthMode) => computeTextLayout(node, width, widthMode));
  return node;
}

/** Helper: create a divider TNode with a FlexNode. */
function divider(props: Record<string, any> = {}): TNode {
  const fn = factory();
  const node = createNode('divider', props, fn);
  applyBoxProps(fn, props);
  fn.setHeight(1);
  return node;
}

/** Run layout: set root width, calculateLayout, populateLayoutResults. */
function doLayout(r: TNode, width?: number): void {
  if (width != null) r.flexNode!.setWidth(width);
  r.flexNode!.calculateLayout(width);
  populateLayoutResults(r);
}

/** Convert plain strings to WrappedLine format for assertions. */
function wl(...lines: string[]) {
  return lines.map(line => [{ text: line }]);
}

describe('Yoga-backed layout integration', () => {
  test('single text node', () => {
    const r = root(80);
    const t = text('hello world');
    appendChild(r, t);
    doLayout(r, 80);

    expect(r.layout).toMatchObject({ x: 0, y: 0, width: 80 });
    expect(t.layout!.x).toBe(0);
    expect(t.layout!.y).toBe(0);
    expect(t.layout!.width).toBe(80);
    expect(t.layout!.height).toBe(1);
    expect(t.layout!.wrappedLines).toEqual(wl('hello world'));
    r.flexNode!.freeRecursive();
  });

  test('text wrapping: long text at narrow width', () => {
    const r = root(5);
    const t = text('hello world');
    appendChild(r, t);
    doLayout(r, 5);

    expect(t.layout!.width).toBe(5);
    expect(t.layout!.height).toBe(2);
    expect(t.layout!.wrappedLines).toEqual(wl('hello', 'world'));
    r.flexNode!.freeRecursive();
  });

  test('column layout: 3 text nodes stack vertically', () => {
    const r = root(80);
    const t1 = text('line one');
    const t2 = text('line two');
    const t3 = text('line three');
    appendChild(r, t1);
    appendChild(r, t2);
    appendChild(r, t3);
    doLayout(r, 80);

    expect(t1.layout!.y).toBe(0);
    expect(t2.layout!.y).toBe(1);
    expect(t3.layout!.y).toBe(2);
    r.flexNode!.freeRecursive();
  });

  test('row layout: 2 boxes side by side', () => {
    const r = root(80, { flexDirection: 'row' });
    const b1 = box({ width: 30, height: 5 });
    const b2 = box({ width: 50, height: 5 });
    appendChild(r, b1);
    appendChild(r, b2);
    doLayout(r, 80);

    expect(b1.layout!.x).toBe(0);
    expect(b1.layout!.width).toBe(30);
    expect(b2.layout!.x).toBe(30);
    expect(b2.layout!.width).toBe(50);
    r.flexNode!.freeRecursive();
  });

  test('flexGrow: child fills remaining space', () => {
    const r = root(80, { flexDirection: 'row' });
    const fixed = box({ width: 20, height: 5 });
    const grow = box({ flexGrow: 1, height: 5 });
    appendChild(r, fixed);
    appendChild(r, grow);
    doLayout(r, 80);

    expect(fixed.layout!.width).toBe(20);
    expect(grow.layout!.width).toBe(60);
    r.flexNode!.freeRecursive();
  });

  test('padding: child offset by padding', () => {
    const r = root(80);
    const b = box({ padding: 2, width: 80 });
    const t = text('inner');
    appendChild(b, t);
    appendChild(r, b);
    doLayout(r, 80);

    expect(t.layout!.x).toBe(2);
    expect(t.layout!.y).toBe(2);
    // Text gets width = 80 - 2(padL) - 2(padR) = 76
    expect(t.layout!.width).toBe(76);
    r.flexNode!.freeRecursive();
  });

  test('margin: child with marginTop spaced from sibling', () => {
    const r = root(80);
    const t1 = text('first');
    const t2 = text('second', { marginTop: 1 });
    // marginTop is a box-level prop but text nodes in CellState don't have it.
    // We apply it at the FlexNode level through the parent.
    // Actually, text nodes wrapped in boxes get margins from the box.
    // For this test, use boxes wrapping text.
    r.flexNode!.freeRecursive();

    // Redo with boxes
    const r2 = root(80);
    const b1 = box({ height: 3 });
    const b2 = box({ height: 3, marginTop: 1 });
    appendChild(r2, b1);
    appendChild(r2, b2);
    doLayout(r2, 80);

    expect(b1.layout!.y).toBe(0);
    expect(b2.layout!.y).toBe(4); // 3 + 1 margin
    r2.flexNode!.freeRecursive();
  });

  test('border: box with borderStyle accounts for 1-cell border in child positioning', () => {
    const r = root(80);
    const b = box({ borderStyle: 'single', width: 80 });
    const t = text('bordered');
    appendChild(b, t);
    appendChild(r, b);
    doLayout(r, 80);

    // Border is 1 on all sides
    expect(t.layout!.x).toBe(1);
    expect(t.layout!.y).toBe(1);
    expect(t.layout!.width).toBe(78); // 80 - 1 - 1
    r.flexNode!.freeRecursive();
  });

  test('nested boxes: absolute positions accumulate', () => {
    const r = root(80);
    const outer = box({ padding: 2, width: 80 });
    const inner = box({ padding: 1, width: 76 });
    const t = text('deep');
    appendChild(inner, t);
    appendChild(outer, inner);
    appendChild(r, outer);
    doLayout(r, 80);

    // outer starts at (0,0), inner at (2,2) due to outer padding
    // text at (2+1, 2+1) = (3, 3) due to inner padding
    expect(outer.layout!.x).toBe(0);
    expect(inner.layout!.x).toBe(2);
    expect(t.layout!.x).toBe(3);
    expect(t.layout!.y).toBe(3);
    expect(t.layout!.width).toBe(74); // 76 - 1 - 1
    r.flexNode!.freeRecursive();
  });

  test('alignItems center: text node centered within wider parent', () => {
    const r = root(80, { alignItems: 'center' });
    const b = box({ width: 40, height: 5 });
    appendChild(r, b);
    doLayout(r, 80);

    expect(b.layout!.x).toBe(20); // (80 - 40) / 2
    r.flexNode!.freeRecursive();
  });

  test('justifyContent space-between: 3 children spread across fixed-height box', () => {
    const r = root(80, { height: 30, justifyContent: 'space-between' });
    const c1 = box({ height: 5 });
    const c2 = box({ height: 5 });
    const c3 = box({ height: 5 });
    appendChild(r, c1);
    appendChild(r, c2);
    appendChild(r, c3);
    doLayout(r, 80);

    // 30 total - 15 used = 15 space / 2 gaps = 7.5 per gap
    expect(c1.layout!.y).toBe(0);
    // Yoga rounds — check reasonable positioning
    expect(c2.layout!.y).toBeGreaterThanOrEqual(12);
    expect(c2.layout!.y).toBeLessThanOrEqual(13);
    expect(c3.layout!.y).toBe(25); // 30 - 5
    r.flexNode!.freeRecursive();
  });

  test('display none: child has zero size and does not affect siblings', () => {
    const r = root(80);
    const t1 = text('visible');
    const hidden = box({ display: 'none', height: 10 });
    const t2 = text('after');
    appendChild(r, t1);
    appendChild(r, hidden);
    appendChild(r, t2);
    doLayout(r, 80);

    expect(hidden.layout!.width).toBe(0);
    expect(hidden.layout!.height).toBe(0);
    // t2 should come right after t1
    expect(t2.layout!.y).toBe(1);
    r.flexNode!.freeRecursive();
  });

  test('divider: height=1, full width', () => {
    const r = root(80);
    const d = divider();
    appendChild(r, d);
    doLayout(r, 80);

    expect(d.layout!.height).toBe(1);
    expect(d.layout!.width).toBe(80);
    r.flexNode!.freeRecursive();
  });

  test('segments with styles: wrappedLines preserve styles', () => {
    const r = root(80);
    const t = segText([
      { text: 'hello ', style: { bold: true } },
      { text: 'world', style: { fg: '#ff0000' } },
    ]);
    appendChild(r, t);
    doLayout(r, 80);

    expect(t.layout!.height).toBe(1);
    const lines = t.layout!.wrappedLines!;
    expect(lines.length).toBe(1);
    expect(lines[0]!.length).toBe(2);
    expect(lines[0]![0]!.text).toBe('hello ');
    expect(lines[0]![0]!.style).toEqual({ bold: true });
    expect(lines[0]![1]!.text).toBe('world');
    expect(lines[0]![1]!.style).toEqual({ fg: '#ff0000' });
    r.flexNode!.freeRecursive();
  });

  test('hanging indent: continuation lines indented', () => {
    const r = root(10);
    const t = text('aaaa bbbb cccc dddd', { hangingIndent: 2 });
    appendChild(r, t);
    doLayout(r, 10);

    expect(t.layout!.wrappedLines).toEqual(wl('aaaa bbbb', 'cccc', 'dddd'));
    expect(t.layout!.hangingIndent).toBe(2);
    r.flexNode!.freeRecursive();
  });

  test('truncation: text with wrap=truncate collapses to single line', () => {
    const r = root(10);
    const t = text('hello world this is long', { wrap: 'truncate' });
    appendChild(r, t);
    doLayout(r, 10);

    expect(t.layout!.height).toBe(1);
    const lines = t.layout!.wrappedLines!;
    expect(lines.length).toBe(1);
    // Should end with ellipsis
    const lineText = lines[0]!.map(run => run.text).join('');
    expect(lineText).toContain('\u2026');
    r.flexNode!.freeRecursive();
  });

  test('mixed content: header + bordered box with padded text + footer', () => {
    const r = root(40);

    const header = text('Header');
    const bordered = box({ borderStyle: 'single', padding: 1, width: 40 });
    const inner = text('Content');
    appendChild(bordered, inner);
    const footer = text('Footer');

    appendChild(r, header);
    appendChild(r, bordered);
    appendChild(r, footer);
    doLayout(r, 40);

    // Header at y=0
    expect(header.layout!.y).toBe(0);
    expect(header.layout!.height).toBe(1);

    // Bordered box at y=1
    expect(bordered.layout!.y).toBe(1);
    expect(bordered.layout!.width).toBe(40);

    // Inner text inside border(1) + padding(1) = 2 from each edge
    expect(inner.layout!.x).toBe(2); // border + padding
    expect(inner.layout!.y).toBe(3); // 1 (header) + 1 (border top) + 1 (padding top)
    expect(inner.layout!.width).toBe(36); // 40 - 2 - 2

    // Bordered box height = 1(border) + 1(pad) + 1(text) + 1(pad) + 1(border) = 5
    expect(bordered.layout!.height).toBe(5);

    // Footer after bordered box
    expect(footer.layout!.y).toBe(6); // 1 (header) + 5 (bordered)
    r.flexNode!.freeRecursive();
  });

  test('text node textAlign from parent alignItems center', () => {
    const r = root(80, { alignItems: 'center' });
    const t = text('short');
    appendChild(r, t);
    doLayout(r, 80);

    expect(t.layout!.textAlign).toBe('center');
    r.flexNode!.freeRecursive();
  });

  test('contentHeight from root layout', () => {
    const r = root(80);
    const t1 = text('line 1');
    const t2 = text('line 2');
    const t3 = text('line 3');
    appendChild(r, t1);
    appendChild(r, t2);
    appendChild(r, t3);
    doLayout(r, 80);

    expect(r.layout!.height).toBe(3);
    r.flexNode!.freeRecursive();
  });
});

// ─── New prop tests ─────────────────────────────────────────────────────

describe('Dimension constraints', () => {
  test('minWidth: box respects minimum width', () => {
    const r = root(100);
    const b = box({ minWidth: 20 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBeGreaterThanOrEqual(20);
    r.flexNode!.freeRecursive();
  });

  test('maxWidth: box clamped to maximum width', () => {
    const r = root(100);
    const b = box({ maxWidth: 30 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBe(30);
    r.flexNode!.freeRecursive();
  });

  test('minHeight: box respects minimum height', () => {
    const r = root(80);
    const b = box({ minHeight: 10 });
    appendChild(r, b);
    doLayout(r, 80);

    expect(b.layout!.height).toBeGreaterThanOrEqual(10);
    r.flexNode!.freeRecursive();
  });

  test('maxHeight: box clamped to maximum height', () => {
    const r = root(80);
    const b = box({ height: 50, maxHeight: 20 });
    appendChild(r, b);
    doLayout(r, 80);

    expect(b.layout!.height).toBe(20);
    r.flexNode!.freeRecursive();
  });
});

describe('Percentage dimensions', () => {
  test('widthPercent=50 in 100-wide parent', () => {
    const r = root(100);
    const b = box({ widthPercent: 50, height: 5 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBe(50);
    r.flexNode!.freeRecursive();
  });

  test('flexBasis="50%" in a row', () => {
    const r = root(100, { flexDirection: 'row' });
    const b = box({ flexBasis: '50%', height: 5 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBe(50);
    r.flexNode!.freeRecursive();
  });
});

describe('Flex features', () => {
  test('flexShrink: child shrinks when siblings exceed available width', () => {
    const r = root(100, { flexDirection: 'row' });
    const a = box({ width: 80, height: 5 });
    const b = box({ width: 80, height: 5, flexShrink: 1 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    // b should shrink to fit: 100 - 80 = 20
    expect(b.layout!.width).toBe(20);
    r.flexNode!.freeRecursive();
  });

  test('flexBasis: child with numeric flexBasis', () => {
    const r = root(100, { flexDirection: 'row' });
    const b = box({ flexBasis: 20, height: 5 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBe(20);
    r.flexNode!.freeRecursive();
  });

  test('flexWrap: children wrap to next line', () => {
    const r = root(100, { flexDirection: 'row', flexWrap: 'wrap' });
    const a = box({ width: 60, height: 5 });
    const b = box({ width: 60, height: 5 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    // a and b don't fit in one row, b wraps to next line
    expect(a.layout!.y).toBe(0);
    expect(b.layout!.y).toBe(5);
    r.flexNode!.freeRecursive();
  });
});

describe('Positioning', () => {
  test('absolute positioning: box independent of siblings', () => {
    const r = root(100);
    const sibling = box({ height: 20 });
    const abs = box({ position: 'absolute', top: 5, left: 10, width: 30, height: 15 });
    appendChild(r, sibling);
    appendChild(r, abs);
    doLayout(r, 100);

    expect(abs.layout!.x).toBe(10);
    expect(abs.layout!.y).toBe(5);
    expect(abs.layout!.width).toBe(30);
    expect(abs.layout!.height).toBe(15);
    r.flexNode!.freeRecursive();
  });

  test('aspectRatio: width=10, ratio=2 gives height=5', () => {
    const r = root(100);
    const b = box({ width: 10, aspectRatio: 2 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.width).toBe(10);
    expect(b.layout!.height).toBe(5);
    r.flexNode!.freeRecursive();
  });
});

describe('Alignment', () => {
  test('alignSelf: one child overrides parent alignItems', () => {
    const r = root(100, { alignItems: 'flex-start' });
    const a = box({ width: 20, height: 5 });
    const b = box({ width: 20, height: 5, alignSelf: 'center' });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    // a at flex-start: x=0
    expect(a.layout!.x).toBe(0);
    // b overrides with alignSelf=center: x = (100-20)/2 = 40
    expect(b.layout!.x).toBe(40);
    r.flexNode!.freeRecursive();
  });

  test('alignContent: multi-line wrapped container', () => {
    const r = root(100, {
      flexDirection: 'row',
      flexWrap: 'wrap',
      height: 30,
      alignContent: 'center',
    });
    const a = box({ width: 60, height: 5 });
    const b = box({ width: 60, height: 5 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    // Two rows of height 5 = 10 total, centered in 30: offset = (30-10)/2 = 10
    expect(a.layout!.y).toBe(10);
    expect(b.layout!.y).toBe(15);
    r.flexNode!.freeRecursive();
  });
});

describe('Gap axes', () => {
  test('columnGap in a row layout', () => {
    const r = root(100, { flexDirection: 'row', columnGap: 5 });
    const a = box({ width: 20, height: 5 });
    const b = box({ width: 20, height: 5 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    expect(a.layout!.x).toBe(0);
    expect(b.layout!.x).toBe(25); // 20 + 5
    r.flexNode!.freeRecursive();
  });

  test('rowGap in a column layout', () => {
    const r = root(100, { rowGap: 3 });
    const a = box({ height: 5 });
    const b = box({ height: 5 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    expect(a.layout!.y).toBe(0);
    expect(b.layout!.y).toBe(8); // 5 + 3
    r.flexNode!.freeRecursive();
  });

  test('gap + columnGap override: columnGap wins on horizontal axis', () => {
    const r = root(100, { flexDirection: 'row', gap: 10, columnGap: 2 });
    const a = box({ width: 20, height: 5 });
    const b = box({ width: 20, height: 5 });
    appendChild(r, a);
    appendChild(r, b);
    doLayout(r, 100);

    expect(a.layout!.x).toBe(0);
    expect(b.layout!.x).toBe(22); // 20 + 2 (columnGap overrides gap)
    r.flexNode!.freeRecursive();
  });
});

describe('Spacing shorthands', () => {
  test('marginX=2: marginLeft and marginRight both 2', () => {
    const r = root(100);
    const b = box({ marginX: 2, height: 5 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.x).toBe(2);
    expect(b.layout!.width).toBe(96); // 100 - 2 - 2
    r.flexNode!.freeRecursive();
  });

  test('paddingY=3: paddingTop and paddingBottom both 3', () => {
    const r = root(100);
    const b = box({ paddingY: 3 });
    const t = text('hello');
    appendChild(b, t);
    appendChild(r, b);
    doLayout(r, 100);

    expect(t.layout!.y).toBe(3); // paddingTop=3
    expect(b.layout!.height).toBe(7); // 3 + 1 + 3
    r.flexNode!.freeRecursive();
  });

  test('marginX=2 + marginLeft=5: left is 5, right is 2', () => {
    const r = root(100);
    const b = box({ marginX: 2, marginLeft: 5, height: 5 });
    appendChild(r, b);
    doLayout(r, 100);

    expect(b.layout!.x).toBe(5);
    expect(b.layout!.width).toBe(93); // 100 - 5 - 2
    r.flexNode!.freeRecursive();
  });
});

describe('Overflow', () => {
  test('overflow hidden: children do not expand parent beyond fixed height', () => {
    const r = root(80);
    const b = box({ height: 5, overflow: 'hidden' });
    // Add content taller than 5
    for (let i = 0; i < 10; i++) {
      appendChild(b, text(`line ${i}`));
    }
    appendChild(r, b);
    doLayout(r, 80);

    // Box height stays at 5 despite 10 lines of content
    expect(b.layout!.height).toBe(5);
    r.flexNode!.freeRecursive();
  });
});
