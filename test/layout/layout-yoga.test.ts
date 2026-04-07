/**
 * Migrated layout tests — same scenarios as test/core/layout.test.ts but
 * using the Yoga-backed layout pipeline instead of the old custom engine.
 *
 * wrapText tests are NOT duplicated here — they live in layout.test.ts and
 * test the wrapping functions directly (unchanged by Yoga migration).
 */
import { describe, it, expect } from 'bun:test';
import { createNode, appendChild, type TNode } from '../../src/core/nodes.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';
import type { FlexNodeFactory } from '../../src/layout/flex-node.js';

const factory = createFlexNodeFactory();

/** Recursively attach FlexNodes to an existing TNode tree. */
function attachFlexNodes(node: TNode): void {
  const fn = factory();
  node.flexNode = fn;

  if (node.type === 'text') {
    // Only set measure func on text elements (not text-instance children with node.text)
    if (node.text === null) {
      fn.setMeasureFunc((width, widthMode) => computeTextLayout(node, width, widthMode));
    }
  } else if (node.type === 'divider') {
    applyBoxProps(fn, node.props);
    fn.setHeight(1);
  } else {
    applyBoxProps(fn, node.props, node.type === 'root');
  }

  for (const child of node.children) {
    // Skip text-instance children (raw string nodes) — they don't get FlexNodes
    if (child.text !== null) continue;
    attachFlexNodes(child);
    fn.insertChild(child.flexNode!, fn.getChildCount());
  }
}

/** Run the full Yoga layout pipeline on a TNode tree. */
function runLayout(root: TNode, width: number): void {
  // Re-attach FlexNodes each time (simulates fresh layout like the old engine)
  attachFlexNodes(root);
  root.flexNode!.setWidth(width);
  root.flexNode!.calculateLayout(width);
  populateLayoutResults(root);
}

/** Helper: create a box node with props */
function box(props: Record<string, any> = {}): TNode {
  return createNode('box', props);
}

/** Helper: create a text node with string content */
function text(content: string, props: Record<string, any> = {}): TNode {
  const el = createNode('text', props);
  const inst = createNode('text', {});
  inst.text = content;
  appendChild(el, inst);
  return el;
}

/** Convert plain strings to the WrappedLine format for assertions */
function wl(...lines: string[]) {
  return lines.map(line => [{ text: line }]);
}

describe('layout (Yoga-backed)', () => {
  it('single text node', () => {
    const root = createNode('root', {});
    appendChild(root, text('hello'));

    runLayout(root, 40);

    expect(root.layout).toMatchObject({ x: 0, y: 0, width: 40 });
    const t = root.children[0]!;
    expect(t.layout!.x).toBe(0);
    expect(t.layout!.y).toBe(0);
    expect(t.layout!.width).toBe(40);
    expect(t.layout!.height).toBe(1);
    expect(t.layout!.wrappedLines).toEqual(wl('hello'));
  });

  it('text wrapping', () => {
    const root = createNode('root', {});
    appendChild(root, text('hello world'));

    runLayout(root, 5);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('hello', 'world'));
    expect(t.layout!.height).toBe(2);
  });

  it('hard break', () => {
    const root = createNode('root', {});
    appendChild(root, text('abcdefghij'));

    runLayout(root, 5);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('abcde', 'fghij'));
    expect(t.layout!.height).toBe(2);
  });

  it('vertical stack', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    appendChild(root, text('second'));

    runLayout(root, 40);

    expect(root.children[0]!.layout!.y).toBe(0);
    expect(root.children[1]!.layout!.y).toBe(1);
  });

  it('marginTop on first child', () => {
    const root = createNode('root', {});
    const b = box({ marginTop: 1 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.layout!.y).toBe(1);
  });

  it('marginTop on non-first child', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    const b = box({ marginTop: 1 });
    appendChild(b, text('second'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(root.children[0]!.layout!.y).toBe(0);
    // first text height=1, then marginTop=1, so y=2
    expect(b.layout!.y).toBe(2);
  });

  it('paddingLeft', () => {
    const root = createNode('root', {});
    const b = box({ paddingLeft: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    expect(t.layout!.x).toBe(2);
    expect(t.layout!.width).toBe(38);
  });

  it('nested paddingLeft accumulation', () => {
    const root = createNode('root', {});
    const outer = box({ paddingLeft: 1 });
    const inner = box({ paddingLeft: 2 });
    appendChild(inner, text('hello'));
    appendChild(outer, inner);
    appendChild(root, outer);

    runLayout(root, 40);

    const t = inner.children[0]!;
    expect(t.layout!.x).toBe(3);
    expect(t.layout!.width).toBe(37);
  });

  it('gap between children', () => {
    const root = createNode('root', {});
    const b = box({ gap: 1 });
    appendChild(b, text('first'));
    appendChild(b, text('second'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.children[0]!.layout!.y).toBe(0);
    // first height=1, gap=1, so second at y=2
    expect(b.children[1]!.layout!.y).toBe(2);
  });

  it('horizontal split — fixed + fill', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 2 });
    const b = box({ flexGrow: 1 });
    appendChild(b, text('hello'));
    appendChild(row, a);
    appendChild(row, b);
    appendChild(root, row);

    runLayout(root, 40);

    expect(a.layout!.x).toBe(0);
    expect(a.layout!.width).toBe(2);
    expect(b.layout!.x).toBe(2);
    expect(b.layout!.width).toBe(38);
  });

  it('horizontal split — fixed + fill + fixed', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 2 });
    const b = box({ flexGrow: 1 });
    appendChild(b, text('hello'));
    const c = box({ width: 1 });
    appendChild(row, a);
    appendChild(row, b);
    appendChild(row, c);
    appendChild(root, row);

    runLayout(root, 40);

    expect(a.layout!.x).toBe(0);
    expect(a.layout!.width).toBe(2);
    expect(b.layout!.x).toBe(2);
    expect(b.layout!.width).toBe(37);
    expect(c.layout!.x).toBe(39);
    expect(c.layout!.width).toBe(1);
  });

  it('hanging indent on text node', () => {
    const root = createNode('root', {});
    appendChild(root, text('aaaa bbbb cccc dddd', { hangingIndent: 2 }));

    runLayout(root, 10);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('aaaa bbbb', 'cccc', 'dddd'));
    expect(t.layout!.height).toBe(3);
    expect(t.layout!.hangingIndent).toBe(2);
  });

  it('nested boxes: column > row > texts', () => {
    const root = createNode('root', {});
    const col = box({});
    const row = box({ flexDirection: 'row' });
    const left = box({ width: 2 });
    appendChild(left, text('>>'));
    const right = box({ flexGrow: 1 });
    appendChild(right, text('content'));
    appendChild(row, left);
    appendChild(row, right);
    appendChild(col, row);
    appendChild(root, col);

    runLayout(root, 40);

    expect(left.layout!.x).toBe(0);
    expect(left.layout!.width).toBe(2);
    expect(right.layout!.x).toBe(2);
    expect(right.layout!.width).toBe(38);
    expect(right.children[0]!.layout!.x).toBe(2);
  });

  it('fill width — no explicit width', () => {
    const root = createNode('root', {});
    const b = box({});
    appendChild(root, b);

    runLayout(root, 80);

    expect(b.layout!.width).toBe(80);
  });

  it('fixed width box', () => {
    const root = createNode('root', {});
    const b = box({ width: 43 });
    appendChild(root, b);

    runLayout(root, 80);

    expect(b.layout!.width).toBe(43);
  });

  it('empty text', () => {
    const root = createNode('root', {});
    appendChild(root, text(''));

    runLayout(root, 40);

    const t = root.children[0]!;
    expect(t.layout!.height).toBe(0);
    expect(t.layout!.wrappedLines).toEqual([]);
  });

  it('resize simulation — relayout at different width', () => {
    const root = createNode('root', {});
    appendChild(root, text('hello world foo bar'));

    runLayout(root, 80);
    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('hello world foo bar'));
    expect(t.layout!.height).toBe(1);

    // Relayout at smaller width
    runLayout(root, 10);
    expect(t.layout!.wrappedLines).toEqual(wl('hello', 'world foo', 'bar'));
    expect(t.layout!.height).toBe(3);
    expect(t.layout!.width).toBe(10);
  });

  it('zero-width edge case — fill child gets 0 width when fixed child fills row', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 50 });
    const b = box({ flexGrow: 1 });
    appendChild(b, text('overflow'));
    appendChild(row, a);
    appendChild(row, b);
    appendChild(root, row);

    runLayout(root, 40);

    // Yoga: a gets its requested 50 (no clamping). b with flexGrow=1
    // still gets its intrinsic text width since there's negative free space.
    // Yoga gives b the intrinsic width of "overflow" (8 chars).
    // This differs from the old engine which clamped a to 40 and gave b 0.
    expect(a.layout!.width).toBe(50);
    expect(b.layout!.width).toBe(8);
    expect(b.children[0]!.layout!.height).toBe(1);
    expect(b.children[0]!.layout!.wrappedLines).toEqual(wl('overflow'));
  });
});

describe('contentHeight (Yoga-backed)', () => {
  it('simple: root with two text lines', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    appendChild(root, text('second'));

    runLayout(root, 40);

    expect(root.layout!.height).toBe(2);
  });

  it('with marginTop', () => {
    const root = createNode('root', {});
    const b = box({ marginTop: 1 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    // marginTop=1 + 1 line of text = 2
    expect(root.layout!.height).toBe(2);
  });

  it('nested: multiple children with varying heights, margins, gaps', () => {
    const root = createNode('root', {});
    appendChild(root, text('line1'));
    const b = box({ marginTop: 2, gap: 1 });
    appendChild(b, text('line2'));
    appendChild(b, text('line3'));
    appendChild(root, b);
    appendChild(root, text('line4'));

    runLayout(root, 40);

    // line1: height=1 (y=0)
    // box: marginTop=2, so y=3. Children: line2 at y=3 height=1, gap=1, line3 at y=5 height=1. Box height=3.
    // line4: y=6, height=1
    // Total: 7
    expect(root.layout!.height).toBe(7);
  });

  it('gap included in contentHeight', () => {
    const root = createNode('root', {});
    const b = box({ gap: 1 });
    // 3 text nodes, each wrapping to 2 lines at width 5
    appendChild(b, text('aaaa bbbb', {}));
    appendChild(b, text('cccc dddd', {}));
    appendChild(b, text('eeee ffff', {}));
    appendChild(root, b);

    runLayout(root, 5);

    // Each text wraps to 2 lines. gap=1 between children.
    // 2 + 1 + 2 + 1 + 2 = 8
    expect(root.layout!.height).toBe(8);
    // Verify child positions
    expect(b.children[0]!.layout!.y).toBe(0);
    expect(b.children[0]!.layout!.height).toBe(2);
    expect(b.children[1]!.layout!.y).toBe(3);
    expect(b.children[1]!.layout!.height).toBe(2);
    expect(b.children[2]!.layout!.y).toBe(6);
    expect(b.children[2]!.layout!.height).toBe(2);
  });

  it('contentHeight matches root.layout.height', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    appendChild(root, text('second'));
    appendChild(root, text('third'));

    runLayout(root, 40);

    expect(root.layout!.height).toBe(3);
  });
});

// ─── Padding tests ──────────────────────────────────────────────────────

describe('padding variants (Yoga-backed)', () => {
  it('paddingTop offsets children downward within the box', () => {
    const root = createNode('root', {});
    const b = box({ paddingTop: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    expect(t.layout!.y).toBe(2);
    expect(b.layout!.y).toBe(0);
    expect(b.layout!.height).toBe(3); // paddingTop(2) + text(1) + paddingBottom(0)
  });

  it('paddingBottom increases box height beyond content', () => {
    const root = createNode('root', {});
    const b = box({ paddingBottom: 3 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.layout!.height).toBe(4); // text(1) + paddingBottom(3)
  });

  it('paddingRight reduces available width for children', () => {
    const root = createNode('root', {});
    const b = box({ paddingRight: 10 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    expect(t.layout!.width).toBe(30); // 40 - paddingRight(10)
  });

  it('padding shorthand applies to all four sides', () => {
    const root = createNode('root', {});
    const b = box({ padding: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    // paddingLeft=2, paddingRight=2 → content width = 40 - 4 = 36
    expect(t.layout!.x).toBe(2);
    expect(t.layout!.width).toBe(36);
    // paddingTop=2, so child at y=2
    expect(t.layout!.y).toBe(2);
    // height = paddingTop(2) + text(1) + paddingBottom(2) = 5
    expect(b.layout!.height).toBe(5);
  });

  it('individual side overrides shorthand', () => {
    const root = createNode('root', {});
    const b = box({ padding: 2, paddingLeft: 4, paddingTop: 0 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    // paddingLeft=4 (override), paddingRight=2 (shorthand) → width = 40 - 6 = 34
    expect(t.layout!.x).toBe(4);
    expect(t.layout!.width).toBe(34);
    // paddingTop=0 (override), so child at y=0
    expect(t.layout!.y).toBe(0);
    // height = paddingTop(0) + text(1) + paddingBottom(2) = 3
    expect(b.layout!.height).toBe(3);
  });

  it('padding combines with marginTop and gap correctly', () => {
    const root = createNode('root', {});
    const b = box({ paddingTop: 1, paddingBottom: 1, gap: 1 });
    const child1 = box({ marginTop: 2 });
    appendChild(child1, text('first'));
    appendChild(b, child1);
    appendChild(b, text('second'));
    appendChild(root, b);

    runLayout(root, 40);

    // paddingTop=1, then child1 has marginTop=2 → child1 at y=3
    expect(child1.layout!.y).toBe(3);
    expect(child1.layout!.height).toBe(1);
    // gap=1 between children, so second text at y=5
    expect(b.children[1]!.layout!.y).toBe(5);
    // box height = paddingTop(1) + marginTop(2) + child1(1) + gap(1) + child2(1) + paddingBottom(1) = 7
    expect(b.layout!.height).toBe(7);
  });
});

// ─── Margin variant tests ───────────────────────────────────────────────

describe('margin variants (Yoga-backed)', () => {
  it('marginBottom adds space after the node before the next sibling', () => {
    const root = createNode('root', {});
    const b1 = box({ marginBottom: 2 });
    appendChild(b1, text('first'));
    appendChild(root, b1);
    appendChild(root, text('second'));

    runLayout(root, 40);

    expect(b1.layout!.y).toBe(0);
    expect(b1.layout!.height).toBe(1);
    // second at y = 0 + 1 (height) + 2 (marginBottom) = 3
    expect(root.children[1]!.layout!.y).toBe(3);
    expect(root.layout!.height).toBe(4);
  });

  it('marginLeft offsets the node x position', () => {
    const root = createNode('root', {});
    const b = box({ marginLeft: 5 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.layout!.x).toBe(5);
    expect(b.layout!.width).toBe(35); // 40 - 5 (marginLeft) - 0 (marginRight)
    expect(b.children[0]!.layout!.x).toBe(5);
  });

  it('marginRight reduces the node width', () => {
    const root = createNode('root', {});
    const b = box({ marginRight: 10 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.layout!.x).toBe(0);
    expect(b.layout!.width).toBe(30); // 40 - 10
    expect(b.children[0]!.layout!.width).toBe(30);
  });

  it('margin shorthand applies to all four sides', () => {
    const root = createNode('root', {});
    const b = box({ margin: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);
    appendChild(root, text('after'));

    runLayout(root, 40);

    // marginLeft=2, marginRight=2 → width = 40 - 4 = 36
    expect(b.layout!.x).toBe(2);
    expect(b.layout!.width).toBe(36);
    // marginTop=2 → y=2
    expect(b.layout!.y).toBe(2);
    // next sibling at y = 2 (marginTop) + 1 (height) + 2 (marginBottom) = 5
    expect(root.children[1]!.layout!.y).toBe(5);
  });

  it('individual side overrides shorthand', () => {
    const root = createNode('root', {});
    const b = box({ margin: 2, marginTop: 0, marginLeft: 5 });
    appendChild(b, text('hello'));
    appendChild(root, b);
    appendChild(root, text('after'));

    runLayout(root, 40);

    // marginTop=0 (override)
    expect(b.layout!.y).toBe(0);
    // marginLeft=5 (override), marginRight=2 (shorthand) → width = 40 - 7 = 33
    expect(b.layout!.x).toBe(5);
    expect(b.layout!.width).toBe(33);
    // next sibling at y = 0 + 1 (height) + 2 (marginBottom from shorthand) = 3
    expect(root.children[1]!.layout!.y).toBe(3);
  });

  it('margin combines with padding and gap correctly', () => {
    const root = createNode('root', {});
    const outer = box({ gap: 1 });
    const child1 = box({ marginBottom: 2, paddingTop: 1 });
    appendChild(child1, text('first'));
    const child2 = box({ marginTop: 3 });
    appendChild(child2, text('second'));
    appendChild(outer, child1);
    appendChild(outer, child2);
    appendChild(root, outer);

    runLayout(root, 40);

    // child1: y=0, paddingTop=1 → text at y=1, height = paddingTop(1) + text(1) = 2
    expect(child1.layout!.y).toBe(0);
    expect(child1.layout!.height).toBe(2);
    expect(child1.children[0]!.layout!.y).toBe(1);
    // child2: y = 0 + 2 (child1 height) + 2 (child1 marginBottom) + 1 (gap) + 3 (child2 marginTop) = 8
    expect(child2.layout!.y).toBe(8);
  });
});

// ─── Border tests ───────────────────────────────────────────────────────

describe('borderStyle (Yoga-backed)', () => {
  it('border adds 2 to height and reserves 2 columns for width', () => {
    const root = createNode('root', {});
    const b = box({ borderStyle: 'single' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    // text width = 40 - 2 (border left+right) = 38
    const t = b.children[0]!;
    expect(t.layout!.x).toBe(1);
    expect(t.layout!.width).toBe(38);
    // text at y=1 (border top row at y=0)
    expect(t.layout!.y).toBe(1);
    // box height = border(1) + text(1) + border(1) = 3
    expect(b.layout!.height).toBe(3);
    expect(b.layout!.width).toBe(40);
  });

  it('border with padding — padding is inside the border', () => {
    const root = createNode('root', {});
    const b = box({ borderStyle: 'round', paddingLeft: 2, paddingTop: 1 });
    appendChild(b, text('content'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    // x = border(1) + paddingLeft(2) = 3
    expect(t.layout!.x).toBe(3);
    // width = 40 - border(1) - paddingLeft(2) - paddingRight(0) - border(1) = 36
    expect(t.layout!.width).toBe(36);
    // y = border(1) + paddingTop(1) = 2
    expect(t.layout!.y).toBe(2);
    // height = border(1) + paddingTop(1) + text(1) + paddingBottom(0) + border(1) = 4
    expect(b.layout!.height).toBe(4);
  });

  it('border reduces width for wrapping calculation', () => {
    const root = createNode('root', {});
    const b = box({ borderStyle: 'single' });
    // "hello world" at width 38 (40-2) fits on one line
    appendChild(b, text('hello world'));
    appendChild(root, b);

    runLayout(root, 40);
    expect(b.children[0]!.layout!.height).toBe(1);

    // Now at width 8: content width = 6, "hello world" wraps
    runLayout(root, 8);
    expect(b.children[0]!.layout!.width).toBe(6);
    expect(b.children[0]!.layout!.height).toBe(2);
    // box height = border(1) + 2 lines + border(1) = 4
    expect(b.layout!.height).toBe(4);
  });

  it('no border — no extra space', () => {
    const root = createNode('root', {});
    const b = box({});
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.children[0]!.layout!.x).toBe(0);
    expect(b.children[0]!.layout!.width).toBe(40);
    expect(b.layout!.height).toBe(1);
  });
});

// ─── Segment tests ─────────────────────────────────────────────────────

describe('segments (Yoga-backed)', () => {
  it('plain text backward compat — no segments', () => {
    const root = createNode('root', {});
    appendChild(root, text('content'));

    runLayout(root, 40);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual([[{ text: 'content' }]]);
  });

  it('segments basic — two unstyled segments', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [{ text: 'hello ' }, { text: 'world' }],
    });
    appendChild(root, t);

    runLayout(root, 40);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'hello ' }, { text: 'world' }],
    ]);
    expect(t.layout!.height).toBe(1);
  });

  it('segments with styles', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [
        { text: 'bold ', style: { bold: true } },
        { text: 'normal' },
      ],
    });
    appendChild(root, t);

    runLayout(root, 40);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'bold ', style: { bold: true } }, { text: 'normal' }],
    ]);
  });

  it('segment splitting at wrap', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [
        { text: 'Hello ', style: { bold: true } },
        { text: 'world and more' },
      ],
    });
    appendChild(root, t);

    runLayout(root, 10);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'Hello', style: { bold: true } }],
      [{ text: 'world and' }],
      [{ text: 'more' }],
    ]);
    expect(t.layout!.height).toBe(3);
  });

  it('segment splitting at boundary', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [
        { text: 'aaaa ', style: { bold: true } },
        { text: 'bbbbb', style: { italic: true } },
      ],
    });
    appendChild(root, t);

    runLayout(root, 5);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'aaaa', style: { bold: true } }],
      [{ text: 'bbbbb', style: { italic: true } }],
    ]);
  });

  it('segments with hanging indent', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [
        { text: 'aaaa ', style: { bold: true } },
        { text: 'bbbb cccc dddd' },
      ],
      hangingIndent: 2,
    });
    appendChild(root, t);

    runLayout(root, 10);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'aaaa ', style: { bold: true } }, { text: 'bbbb' }],
      [{ text: 'cccc' }],
      [{ text: 'dddd' }],
    ]);
    expect(t.layout!.hangingIndent).toBe(2);
  });

  it('empty segment filtered', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [{ text: '' }, { text: 'actual' }],
    });
    appendChild(root, t);

    runLayout(root, 40);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'actual' }],
    ]);
  });
});

// ─── Width clamping tests ──────────────────────────────────────────────
// Note: Yoga handles overflow differently than the old engine.
// By default, Yoga allows children to overflow their parent.
// The old engine clamped fixed-width children to available width.

describe('width clamping (Yoga-backed)', () => {
  it('fixed-width box is NOT clamped by Yoga when terminal is narrower', () => {
    const root = createNode('root', {});
    const b = box({ width: 62 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);

    // Yoga: width stays at 62 (overflow allowed by default)
    // This differs from the old engine which clamped to 40.
    expect(b.layout!.width).toBe(62);
  });

  it('fixed-width box is NOT clamped when terminal is wider', () => {
    const root = createNode('root', {});
    const b = box({ width: 62 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 80);

    // Plenty of room — width stays at 62
    expect(b.layout!.width).toBe(62);
  });

  it('content reflows when using maxWidth for clamping', () => {
    const root = createNode('root', {});
    // Use maxWidth to get the clamping behavior
    const b = box({ width: 60, maxWidth: 10 });
    appendChild(b, text('hello world'));
    appendChild(root, b);

    runLayout(root, 60);

    // maxWidth=10 clamps box width
    expect(b.layout!.width).toBe(10);
    expect(b.children[0]!.layout!.wrappedLines).toEqual(wl('hello', 'world'));
    expect(b.children[0]!.layout!.height).toBe(2);
  });

  it('clamped box with border and padding — content width accounts for both', () => {
    const root = createNode('root', {});
    // border(1+1) + padding(2+2) = 6 columns of chrome
    const b = box({ width: 20, borderStyle: 'single', padding: 2 });
    appendChild(b, text('hello world'));
    appendChild(root, b);

    runLayout(root, 20);
    expect(b.layout!.width).toBe(20);
    expect(b.children[0]!.layout!.width).toBe(14);
    expect(b.children[0]!.layout!.x).toBe(3); // border(1) + padding(2)
  });

  it('clamped box with margins — margins reduce available width', () => {
    const root = createNode('root', {});
    const b = box({ marginLeft: 5, marginRight: 5 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);
    expect(b.layout!.x).toBe(5);
    // Yoga: auto-width box gets 40 - 5 - 5 = 30
    expect(b.layout!.width).toBe(30);
  });

  it('row: fixed-width child in row', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 10 });
    appendChild(a, text('fixed'));
    const b = box({ flexGrow: 1 });
    appendChild(b, text('fill'));
    appendChild(row, a);
    appendChild(row, b);
    appendChild(root, row);

    runLayout(root, 40);
    expect(a.layout!.width).toBe(10);
    expect(b.layout!.width).toBe(30);
  });

  it('nested: inner box respects outer box width', () => {
    const root = createNode('root', {});
    const outer = box({ width: 40 });
    const inner = box({});
    appendChild(inner, text('content'));
    appendChild(outer, inner);
    appendChild(root, outer);

    runLayout(root, 80);
    expect(outer.layout!.width).toBe(40);
    // Inner auto-width fills parent
    expect(inner.layout!.width).toBe(40);
    expect(inner.children[0]!.layout!.width).toBe(40);
  });

  it('width exactly equals available — no clamping', () => {
    const root = createNode('root', {});
    const b = box({ width: 40 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    runLayout(root, 40);
    expect(b.layout!.width).toBe(40);
  });

  it('header-like box: fixed width, then narrower root', () => {
    const root = createNode('root', {});
    const header = box({ width: 62, borderStyle: 'double', paddingTop: 1, paddingBottom: 1 });
    appendChild(header, text('Welcome back!'));
    appendChild(header, text('Model info'));
    appendChild(root, header);

    // Full size
    runLayout(root, 80);
    expect(header.layout!.width).toBe(62);
    // content width = 62 - 2 (border) = 60
    expect(header.children[0]!.layout!.width).toBe(60);
  });
});

// ─── alignItems tests ──────────────────────────────────────────────────

describe('alignItems (Yoga-backed)', () => {
  it('center — text node gets textAlign=center', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'center' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    expect(t.layout!.textAlign).toBe('center');
  });

  it('flex-end — text node gets textAlign=right', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'flex-end' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    const t = b.children[0]!;
    expect(t.layout!.textAlign).toBe('right');
  });

  it('flex-start — no textAlign', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'flex-start' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.children[0]!.layout!.textAlign).toBeUndefined();
  });

  it('stretch (default) — no textAlign', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'stretch' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.children[0]!.layout!.textAlign).toBeUndefined();
  });

  it('no alignItems — no textAlign', () => {
    const root = createNode('root', {});
    const b = box({});
    appendChild(b, text('hi'));
    appendChild(root, b);

    runLayout(root, 40);

    expect(b.children[0]!.layout!.textAlign).toBeUndefined();
  });

  it('center — box with explicit width centered', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const child = box({ width: 20 });
    appendChild(child, text('content'));
    appendChild(parent, child);
    appendChild(root, parent);

    runLayout(root, 40);

    // child width = 20, parent width = 40, centered: offset = 10
    expect(child.layout!.x).toBe(10);
  });

  it('center — box without explicit width shrinks to content and centers', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const child = box({});
    appendChild(child, text('content'));
    appendChild(parent, child);
    appendChild(root, parent);

    runLayout(root, 40);

    // Yoga with alignItems=center + auto width: child shrinks to content width.
    // "content" is 7 chars → child width=7, centered in 40: x = floor((40-7)/2) = 16
    // This differs from the old engine where auto-width children always stretched.
    expect(child.layout!.width).toBe(7);
    // (40 - 7) / 2 = 16.5 — Yoga rounds to 17
    expect(child.layout!.x).toBeGreaterThanOrEqual(16);
    expect(child.layout!.x).toBeLessThanOrEqual(17);
  });

  it('center — multiple text children each get textAlign=center', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    appendChild(parent, text('hi'));
    appendChild(parent, text('hello'));
    appendChild(root, parent);

    runLayout(root, 40);

    expect(parent.children[0]!.layout!.textAlign).toBe('center');
    expect(parent.children[1]!.layout!.textAlign).toBe('center');
  });

  it('center with padding — text gets textAlign=center, centered within content area', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center', paddingLeft: 4, paddingRight: 4 });
    appendChild(parent, text('hi'));
    appendChild(root, parent);

    runLayout(root, 40);

    // Content area = 40 - 4 - 4 = 32. "hi" = 2 chars, centered: offset = 4 + floor((32-2)/2) = 19
    const contentWidth = 32;
    const textWidth = 2;
    const expectedX = 4 + Math.floor((contentWidth - textWidth) / 2);
    expect(parent.children[0]!.layout!.x).toBe(expectedX);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center with border — text gets textAlign=center, centered within content area', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center', borderStyle: 'single' });
    appendChild(parent, text('hi'));
    appendChild(root, parent);

    runLayout(root, 40);

    // Content area = 40 - 1 - 1 = 38. "hi" = 2 chars, centered: offset = 1 + floor((38-2)/2) = 19
    const contentWidth = 38;
    const textWidth = 2;
    const expectedX = 1 + Math.floor((contentWidth - textWidth) / 2);
    expect(parent.children[0]!.layout!.x).toBe(expectedX);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center — wrapped text gets textAlign=center', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    appendChild(parent, text('hello world'));
    appendChild(root, parent);

    runLayout(root, 10);

    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center — segments get textAlign=center', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const t = createNode('text', {
      segments: [{ text: 'hi', style: { bold: true } }],
    });
    appendChild(parent, t);
    appendChild(root, parent);

    runLayout(root, 40);

    expect(t.layout!.textAlign).toBe('center');
  });
});

describe('wide character layout (Yoga-backed)', () => {
  it('CJK characters count as 2 columns in layout height', () => {
    const root = createNode('root', {});
    appendChild(root, text('你好世界'));
    runLayout(root, 5);
    const t = root.children[0]!;
    expect(t.layout!.height).toBe(2);
  });

  it('truncate-end with CJK', () => {
    const root = createNode('root', {});
    appendChild(root, text('你好世界abc', { wrap: 'truncate-end' }));
    runLayout(root, 7);
    const t = root.children[0]!;
    expect(t.layout!.wrappedLines!.length).toBe(1);
    const line = t.layout!.wrappedLines![0]!.map(r => r.text).join('');
    expect(line).toBe('你好世\u2026');
  });
});
