import { describe, it, expect } from 'bun:test';
import { layout, wrapText, contentHeight } from '../layout.js';
import { createNode, appendChild, type TNode } from '../nodes.js';

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

describe('wrapText', () => {
  it('no wrapping needed', () => {
    expect(wrapText('hello', 40)).toEqual(['hello']);
  });

  it('wraps on space', () => {
    expect(wrapText('hello world', 5)).toEqual(['hello', 'world']);
  });

  it('hard breaks mid-word', () => {
    expect(wrapText('abcdefghij', 5)).toEqual(['abcde', 'fghij']);
  });

  it('returns [] for empty text', () => {
    expect(wrapText('', 40)).toEqual([]);
  });

  it('returns [] for zero width', () => {
    expect(wrapText('hello', 0)).toEqual([]);
  });

  it('returns [] for negative width', () => {
    expect(wrapText('hello', -5)).toEqual([]);
  });

  it('hanging indent narrows continuation lines', () => {
    const lines = wrapText('aaaa bbbb cccc dddd', 10, 2);
    expect(lines).toEqual(['aaaa bbbb', 'cccc', 'dddd']);
  });

  it('hanging indent with hard break', () => {
    // Width 5, hangingIndent 2 → continuation width 3
    const lines = wrapText('hello abcdef', 5, 2);
    expect(lines).toEqual(['hello', 'abc', 'def']);
  });
});

describe('layout', () => {
  it('single text node', () => {
    const root = createNode('root', {});
    appendChild(root, text('hello'));

    layout(root, 40, 24);

    expect(root.layout).toEqual({ x: 0, y: 0, width: 40, height: 1 });
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

    layout(root, 5, 24);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('hello', 'world'));
    expect(t.layout!.height).toBe(2);
  });

  it('hard break', () => {
    const root = createNode('root', {});
    appendChild(root, text('abcdefghij'));

    layout(root, 5, 24);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('abcde', 'fghij'));
    expect(t.layout!.height).toBe(2);
  });

  it('vertical stack', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    appendChild(root, text('second'));

    layout(root, 40, 24);

    expect(root.children[0]!.layout!.y).toBe(0);
    expect(root.children[1]!.layout!.y).toBe(1);
  });

  it('marginTop on first child', () => {
    const root = createNode('root', {});
    const b = box({ marginTop: 1 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(b.layout!.y).toBe(1);
  });

  it('marginTop on non-first child', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    const b = box({ marginTop: 1 });
    appendChild(b, text('second'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(root.children[0]!.layout!.y).toBe(0);
    // first text height=1, then marginTop=1, so y=2
    expect(b.layout!.y).toBe(2);
  });

  it('paddingLeft', () => {
    const root = createNode('root', {});
    const b = box({ paddingLeft: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 10, 24);

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

    layout(root, 40, 24);

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

    layout(root, 80, 24);

    expect(b.layout!.width).toBe(80);
  });

  it('fixed width box', () => {
    const root = createNode('root', {});
    const b = box({ width: 43 });
    appendChild(root, b);

    layout(root, 80, 24);

    expect(b.layout!.width).toBe(43);
  });

  it('empty text', () => {
    const root = createNode('root', {});
    appendChild(root, text(''));

    layout(root, 40, 24);

    const t = root.children[0]!;
    expect(t.layout!.height).toBe(0);
    expect(t.layout!.wrappedLines).toEqual([]);
  });

  it('resize simulation — relayout at different width', () => {
    const root = createNode('root', {});
    appendChild(root, text('hello world foo bar'));

    layout(root, 80, 24);
    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual(wl('hello world foo bar'));
    expect(t.layout!.height).toBe(1);

    // Relayout at smaller width
    layout(root, 10, 24);
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

    layout(root, 40, 24);

    // width: 50 is clamped to row width 40
    expect(a.layout!.width).toBe(40);
    expect(b.layout!.width).toBe(0);
    expect(b.children[0]!.layout!.height).toBe(0);
    expect(b.children[0]!.layout!.wrappedLines).toEqual([]);
  });
});

describe('contentHeight', () => {
  it('simple: root with two text lines', () => {
    const root = createNode('root', {});
    appendChild(root, text('first'));
    appendChild(root, text('second'));

    layout(root, 40, 24);

    expect(contentHeight(root)).toBe(2);
  });

  it('with marginTop', () => {
    const root = createNode('root', {});
    const b = box({ marginTop: 1 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

    // marginTop=1 + 1 line of text = 2
    expect(contentHeight(root)).toBe(2);
  });

  it('nested: multiple children with varying heights, margins, gaps', () => {
    const root = createNode('root', {});
    appendChild(root, text('line1'));
    const b = box({ marginTop: 2, gap: 1 });
    appendChild(b, text('line2'));
    appendChild(b, text('line3'));
    appendChild(root, b);
    appendChild(root, text('line4'));

    layout(root, 40, 24);

    // line1: height=1 (y=0)
    // box: marginTop=2, so y=3. Children: line2 at y=3 height=1, gap=1, line3 at y=5 height=1. Box height=3.
    // line4: y=6, height=1
    // Total: 7
    expect(contentHeight(root)).toBe(7);
  });

  it('gap included in contentHeight', () => {
    const root = createNode('root', {});
    const b = box({ gap: 1 });
    // 3 text nodes, each wrapping to 2 lines at width 5
    appendChild(b, text('aaaa bbbb', {}));
    appendChild(b, text('cccc dddd', {}));
    appendChild(b, text('eeee ffff', {}));
    appendChild(root, b);

    layout(root, 5, 24);

    // Each text wraps to 2 lines. gap=1 between children.
    // 2 + 1 + 2 + 1 + 2 = 8
    expect(contentHeight(root)).toBe(8);
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

    layout(root, 40, 24);

    // root.layout.height is now computed from children, should match contentHeight
    expect(root.layout!.height).toBe(contentHeight(root));
    expect(root.layout!.height).toBe(3);
  });
});

// ─── Padding tests ──────────────────────────────────────────────────────

describe('padding variants', () => {
  it('paddingTop offsets children downward within the box', () => {
    const root = createNode('root', {});
    const b = box({ paddingTop: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

    expect(b.layout!.height).toBe(4); // text(1) + paddingBottom(3)
  });

  it('paddingRight reduces available width for children', () => {
    const root = createNode('root', {});
    const b = box({ paddingRight: 10 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

    const t = b.children[0]!;
    expect(t.layout!.width).toBe(30); // 40 - paddingRight(10)
  });

  it('padding shorthand applies to all four sides', () => {
    const root = createNode('root', {});
    const b = box({ padding: 2 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

describe('margin variants', () => {
  it('marginBottom adds space after the node before the next sibling', () => {
    const root = createNode('root', {});
    const b1 = box({ marginBottom: 2 });
    appendChild(b1, text('first'));
    appendChild(root, b1);
    appendChild(root, text('second'));

    layout(root, 40, 24);

    expect(b1.layout!.y).toBe(0);
    expect(b1.layout!.height).toBe(1);
    // second at y = 0 + 1 (height) + 2 (marginBottom) = 3
    expect(root.children[1]!.layout!.y).toBe(3);
    expect(contentHeight(root)).toBe(4);
  });

  it('marginLeft offsets the node x position', () => {
    const root = createNode('root', {});
    const b = box({ marginLeft: 5 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(b.layout!.x).toBe(5);
    expect(b.layout!.width).toBe(35); // 40 - 5 (marginLeft) - 0 (marginRight)
    expect(b.children[0]!.layout!.x).toBe(5);
  });

  it('marginRight reduces the node width', () => {
    const root = createNode('root', {});
    const b = box({ marginRight: 10 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);

    // child1: y=0, paddingTop=1 → text at y=1, height = paddingTop(1) + text(1) = 2
    expect(child1.layout!.y).toBe(0);
    expect(child1.layout!.height).toBe(2);
    expect(child1.children[0]!.layout!.y).toBe(1);
    // child2: y = 0 + 2 (child1 height) + 2 (child1 marginBottom) + 1 (gap) + 3 (child2 marginTop) = 8
    expect(child2.layout!.y).toBe(8);
  });
});

// ─── Border tests ───────────────────────────────────────────────────────

describe('borderStyle', () => {
  it('border adds 2 to height and reserves 2 columns for width', () => {
    const root = createNode('root', {});
    const b = box({ borderStyle: 'single' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

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

    layout(root, 40, 24);
    expect(b.children[0]!.layout!.height).toBe(1);

    // Now at width 8: content width = 6, "hello world" wraps
    layout(root, 8, 24);
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

    layout(root, 40, 24);

    expect(b.children[0]!.layout!.x).toBe(0);
    expect(b.children[0]!.layout!.width).toBe(40);
    expect(b.layout!.height).toBe(1);
  });
});

// ─── Segment tests ─────────────────────────────────────────────────────

describe('segments', () => {
  it('plain text backward compat — no segments', () => {
    const root = createNode('root', {});
    appendChild(root, text('content'));

    layout(root, 40, 24);

    const t = root.children[0]!;
    expect(t.layout!.wrappedLines).toEqual([[{ text: 'content' }]]);
  });

  it('segments basic — two unstyled segments', () => {
    const root = createNode('root', {});
    const t = createNode('text', {
      segments: [{ text: 'hello ' }, { text: 'world' }],
    });
    appendChild(root, t);

    layout(root, 40, 24);

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

    layout(root, 40, 24);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'bold ', style: { bold: true } }, { text: 'normal' }],
    ]);
  });

  it('segment splitting at wrap', () => {
    const root = createNode('root', {});
    // "Hello world and more" at width 10
    // wrapText gives: ["Hello", "world and", "more"]
    const t = createNode('text', {
      segments: [
        { text: 'Hello ', style: { bold: true } },
        { text: 'world and more' },
      ],
    });
    appendChild(root, t);

    layout(root, 10, 24);

    // "Hello world and more" breaks at space after "Hello" (pos 5) → consumed space at pos 5
    // Line 0: "Hello" → [{text: "Hello", style: {bold: true}}]  (the trailing space before "world" was the break)
    // Wait — wrapText("Hello world and more", 10) → let me trace:
    //   remaining = "Hello world and more", lineWidth = 10
    //   searchEnd = min(10, 19) = 10. remaining[10] = 'a'. Search backwards...
    //   remaining[5] = ' '. breakAt = 5.
    //   lines.push("Hello") → remaining = "world and more"
    //   remaining = "world and more", lineWidth = 10
    //   searchEnd = min(10, 13) = 10. remaining[10] = 'm'. Search backwards...
    //   remaining[9] = ' '. breakAt = 9.
    //   lines.push("world and") → remaining = "more"
    //   remaining = "more" <= 10. lines.push("more"). Done.
    // So plainLines = ["Hello", "world and", "more"]
    //
    // Segment boundaries: seg0 "Hello " [0,6), seg1 "world and more" [6,20)
    // Line 0: [0, 5) → seg0[0,5) = "Hello" (style: bold)
    //   globalOffset = 5 + 1 = 6 (space at pos 5 consumed)
    // Line 1: [6, 15) → seg1[6,15) = "world and"
    //   globalOffset = 15 + 1 = 16 (space at pos 15 consumed)
    // Line 2: [16, 20) → seg1[16,20) = "more"
    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'Hello', style: { bold: true } }],
      [{ text: 'world and' }],
      [{ text: 'more' }],
    ]);
    expect(t.layout!.height).toBe(3);
  });

  it('segment splitting at boundary', () => {
    const root = createNode('root', {});
    // "aaaa bbbbb" at width 5 → ["aaaa", "bbbbb"]
    // seg0 = "aaaa " [0,5), seg1 = "bbbbb" [5,10)
    const t = createNode('text', {
      segments: [
        { text: 'aaaa ', style: { bold: true } },
        { text: 'bbbbb', style: { italic: true } },
      ],
    });
    appendChild(root, t);

    layout(root, 5, 24);

    // Line 0: [0,4) → seg0 "aaaa". globalOffset = 4+1 = 5 (space consumed)
    // Line 1: [5,10) → seg1 "bbbbb"
    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'aaaa', style: { bold: true } }],
      [{ text: 'bbbbb', style: { italic: true } }],
    ]);
  });

  it('segments with hanging indent', () => {
    const root = createNode('root', {});
    // "aaaa bbbb cccc dddd" at width 10, hangingIndent 2
    // wrapText gives: ["aaaa bbbb", "cccc", "dddd"] (continuation width = 8)
    const t = createNode('text', {
      segments: [
        { text: 'aaaa ', style: { bold: true } },
        { text: 'bbbb cccc dddd' },
      ],
      hangingIndent: 2,
    });
    appendChild(root, t);

    layout(root, 10, 24);

    // Concat = "aaaa bbbb cccc dddd" (19 chars)
    // seg0 "aaaa " [0,5), seg1 "bbbb cccc dddd" [5,19)
    // Line 0: [0,9) "aaaa bbbb" → seg0[0,5) "aaaa " + seg1[5,9) "bbbb"
    //   globalOffset = 9+1 = 10 (space at pos 9 consumed)
    // Line 1: [10,14) "cccc" → seg1[10,14) "cccc"
    //   globalOffset = 14+1 = 15 (space at pos 14 consumed)
    // Line 2: [15,19) "dddd" → seg1[15,19) "dddd"
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

    layout(root, 40, 24);

    expect(t.layout!.wrappedLines).toEqual([
      [{ text: 'actual' }],
    ]);
  });
});

// ─── Width clamping tests ──────────────────────────────────────────────

describe('width clamping', () => {
  it('fixed-width box is clamped to available width when terminal is narrower', () => {
    const root = createNode('root', {});
    const b = box({ width: 62 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);

    // Box requested 62 but only 40 available → clamped to 40
    expect(b.layout!.width).toBe(40);
    expect(b.children[0]!.layout!.width).toBe(40);
  });

  it('fixed-width box is NOT clamped when terminal is wider', () => {
    const root = createNode('root', {});
    const b = box({ width: 62 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 80, 24);

    // Plenty of room — width stays at 62
    expect(b.layout!.width).toBe(62);
    expect(b.children[0]!.layout!.width).toBe(62);
  });

  it('content reflows when box is clamped', () => {
    const root = createNode('root', {});
    const b = box({ width: 60 });
    // "hello world" fits in 60 columns (1 line) but wraps at 10
    appendChild(b, text('hello world'));
    appendChild(root, b);

    layout(root, 60, 24);
    expect(b.children[0]!.layout!.height).toBe(1);

    // Terminal shrinks to 10 → box clamped to 10 → text wraps
    layout(root, 10, 24);
    expect(b.layout!.width).toBe(10);
    expect(b.children[0]!.layout!.wrappedLines).toEqual(wl('hello', 'world'));
    expect(b.children[0]!.layout!.height).toBe(2);
  });

  it('clamped box with border and padding — content width accounts for both', () => {
    const root = createNode('root', {});
    // border(1+1) + padding(2+2) = 6 columns of chrome
    const b = box({ width: 60, borderStyle: 'single', padding: 2 });
    appendChild(b, text('hello world'));
    appendChild(root, b);

    // Terminal at 20 → box clamped to 20 → content width = 20 - 6 = 14
    layout(root, 20, 24);
    expect(b.layout!.width).toBe(20);
    expect(b.children[0]!.layout!.width).toBe(14);
    expect(b.children[0]!.layout!.x).toBe(3); // border(1) + padding(2)
  });

  it('clamped box with margins — margins reduce available width before clamp', () => {
    const root = createNode('root', {});
    const b = box({ width: 60, marginLeft: 5, marginRight: 5 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    // Terminal at 40 → available for box = 40 - 5 - 5 = 30 → box clamped to 30
    layout(root, 40, 24);
    expect(b.layout!.x).toBe(5);
    expect(b.layout!.width).toBe(30);
  });

  it('row: fixed-width child clamped to row width', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 50 });
    appendChild(a, text('wide'));
    const b = box({ flexGrow: 1 });
    appendChild(b, text('fill'));
    appendChild(row, a);
    appendChild(row, b);
    appendChild(root, row);

    // Row is 40 wide. Child 'a' requests 50 → clamped to 40.
    // Fill child gets max(40 - 40, 0) = 0.
    layout(root, 40, 24);
    expect(a.layout!.width).toBe(40);
    expect(b.layout!.width).toBe(0);
  });

  it('row: fixed-width child fits — no clamping, fill child gets remainder', () => {
    const root = createNode('root', {});
    const row = box({ flexDirection: 'row' });
    const a = box({ width: 10 });
    appendChild(a, text('fixed'));
    const b = box({ flexGrow: 1 });
    appendChild(b, text('fill'));
    appendChild(row, a);
    appendChild(row, b);
    appendChild(root, row);

    layout(root, 40, 24);
    expect(a.layout!.width).toBe(10);
    expect(b.layout!.width).toBe(30);
  });

  it('nested clamping — outer box clamped, inner box clamped to outer', () => {
    const root = createNode('root', {});
    const outer = box({ width: 80 });
    const inner = box({ width: 60 });
    appendChild(inner, text('content'));
    appendChild(outer, inner);
    appendChild(root, outer);

    // Terminal at 40 → outer clamped to 40 → inner clamped to 40
    layout(root, 40, 24);
    expect(outer.layout!.width).toBe(40);
    expect(inner.layout!.width).toBe(40);
    expect(inner.children[0]!.layout!.width).toBe(40);
  });

  it('width exactly equals available — no clamping', () => {
    const root = createNode('root', {});
    const b = box({ width: 40 });
    appendChild(b, text('hello'));
    appendChild(root, b);

    layout(root, 40, 24);
    expect(b.layout!.width).toBe(40);
  });

  it('header-like box: shrinks from full size to narrow terminal', () => {
    const root = createNode('root', {});
    // Simulates the header: width=62, border, padding
    const header = box({ width: 62, borderStyle: 'double', paddingTop: 1, paddingBottom: 1 });
    appendChild(header, text('Welcome back!'));
    appendChild(header, text('Model info'));
    appendChild(root, header);

    // Full size
    layout(root, 80, 24);
    expect(header.layout!.width).toBe(62);
    // content width = 62 - 2 (border) = 60
    expect(header.children[0]!.layout!.width).toBe(60);

    // Narrow terminal
    layout(root, 30, 24);
    expect(header.layout!.width).toBe(30);
    // content width = 30 - 2 (border) = 28
    expect(header.children[0]!.layout!.width).toBe(28);
  });
});

// ─── alignItems tests ──────────────────────────────────────────────────

describe('alignItems', () => {
  it('center — text node gets textAlign=center (no block shift)', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'center' });
    appendChild(b, text('hi'));  // 2 chars in 40-wide container
    appendChild(root, b);

    layout(root, 40, 24);

    const t = b.children[0]!;
    // Text nodes are NOT block-shifted; per-line centering happens in rasterizer
    expect(t.layout!.x).toBe(0);
    expect(t.layout!.textAlign).toBe('center');
  });

  it('flex-end — text node gets textAlign=right (no block shift)', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'flex-end' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    layout(root, 40, 24);

    const t = b.children[0]!;
    // Text nodes are NOT block-shifted; per-line alignment happens in rasterizer
    expect(t.layout!.x).toBe(0);
    expect(t.layout!.textAlign).toBe('right');
  });

  it('flex-start — no shift (same as default)', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'flex-start' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(b.children[0]!.layout!.x).toBe(0);
  });

  it('stretch (default) — no shift', () => {
    const root = createNode('root', {});
    const b = box({ alignItems: 'stretch' });
    appendChild(b, text('hi'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(b.children[0]!.layout!.x).toBe(0);
  });

  it('no alignItems — no shift', () => {
    const root = createNode('root', {});
    const b = box({});
    appendChild(b, text('hi'));
    appendChild(root, b);

    layout(root, 40, 24);

    expect(b.children[0]!.layout!.x).toBe(0);
  });

  it('center — box with explicit width centered', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const child = box({ width: 20 });
    appendChild(child, text('content'));
    appendChild(parent, child);
    appendChild(root, parent);

    layout(root, 40, 24);

    // child width = 20, slack = 40 - 20 = 20, offset = 10
    expect(child.layout!.x).toBe(10);
    // child's text is shifted too
    expect(child.children[0]!.layout!.x).toBe(10);
  });

  it('center — box without explicit width fills parent (no shift)', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const child = box({});
    appendChild(child, text('content'));
    appendChild(parent, child);
    appendChild(root, parent);

    layout(root, 40, 24);

    // child fills 40 (naturalWidth = 40), no slack
    expect(child.layout!.x).toBe(0);
  });

  it('center — multiple text children each get textAlign=center', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    appendChild(parent, text('hi'));      // 2 chars
    appendChild(parent, text('hello'));   // 5 chars
    appendChild(root, parent);

    layout(root, 40, 24);

    // Text nodes stay at x=0, per-line centering via textAlign
    expect(parent.children[0]!.layout!.x).toBe(0);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
    expect(parent.children[1]!.layout!.x).toBe(0);
    expect(parent.children[1]!.layout!.textAlign).toBe('center');
  });

  it('center with padding — text gets textAlign=center, x at padding offset', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center', paddingLeft: 4, paddingRight: 4 });
    appendChild(parent, text('hi'));
    appendChild(root, parent);

    layout(root, 40, 24);

    // content x = paddingLeft = 4, text stays there (no block shift)
    expect(parent.children[0]!.layout!.x).toBe(4);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center with border — text gets textAlign=center, x at border offset', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center', borderStyle: 'single' });
    appendChild(parent, text('hi'));
    appendChild(root, parent);

    layout(root, 40, 24);

    // content x = 1 (border), text stays there (no block shift)
    expect(parent.children[0]!.layout!.x).toBe(1);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center — text fills width, no shift', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    // text exactly fills 10 columns
    appendChild(parent, text('1234567890'));
    appendChild(root, parent);

    layout(root, 10, 24);

    expect(parent.children[0]!.layout!.x).toBe(0);
  });

  it('center — wrapped text gets textAlign=center (no block shift)', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    // "hello world" at width 10 wraps to ["hello", "world"] — longest = 5
    appendChild(parent, text('hello world'));
    appendChild(root, parent);

    layout(root, 10, 24);

    // Text nodes: no block shift, per-line centering in rasterizer
    expect(parent.children[0]!.layout!.x).toBe(0);
    expect(parent.children[0]!.layout!.textAlign).toBe('center');
  });

  it('center — segments get textAlign=center (no block shift)', () => {
    const root = createNode('root', {});
    const parent = box({ alignItems: 'center' });
    const t = createNode('text', {
      segments: [{ text: 'hi', style: { bold: true } }],
    });
    appendChild(parent, t);
    appendChild(root, parent);

    layout(root, 40, 24);

    // Text nodes: no block shift, per-line centering in rasterizer
    expect(t.layout!.x).toBe(0);
    expect(t.layout!.textAlign).toBe('center');
  });
});
