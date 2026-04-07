/**
 * Inline mdast → Segment flattener. Extracted from the old markdown.tsx
 * for backward compatibility. Used by consumers that need to convert
 * mdast inline nodes to Segment arrays.
 */
import type { PhrasingContent } from 'mdast';
import type { Segment, SegmentStyle } from '../core/nodes.js';

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
