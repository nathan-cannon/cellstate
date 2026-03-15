import React from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, Content, PhrasingContent, List, ListItem } from 'mdast';
import type { Segment, SegmentStyle } from './nodes.js';
import { highlightCode } from './highlighter.js';
import { Box, Text } from './components.js';

/**
 * Recursively walk inline mdast nodes, accumulating styles,
 * and emit Segment objects at text leaves.
 */
export function flattenInline(
  children: PhrasingContent[],
  styles: SegmentStyle = {},
): Segment[] {
  const result: Segment[] = [];

  for (const node of children) {
    switch (node.type) {
      case 'text': {
        const style = hasStyle(styles) ? styles : undefined;
        result.push(style ? { text: node.value, style } : { text: node.value });
        break;
      }

      case 'strong':
        result.push(...flattenInline(node.children, { ...styles, bold: true }));
        break;

      case 'emphasis':
        result.push(...flattenInline(node.children, { ...styles, italic: true }));
        break;

      case 'delete':
        result.push(...flattenInline(node.children, { ...styles, strikethrough: true }));
        break;

      case 'inlineCode': {
        const style = { ...styles, dim: true };
        result.push({ text: node.value, style });
        break;
      }

      case 'link':
        result.push(...flattenInline(node.children, { ...styles, underline: true }));
        result.push({ text: ` (${node.url})`, style: { ...styles, dim: true } });
        break;

      case 'break':
        result.push({ text: '\n' });
        break;

      default:
        if ('value' in node && typeof (node as any).value === 'string') {
          const style = hasStyle(styles) ? styles : undefined;
          result.push(style ? { text: (node as any).value, style } : { text: (node as any).value });
        } else if ('children' in node && Array.isArray((node as any).children)) {
          result.push(...flattenInline((node as any).children, styles));
        }
        break;
    }
  }

  return result;
}

/** Check if a SegmentStyle has any non-undefined properties */
function hasStyle(s: SegmentStyle): boolean {
  return s.bold !== undefined || s.italic !== undefined || s.underline !== undefined ||
    s.strikethrough !== undefined || s.dim !== undefined || s.fg !== undefined;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse a markdown string and return React elements using Box/Text components.
 */
export function markdownToElements(input: string): React.ReactNode {
  const tree = parser.parse(input) as Root;
  return React.createElement(
    Box,
    { key: 'md-root', gap: 1 },
    ...renderBlockChildren(tree.children),
  );
}

function renderBlockChildren(nodes: Content[]): React.ReactNode[] {
  return nodes.map((node, i) => renderBlock(node, i));
}

function renderBlock(node: Content, index: number): React.ReactNode {
  switch (node.type) {
    case 'paragraph':
      return React.createElement(
        Box,
        { key: index },
        React.createElement(Text, { segments: flattenInline(node.children) }),
      );

    case 'heading':
      return React.createElement(
        Box,
        { key: index, depth: node.depth },
        React.createElement(Text, { segments: flattenInline(node.children, { bold: true }) }),
      );

    case 'code': {
      const props: Record<string, any> = { key: index, paddingLeft: 2 };
      if (node.lang) props.lang = node.lang;
      const highlighted = node.lang ? highlightCode(node.value, node.lang) : null;
      if (highlighted) {
        return React.createElement(
          Box,
          props,
          ...highlighted.map((line, i) =>
            React.createElement(Text, { key: i, segments: line }),
          ),
        );
      }
      const lines = node.value.split('\n');
      return React.createElement(
        Box,
        props,
        ...lines.map((line, i) =>
          React.createElement(Text, { key: i }, line),
        ),
      );
    }

    case 'blockquote':
      return React.createElement(
        Box,
        { key: index, flexDirection: 'row' },
        React.createElement(
          Box,
          { width: 2 },
          React.createElement(Text, { color: '#666666' }, '│'),
        ),
        React.createElement(
          Box,
          { flexGrow: 1 },
          ...renderBlockChildren(node.children),
        ),
      );

    case 'list':
      return renderList(node, index);

    case 'thematicBreak':
      return React.createElement(
        Box,
        { key: index },
        React.createElement(Text, { dim: true }, '───'),
      );

    default:
      if ('value' in node && typeof (node as any).value === 'string') {
        return React.createElement(
          Box,
          { key: index },
          React.createElement(Text, null, (node as any).value),
        );
      }
      if ('children' in node && Array.isArray((node as any).children)) {
        return React.createElement(
          Box,
          { key: index },
          ...renderBlockChildren((node as any).children),
        );
      }
      return null;
  }
}

function renderList(list: List, index: number): React.ReactNode {
  const startNum = list.start ?? 1;
  return React.createElement(
    Box,
    { key: index, paddingLeft: 2 },
    ...list.children.map((item, i) =>
      renderListItem(item, i, list.ordered ?? false, startNum + i),
    ),
  );
}

function renderListItem(
  item: ListItem,
  index: number,
  ordered: boolean,
  num: number,
): React.ReactNode {
  const prefix = ordered ? `${num}. ` : '• ';
  return React.createElement(
    Box,
    { key: index, flexDirection: 'row' },
    React.createElement(
      Box,
      { width: prefix.length },
      React.createElement(Text, null, prefix),
    ),
    React.createElement(
      Box,
      { flexGrow: 1 },
      ...renderBlockChildren(item.children),
    ),
  );
}
