import { describe, it, expect } from 'bun:test';
import { flattenInline } from '../../src/components/markdown-inline.js';
import type { Segment } from '../../src/core/nodes.js';
import type { PhrasingContent } from 'mdast';

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
