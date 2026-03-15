import { describe, it, expect } from 'bun:test';
import React from 'react';
import { mountRoot } from '../../../src/tui/reconciler.js';
import { flattenInline, markdownToElements } from '../../../src/tui/markdown.js';
import type { TNode, Segment } from '../../../src/tui/nodes.js';
import type { PhrasingContent } from 'mdast';

const Box = 'box' as any;

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

const textOf = (node: TNode): string | null => {
  const inst = node.children.find((c) => c.text !== null);
  return inst?.text ?? node.text;
};

/** Render React elements via the reconciler and return the root TNode */
async function renderToTree(element: React.ReactElement): Promise<TNode> {
  let root: TNode | null = null;
  mountRoot(element, (r) => { root = r; });
  await flush();
  expect(root).not.toBeNull();
  return root!;
}

// ─── Section 1: flattenInline unit tests (pure data) ────────────────────

describe('flattenInline', () => {
  it('text node → single segment', () => {
    const nodes: PhrasingContent[] = [{ type: 'text', value: 'hello' }];
    const result = flattenInline(nodes);
    expect(result).toEqual([{ text: 'hello' }]);
  });

  it('strong → segment with bold', () => {
    const nodes: PhrasingContent[] = [
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
    ];
    const result = flattenInline(nodes);
    expect(result).toEqual([{ text: 'bold', style: { bold: true } }]);
  });

  it('emphasis → segment with italic', () => {
    const nodes: PhrasingContent[] = [
      { type: 'emphasis', children: [{ type: 'text', value: 'em' }] },
    ];
    const result = flattenInline(nodes);
    expect(result).toEqual([{ text: 'em', style: { italic: true } }]);
  });

  it('strong containing text, emphasis, text → three segments with correct styles', () => {
    const nodes: PhrasingContent[] = [
      {
        type: 'strong',
        children: [
          { type: 'text', value: 'bold ' },
          { type: 'emphasis', children: [{ type: 'text', value: 'bold-italic' }] },
          { type: 'text', value: ' bold' },
        ],
      },
    ];
    const result = flattenInline(nodes);
    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ text: 'bold ', style: { bold: true } });
    expect(result[1]).toEqual({ text: 'bold-italic', style: { bold: true, italic: true } });
    expect(result[2]).toEqual({ text: ' bold', style: { bold: true } });
  });

  it('inlineCode → segment with dim', () => {
    const nodes: PhrasingContent[] = [
      { type: 'inlineCode', value: 'foo()' },
    ];
    const result = flattenInline(nodes);
    expect(result).toEqual([{ text: 'foo()', style: { dim: true } }]);
  });

  it('link → underlined text segment + dim URL segment', () => {
    const nodes: PhrasingContent[] = [
      {
        type: 'link',
        url: 'https://example.com',
        children: [{ type: 'text', value: 'click' }],
      },
    ];
    const result = flattenInline(nodes);
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ text: 'click', style: { underline: true } });
    expect(result[1]).toEqual({ text: ' (https://example.com)', style: { dim: true } });
  });

  it('delete → segment with strikethrough', () => {
    const nodes: PhrasingContent[] = [
      { type: 'delete', children: [{ type: 'text', value: 'removed' }] },
    ];
    const result = flattenInline(nodes);
    expect(result).toEqual([{ text: 'removed', style: { strikethrough: true } }]);
  });
});

// ─── Section 2: Integration tests via markdownToElements → reconciler ───

describe('markdownToElements', () => {
  it('plain paragraph — single Text with segments', async () => {
    const el = markdownToElements('Hello world');
    const root = await renderToTree(el as React.ReactElement);
    const mdRoot = root.children[0]!;
    expect(mdRoot.props.gap).toBe(1);
    const para = mdRoot.children[0]!;
    expect(para.type).toBe('box');
    // Single Text child with segments prop
    expect(para.children.length).toBe(1);
    const txt = para.children[0]!;
    expect(txt.type).toBe('text');
    expect(txt.props.segments).toEqual([{ text: 'Hello world' }]);
  });

  it('bold, italic, strikethrough — segments on single Text', async () => {
    const el = markdownToElements('**bold** *italic* ~~strike~~');
    const root = await renderToTree(el as React.ReactElement);
    const para = root.children[0]!.children[0]!;
    // Single Text child
    expect(para.children.length).toBe(1);
    const segments: Segment[] = para.children[0]!.props.segments;
    // Find bold segment
    const boldSeg = segments.find(s => s.style?.bold === true);
    expect(boldSeg).toBeDefined();
    expect(boldSeg!.text).toBe('bold');
    // Find italic segment
    const italicSeg = segments.find(s => s.style?.italic === true);
    expect(italicSeg).toBeDefined();
    expect(italicSeg!.text).toBe('italic');
    // Find strikethrough segment
    const strikeSeg = segments.find(s => s.style?.strikethrough === true);
    expect(strikeSeg).toBeDefined();
    expect(strikeSeg!.text).toBe('strike');
  });

  it('heading — Box with depth, Text with bold segments', async () => {
    const el = markdownToElements('## Section Title');
    const root = await renderToTree(el as React.ReactElement);
    const heading = root.children[0]!.children[0]!;
    expect(heading.type).toBe('box');
    expect(heading.props.depth).toBe(2);
    // Single Text child with bold segment
    expect(heading.children.length).toBe(1);
    const segments: Segment[] = heading.children[0]!.props.segments;
    expect(segments).toEqual([{ text: 'Section Title', style: { bold: true } }]);
  });

  it('fenced code block — paddingLeft=2, syntax-highlighted segments, lang prop', async () => {
    const el = markdownToElements('```typescript\nconst x = 1;\nconst y = 2;\n```');
    const root = await renderToTree(el as React.ReactElement);
    const codeBox = root.children[0]!.children[0]!;
    expect(codeBox.type).toBe('box');
    expect(codeBox.props.paddingLeft).toBe(2);
    expect(codeBox.props.lang).toBe('typescript');
    // One Text per line with segments (syntax highlighted)
    expect(codeBox.children.length).toBe(2);
    const line0Segs: Segment[] = codeBox.children[0]!.props.segments;
    expect(line0Segs).toBeDefined();
    // At least one segment should have fg color from syntax highlighting
    const hasColor = line0Segs.some(s => s.style?.fg !== undefined);
    expect(hasColor).toBe(true);
  });

  it('unordered list — bullet-prefixed items', async () => {
    const el = markdownToElements('- first\n- second');
    const root = await renderToTree(el as React.ReactElement);
    const list = root.children[0]!.children[0]!;
    expect(list.type).toBe('box');
    expect(list.children.length).toBe(2);

    const item0 = list.children[0]!;
    expect(item0.props.flexDirection).toBe('row');
    // Bullet prefix box
    const bulletBox = item0.children[0]!;
    expect(bulletBox.props.width).toBe(2);
    expect(textOf(bulletBox.children[0]!)).toBe('• ');
    // Content box with paragraph containing single Text with segments
    const contentBox = item0.children[1]!;
    expect(contentBox.props.flexGrow).toBe(1);
    const contentPara = contentBox.children[0]!;
    expect(contentPara.children.length).toBe(1);
    expect(contentPara.children[0]!.props.segments).toEqual([{ text: 'first' }]);
  });

  it('ordered list — number-prefixed items from start', async () => {
    const el = markdownToElements('1. alpha\n2. beta\n3. gamma');
    const root = await renderToTree(el as React.ReactElement);
    const list = root.children[0]!.children[0]!;
    expect(list.children.length).toBe(3);

    expect(textOf(list.children[0]!.children[0]!.children[0]!)).toBe('1. ');
    expect(textOf(list.children[2]!.children[0]!.children[0]!)).toBe('3. ');
  });

  it('nested list — inner items have additional nesting', async () => {
    const el = markdownToElements('- outer\n  - inner');
    const root = await renderToTree(el as React.ReactElement);
    const outerList = root.children[0]!.children[0]!;
    const outerItem = outerList.children[0]!;
    const contentBox = outerItem.children[1]!;
    const nestedList = contentBox.children.find(
      (c: TNode) => c.type === 'box' && c.children.some(
        (gc: TNode) => gc.props.flexDirection === 'row',
      ),
    );
    expect(nestedList).toBeDefined();
  });

  it('blockquote — row layout with bar and content', async () => {
    const el = markdownToElements('> quoted text');
    const root = await renderToTree(el as React.ReactElement);
    const bq = root.children[0]!.children[0]!;
    expect(bq.type).toBe('box');
    expect(bq.props.flexDirection).toBe('row');
    // First child: bar column (width=2 with │)
    const barCol = bq.children[0]!;
    expect(barCol.props.width).toBe(2);
    // Second child: content column (flexGrow=1)
    const contentCol = bq.children[1]!;
    expect(contentCol.props.flexGrow).toBe(1);
  });

  it('link — segments with underline + dim URL', async () => {
    const el = markdownToElements('[example](https://example.com)');
    const root = await renderToTree(el as React.ReactElement);
    const para = root.children[0]!.children[0]!;
    // Single Text with segments
    expect(para.children.length).toBe(1);
    const segments: Segment[] = para.children[0]!.props.segments;
    const linkSeg = segments.find(s => s.style?.underline === true);
    expect(linkSeg).toBeDefined();
    expect(linkSeg!.text).toBe('example');
    const urlSeg = segments.find(s => s.style?.dim === true && s.text.includes('https://example.com'));
    expect(urlSeg).toBeDefined();
  });

  it('gap between blocks — two paragraphs as children of root Box with gap=1', async () => {
    const el = markdownToElements('First paragraph.\n\nSecond paragraph.');
    const root = await renderToTree(el as React.ReactElement);
    const mdRoot = root.children[0]!;
    expect(mdRoot.props.gap).toBe(1);
    expect(mdRoot.children.length).toBe(2);
    expect(mdRoot.children[0]!.type).toBe('box');
    expect(mdRoot.children[1]!.type).toBe('box');
  });

  it('realistic AI response', async () => {
    const codeContent = [
      'function processEvent(event: Event) {',
      '  // BUG: callback fires after timeout',
      '  setTimeout(() => {',
      '    callback(event);',
      '  }, 100);',
      '}',
    ].join('\n');

    const markdown = [
      '## Analysis',
      '',
      'The `processEvent()` function has a bug — the callback **never fires**.',
      '',
      '```typescript',
      codeContent,
      '```',
      '',
      'To fix this:',
      '',
      '1. Remove the `setTimeout` wrapper',
      '2. Call `callback(event)` directly',
      '3. Verify with the existing test suite',
      '',
      '> Note: this also affects `handleBatch()` which uses the same pattern.',
    ].join('\n');

    const el = markdownToElements(markdown);
    const root = await renderToTree(el as React.ReactElement);
    const mdRoot = root.children[0]!;

    // Block children: heading, paragraph, code, paragraph, ordered list, blockquote
    expect(mdRoot.children.length).toBe(6);

    // 1. Heading — single Text with bold segments
    const heading = mdRoot.children[0]!;
    expect(heading.props.depth).toBe(2);
    expect(heading.children.length).toBe(1);
    const headingSegs: Segment[] = heading.children[0]!.props.segments;
    expect(headingSegs).toEqual([{ text: 'Analysis', style: { bold: true } }]);

    // 2. Paragraph with inline code and bold — single Text with segments
    const para1 = mdRoot.children[1]!;
    expect(para1.type).toBe('box');
    expect(para1.children.length).toBe(1);
    const para1Segs: Segment[] = para1.children[0]!.props.segments;
    const inlineCodeSeg = para1Segs.find(s => s.style?.dim === true && s.text === 'processEvent()');
    expect(inlineCodeSeg).toBeDefined();
    const boldSeg = para1Segs.find(s => s.style?.bold === true && s.text === 'never fires');
    expect(boldSeg).toBeDefined();

    // 3. Code block — one Text per line with syntax-highlighted segments
    const codeBlock = mdRoot.children[2]!;
    expect(codeBlock.props.lang).toBe('typescript');
    expect(codeBlock.props.paddingLeft).toBe(2);
    expect(codeBlock.children.length).toBe(6);
    // Verify at least one segment in the code block has an fg color
    const codeSegs: Segment[] = codeBlock.children[0]!.props.segments;
    expect(codeSegs).toBeDefined();
    const hasCodeColor = codeSegs.some(s => s.style?.fg !== undefined);
    expect(hasCodeColor).toBe(true);

    // 4. Paragraph "To fix this:" — single Text with segments
    const para2 = mdRoot.children[3]!;
    expect(para2.type).toBe('box');
    expect(para2.children.length).toBe(1);
    const para2Segs: Segment[] = para2.children[0]!.props.segments;
    expect(para2Segs).toEqual([{ text: 'To fix this:' }]);

    // 5. Ordered list with 3 items
    const orderedList = mdRoot.children[4]!;
    expect(orderedList.children.length).toBe(3);
    expect(textOf(orderedList.children[0]!.children[0]!.children[0]!)).toBe('1. ');
    expect(textOf(orderedList.children[1]!.children[0]!.children[0]!)).toBe('2. ');
    expect(textOf(orderedList.children[2]!.children[0]!.children[0]!)).toBe('3. ');
    // Verify list item inline content uses segments
    const item1Content = orderedList.children[0]!.children[1]!.children[0]!;
    const item1Segs: Segment[] = item1Content.children[0]!.props.segments;
    const setTimeoutSeg = item1Segs.find(s => s.style?.dim === true && s.text === 'setTimeout');
    expect(setTimeoutSeg).toBeDefined();

    // 6. Blockquote with inline code in segments
    const blockquote = mdRoot.children[5]!;
    expect(blockquote.props.flexDirection).toBe('row');
    // Content is in the second child (flexGrow=1 column)
    const bqContent = blockquote.children[1]!;
    const bqPara = bqContent.children[0]!;
    expect(bqPara.children.length).toBe(1);
    const bqSegs: Segment[] = bqPara.children[0]!.props.segments;
    const bqInlineCode = bqSegs.find(s => s.style?.dim === true && s.text === 'handleBatch()');
    expect(bqInlineCode).toBeDefined();
  });

  it('unknown node type — does not crash', async () => {
    const el = markdownToElements('<div>hello</div>\n\nNormal paragraph.');
    const root = await renderToTree(el as React.ReactElement);
    const mdRoot = root.children[0]!;
    expect(mdRoot.children.length).toBeGreaterThanOrEqual(1);
  });
});
