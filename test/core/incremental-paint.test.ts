import { describe, it, expect } from 'bun:test';
import { paintTree } from '../../src/core/paint.js';
import {
  createNode,
  appendChild,
  removeChild,
  type TNode,
  type LayoutResult,
  type WrappedLine,
} from '../../src/core/nodes.js';
import { propagateDirty, clearAllDirty } from '../../src/core/dirty.js';
import { CharTable, SPACE_CHAR } from '../../src/core/char-table.js';
import { StyleTable, DEFAULT_STYLE } from '../../src/core/style-table.js';
import { LinkTable, NO_LINK } from '../../src/core/link-table.js';
import {
  createCellBuffer,
  clearBuffer,
  readCell,
  isDamaged,
  bufferToText,
  type CellBuffer,
  type DamageBox,
} from '../../src/core/cell-buffer.js';
import { createFlexNodeFactory } from '../../src/layout/yoga-flex.js';
import { applyBoxProps } from '../../src/layout/apply-props.js';
import { computeTextLayout } from '../../src/layout/text-layout.js';
import { populateLayoutResults } from '../../src/layout/populate-layout.js';
import { createPerf } from '../../src/core/perf.js';

const _factory = createFlexNodeFactory();

function makeTables() {
  return { ct: new CharTable(), st: new StyleTable(), lt: new LinkTable() };
}

function wl(...lines: string[]): WrappedLine[] {
  return lines.map(line => [{ text: line }]);
}

/** Check if a row is within the damage bounding box. */
function isRowInDamage(buf: CellBuffer, row: number): boolean {
  if (!buf.damageBox) return false;
  return row >= buf.damageBox.minRow && row <= buf.damageBox.maxRow;
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

function layout(root: TNode, width: number): void {
  attachFlexNodes(root);
  root.flexNode!.setWidth(width);
  root.flexNode!.calculateLayout(width);
  populateLayoutResults(root);
}

/** Helper: create a text node with a text-instance child */
function makeText(content: string, props: Record<string, any> = {}): TNode {
  const el = createNode('text', { segments: [{ text: content }], ...props });
  const inst = createNode('text', {});
  inst.text = content;
  appendChild(el, inst);
  return el;
}

/** Run full paint cycle: layout + paint, return buffer + tables */
function fullPaint(root: TNode, width: number, height: number, frontBuffer: CellBuffer | null = null) {
  const tables = makeTables();
  const buf = createCellBuffer(width, height);
  layout(root, width);
  const perf = createPerf(true);
  paintTree(root, buf, frontBuffer, tables.ct, tables.st, tables.lt, 0, perf);
  return { buf, perf, ...tables };
}

// =====================================================================
// Blit eligibility
// =====================================================================

describe('incremental paint — blit eligibility', () => {
  it('clean subtree with unchanged bounds is blitted, not re-painted', () => {
    const root = createNode('root');
    const text = makeText('hello');
    appendChild(root, text);

    // First paint → establishes content
    const tables = makeTables();
    const front = createCellBuffer(40, 5);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);
    // paintTree clears dirty flags

    // Second paint → should blit since nothing changed
    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const back = createCellBuffer(40, 5);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    // Content should match front buffer
    expect(bufferToText(back, tables.ct)).toBe(bufferToText(front, tables.ct));

    const snap = perf.snapshot()!;
    expect(snap.counts.subtreeBlits).toBeGreaterThan(0);
  });

  it('dirty node is re-painted, not blitted', () => {
    const root = createNode('root');
    const text = makeText('hello');
    appendChild(root, text);

    const tables = makeTables();
    const front = createCellBuffer(40, 5);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(text);

    const back = createCellBuffer(40, 5);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0);

    // The text node's rows should be in the damage box (re-painted via writeCell)
    const textLayout = text.layout!;
    for (let r = textLayout.y; r < textLayout.y + textLayout.height; r++) {
      expect(isRowInDamage(back, r)).toBe(true);
    }
  });

  it('node with changed bounds is painted even though _dirty is false', () => {
    const root = createNode('root');
    const box = createNode('box', { paddingTop: 0 });
    const text = makeText('hello');
    appendChild(box, text);
    appendChild(root, box);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    box.props.paddingTop = 2;
    applyBoxProps(box.flexNode!, box.props);
    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    expect(text._dirty).toBe(true);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    const snap = perf.snapshot()!;
    expect(snap.counts.subtreesPainted).toBeGreaterThan(0);
  });

  it('_childWasDetached forces full paint of parent subtree', () => {
    const root = createNode('root');
    const parent = createNode('box');
    const child1 = makeText('keep');
    const child2 = makeText('remove');
    appendChild(parent, child1);
    appendChild(parent, child2);
    appendChild(root, parent);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    removeChild(parent, child2);
    parent._childWasDetached = true;

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(parent);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    const snap = perf.snapshot()!;
    expect(snap.counts.subtreesPainted).toBeGreaterThan(0);
  });

  it('frontBuffer=null paints everything (first-frame behavior)', () => {
    const root = createNode('root');
    const text = makeText('hello');
    appendChild(root, text);

    const tables = makeTables();
    const buf = createCellBuffer(40, 5);
    layout(root, 40);
    paintTree(root, buf, null, tables.ct, tables.st, tables.lt, 0);

    // All rows with content should be in damage box
    const textLayout = text.layout!;
    for (let r = textLayout.y; r < textLayout.y + textLayout.height; r++) {
      expect(isRowInDamage(buf, r)).toBe(true);
    }
  });
});

// =====================================================================
// Sibling overflow contamination
// =====================================================================

describe('incremental paint — sibling overflow', () => {
  it('dirty first sibling forces painting of clean second sibling', () => {
    const root = createNode('root');
    const sib1 = makeText('first');
    const sib2 = makeText('second');
    appendChild(root, sib1);
    appendChild(root, sib2);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(sib1);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    // sib2 should be painted (not blitted) due to overflow taint
    const snap = perf.snapshot()!;
    expect(snap.counts.overflowTaintForced).toBeGreaterThan(0);

    // sib2's rows should be in damage (re-painted)
    const sib2Layout = sib2.layout!;
    for (let r = sib2Layout.y; r < sib2Layout.y + sib2Layout.height; r++) {
      expect(isRowInDamage(back, r)).toBe(true);
    }
  });

  it('dirty sibling with overflow:hidden does NOT taint subsequent siblings', () => {
    const root = createNode('root');
    const sib1 = createNode('box', { overflow: 'hidden' });
    const sib1Text = makeText('first');
    appendChild(sib1, sib1Text);
    appendChild(root, sib1);

    const sib2 = makeText('second');
    appendChild(root, sib2);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(sib1);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    const snap = perf.snapshot()!;
    expect(snap.counts.overflowTaintForced ?? 0).toBe(0);
    expect(snap.counts.subtreeBlits).toBeGreaterThan(0);
  });

  it('third sibling is tainted by dirty second sibling', () => {
    const root = createNode('root');
    const sib1 = makeText('first');
    const sib2 = makeText('second');
    const sib3 = makeText('third');
    appendChild(root, sib1);
    appendChild(root, sib2);
    appendChild(root, sib3);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(sib2);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    // sib3 should be painted due to taint from sib2 — its rows are in damage
    const sib3Layout = sib3.layout!;
    for (let r = sib3Layout.y; r < sib3Layout.y + sib3Layout.height; r++) {
      expect(isRowInDamage(back, r)).toBe(true);
    }
  });
});

// =====================================================================
// Absolute removal
// =====================================================================

describe('incremental paint — pending clears', () => {
  it('pending clears on a node erase the old rect and damage the back buffer', () => {
    const root = createNode('root');
    const box = createNode('box');
    const text = makeText('content');
    appendChild(box, text);
    appendChild(root, box);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    // Simulate: a child was removed and its bounds were collected onto root.
    root._pendingClears = [{ x: 5, y: 2, width: 8, height: 3 }];
    propagateDirty(root);

    const back = createCellBuffer(40, 10);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0);

    // The cleared rect must be inside the back buffer's damage box.
    expect(back.damageBox).not.toBeNull();
    const d = back.damageBox!;
    expect(d.minRow).toBeLessThanOrEqual(2);
    expect(d.maxRow).toBeGreaterThanOrEqual(4);
    expect(d.minCol).toBeLessThanOrEqual(5);
    expect(d.maxCol).toBeGreaterThanOrEqual(12);
    // Pending clears are consumed
    expect(root._pendingClears).toBeUndefined();
  });

  it('normal-flow child removal only affects parent subtree; siblings elsewhere can blit', () => {
    const root = createNode('root');
    const leftBox = createNode('box');
    const leftText = makeText('left');
    appendChild(leftBox, leftText);

    const rightBox = createNode('box');
    const rightText = makeText('right');
    const toRemove = makeText('bye');
    appendChild(rightBox, rightText);
    appendChild(rightBox, toRemove);

    appendChild(root, leftBox);
    appendChild(root, rightBox);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    removeChild(rightBox, toRemove);
    rightBox._childWasDetached = true;
    propagateDirty(rightBox);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    const snap = perf.snapshot()!;
    expect(snap.counts.subtreeBlits).toBeGreaterThan(0);
    expect(snap.counts.subtreesPainted).toBeGreaterThan(0);
  });
});

// =====================================================================
// Integration with damage tracking
// =====================================================================

describe('incremental paint — damage tracking integration', () => {
  it('content growth: existing rows blitted, new rows painted', () => {
    const root = createNode('root');
    const texts: TNode[] = [];
    for (let i = 0; i < 3; i++) {
      const t = makeText(`line${i}`);
      appendChild(root, t);
      texts.push(t);
    }

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    const newTexts: TNode[] = [];
    for (let i = 3; i < 5; i++) {
      const t = makeText(`line${i}`);
      const fn = _factory();
      t.flexNode = fn;
      fn.setMeasureFunc((w, wm) => computeTextLayout(t, w, wm));
      appendChild(root, t);
      newTexts.push(t);
    }

    // Mark new children dirty so they are painted (not blitted)
    for (const t of newTexts) propagateDirty(t);
    propagateDirty(root);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const back = createCellBuffer(40, 10);
    const perf = createPerf(true);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0, perf);

    const snap = perf.snapshot()!;
    expect(snap.counts.subtreeBlits).toBeGreaterThan(0);
    expect(snap.counts.subtreesPainted).toBeGreaterThan(0);

    // Back buffer should have damage covering at least the new rows
    expect(isDamaged(back)).toBe(true);
  });

  it('single text change: header/footer blitted, body re-painted', () => {
    const root = createNode('root');
    const header = makeText('=== Header ===');
    const body = makeText('body content');
    const footer = makeText('=== Footer ===');
    appendChild(root, header);
    appendChild(root, body);
    appendChild(root, footer);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    propagateDirty(body);

    const back = createCellBuffer(40, 10);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0);

    // Buffer should be damaged (body was re-painted)
    expect(isDamaged(back)).toBe(true);

    // Body rows should be in damage
    const bodyLayout = body.layout!;
    for (let r = bodyLayout.y; r < bodyLayout.y + bodyLayout.height; r++) {
      expect(isRowInDamage(back, r)).toBe(true);
    }
  });
});

// =====================================================================
// Content correctness
// =====================================================================

describe('incremental paint — content correctness', () => {
  it('no changes → all blitted, content matches', () => {
    const root = createNode('root');
    const text = makeText('hello world');
    appendChild(root, text);

    const tables = makeTables();
    const front = createCellBuffer(40, 5);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const back = createCellBuffer(40, 5);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0);

    // Content should match
    expect(bufferToText(back, tables.ct)).toBe(bufferToText(front, tables.ct));
  });

  it('bordered box with text change: border preserved, text updated', () => {
    const root = createNode('root');
    const box = createNode('box', { borderStyle: 'single' });
    const text = makeText('old');
    appendChild(box, text);
    appendChild(root, box);

    const tables = makeTables();
    const front = createCellBuffer(40, 10);
    layout(root, 40);
    paintTree(root, front, null, tables.ct, tables.st, tables.lt, 0);

    const frontText = bufferToText(front, tables.ct);
    expect(frontText).toContain('┌');
    expect(frontText).toContain('└');

    root.flexNode!.setWidth(40);
    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const textInst = text.children.find(c => c.text !== null)!;
    textInst.text = 'new';
    text.props.segments = [{ text: 'new' }];
    text._wrapCache = null;
    text.flexNode!.markDirty();
    propagateDirty(text);

    root.flexNode!.calculateLayout(40);
    populateLayoutResults(root);

    const back = createCellBuffer(40, 10);
    paintTree(root, back, front, tables.ct, tables.st, tables.lt, 0);

    const backText = bufferToText(back, tables.ct);
    expect(backText).toContain('┌');
    expect(backText).toContain('└');
    expect(backText).toContain('new');
    expect(backText).not.toContain('old');
  });
});
