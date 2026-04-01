/**
 * Benchmark content: message data, TNode tree builders, and markdown
 * content shared across all scenarios. Tree builders bypass React to
 * isolate pipeline stages from reconciliation overhead.
 */
import { createNode, appendChild, type TNode, type Segment } from '../src/core/nodes.js';
import { highlightCode } from '../src/components/highlighter.js';
import { flattenInline } from '../src/components/markdown.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { PhrasingContent } from 'mdast';

// ── Message data (shared with tui-benchmarks) ──

export const USER_MESSAGES = [
  'Can you fix the bug in processEvent?',
  'What about the edge case with empty arrays?',
  'Can you add error handling to the API endpoint?',
  'How do I test this with mocked dependencies?',
  'Refactor this to use async/await instead of callbacks',
  'The CI is failing on the integration tests',
  'Can you split this into smaller functions?',
  'What does this regex do?',
  'Add a retry mechanism for the webhook calls',
  'Why is the memory usage spiking on this route?',
];

export const ASSISTANT_MESSAGES = [
  'Looking at processEvent, the issue is that the callback never fires after the timeout. The setTimeout wrapper prevents execution. I\'ll remove it and call the callback directly, then verify with the existing test suite.',
  'Good catch. When the input array is empty, the reduce call on line 45 throws because there\'s no initial value. I\'ll add an early return for empty arrays and a corresponding test case.',
  'I\'ve added try-catch blocks around the database calls and the external API request. Each error is logged with context and returns an appropriate HTTP status code. The validation middleware already handles malformed input.',
  'You can use jest.mock to replace the database module, then inject a fake response. I\'d recommend testing the happy path, a network timeout, and a malformed response. Here\'s a pattern that avoids coupling to the implementation details.',
  'Done. I replaced the nested callbacks with async/await and added proper error propagation. The control flow is much clearer now. The three existing tests still pass without modification.',
  'The integration test failure is a flaky timing issue. The test asserts immediately after the event fires but the handler runs on the next tick. I\'ve wrapped the assertion in a waitFor block with a 500ms timeout.',
  'I\'ve extracted three helpers: validateInput, transformPayload, and persistResult. Each is under 20 lines and independently testable. The main function now reads as a straightforward pipeline.',
  'That regex matches ISO 8601 timestamps with optional timezone offsets. The capture groups extract year, month, day, hour, minute, second, and offset separately. I\'d replace it with a Date.parse call for clarity.',
  'I\'ve added exponential backoff with jitter, capped at 3 retries. Failed attempts are logged with the response status and body. After exhausting retries, the error is surfaced to the caller with full context.',
  'The memory spike is from accumulating parsed JSON objects in the request handler closure. Each request holds a reference to the full response body until the GC runs. I\'ve moved the parsing into a streaming pipeline that processes chunks incrementally.',
];

export function getMessageBody(index: number): string {
  if (index % 2 === 0) {
    return USER_MESSAGES[Math.floor(index / 2) % USER_MESSAGES.length]!;
  }
  return ASSISTANT_MESSAGES[Math.floor(index / 2) % ASSISTANT_MESSAGES.length]!;
}

export function getRole(index: number): { role: string; isUser: boolean } {
  const isUser = index % 2 === 0;
  return { role: isUser ? 'user' : 'assistant', isUser };
}

export function headerText(messageCount: number): string {
  return `Agent v1.0 | session-bench | msgs: ${messageCount}`;
}

export function inputLineText(counter: number): string {
  return `❯ keypress count: ${counter}`;
}

export const STREAM_WORDS =
  'The issue is in the render function where the callback never fires after the timeout because the setTimeout wrapper prevents synchronous execution of the handler'.split(' ');

// ── Markdown content ──

export const MARKDOWN_MESSAGES: string[] = [
  `## Fixing the Race Condition

The bug is in the event handler registration. Here's the corrected version:

\`\`\`typescript
async function handleConnection(socket: WebSocket) {
  const session = await createSession(socket.id);
  const buffer = new MessageBuffer(1024);

  socket.on('message', async (data) => {
    buffer.push(data);
    const messages = buffer.drain();
    for (const msg of messages) {
      await session.process(msg);
    }
  });

  socket.on('close', () => {
    session.cleanup();
    buffer.clear();
  });
}
\`\`\`

This ensures messages are processed in order and the buffer is properly drained.`,

  `The refactored module exports **three functions**: \`validateInput\`, \`transformPayload\`, and \`persistResult\`. Each handles one stage of the pipeline. The *critical* change is that \`transformPayload\` now returns a [Result type](https://doc.rust-lang.org/std/result/) instead of throwing, which makes error handling explicit at the call site.`,

  `Here's the migration plan:

1. Add the new \`sessions\` table with the updated schema
2. Deploy the dual-write path that populates both old and new tables
3. Run the backfill script to migrate existing rows
4. Switch reads to the new table behind a feature flag
5. Drop the old table after 2 weeks of stable operation

The backfill script handles batching automatically:

\`\`\`typescript
async function backfillSessions(batchSize = 500) {
  let cursor: string | null = null;
  let migrated = 0;

  while (true) {
    const batch = await db.oldSessions
      .find(cursor ? { id: { $gt: cursor } } : {})
      .limit(batchSize)
      .toArray();

    if (batch.length === 0) break;

    const transformed = batch.map(transformSession);
    await db.sessions.insertMany(transformed);

    cursor = batch[batch.length - 1]!.id;
    migrated += batch.length;
    console.log(\`Migrated \${migrated} sessions\`);
  }
}
\`\`\``,
];

// ── Markdown parser for building styled segments ──

const mdParser = unified().use(remarkParse).use(remarkGfm);

function parseMarkdownToSegments(markdown: string): Segment[] {
  const tree = mdParser.parse(markdown);
  const segments: Segment[] = [];

  for (const node of tree.children) {
    if (node.type === 'paragraph') {
      if (segments.length > 0) segments.push({ text: '\n\n' });
      segments.push(...flattenInline(node.children as PhrasingContent[]));
    } else if (node.type === 'heading') {
      if (segments.length > 0) segments.push({ text: '\n\n' });
      segments.push({ text: '#'.repeat(node.depth) + ' ', style: { bold: true } });
      segments.push(...flattenInline(node.children as PhrasingContent[], { bold: true }));
    } else if (node.type === 'code') {
      if (segments.length > 0) segments.push({ text: '\n\n' });
      const highlighted = highlightCode(node.value, node.lang ?? '');
      if (highlighted) {
        for (let i = 0; i < highlighted.length; i++) {
          if (i > 0) segments.push({ text: '\n' });
          segments.push(...highlighted[i]!);
        }
      } else {
        segments.push({ text: node.value });
      }
    } else if (node.type === 'list') {
      for (let li = 0; li < node.children.length; li++) {
        const item = node.children[li]!;
        segments.push({ text: '\n' });
        const prefix = node.ordered ? `${li + 1}. ` : '- ';
        segments.push({ text: prefix });
        for (const child of item.children) {
          if (child.type === 'paragraph') {
            segments.push(...flattenInline(child.children as PhrasingContent[]));
          }
        }
      }
    }
  }

  return segments;
}

// ── Tree builders ──

/**
 * Build a chat UI tree with N messages. Same visual output as the React ChatUI component.
 */
export function buildChatTree(
  messageCount: number,
  counter: number,
  streamingText?: string,
): TNode {
  const root = createNode('root', {});

  // Outer column box
  const col = createNode('box', { flexDirection: 'column' });
  appendChild(root, col);

  // Header
  const header = createNode('text', { bold: true, fg: '#5599ff' });
  const headerTextNode = createNode('text', {});
  headerTextNode.text = headerText(messageCount);
  appendChild(header, headerTextNode);
  appendChild(col, header);

  // Messages
  for (let i = 0; i < messageCount; i++) {
    const { role, isUser } = getRole(i);
    let body = getMessageBody(i);
    if (streamingText !== undefined && i === messageCount - 1 && !isUser) {
      body = body + ' ' + streamingText;
    }

    const msgBox = createNode('box', { flexDirection: 'column' });

    const roleText = createNode('text', { bold: true, fg: isUser ? '#00cc66' : '#cc66ff' });
    const roleTextNode = createNode('text', {});
    roleTextNode.text = role;
    appendChild(roleText, roleTextNode);
    appendChild(msgBox, roleText);

    const bodyText = createNode('text', {});
    const bodyTextNode = createNode('text', {});
    bodyTextNode.text = body;
    appendChild(bodyText, bodyTextNode);
    appendChild(msgBox, bodyText);

    appendChild(col, msgBox);
  }

  // Input line
  const input = createNode('text', {});
  const inputTextNode = createNode('text', {});
  inputTextNode.text = inputLineText(counter);
  appendChild(input, inputTextNode);
  appendChild(col, input);

  return root;
}

/**
 * Build a chat UI tree with markdown content (styled segments).
 */
export function buildMarkdownChatTree(messageCount: number): TNode {
  const root = createNode('root', {});
  const col = createNode('box', { flexDirection: 'column' });
  appendChild(root, col);

  // Header
  const header = createNode('text', { bold: true, fg: '#5599ff' });
  const headerTextNode = createNode('text', {});
  headerTextNode.text = headerText(messageCount);
  appendChild(header, headerTextNode);
  appendChild(col, header);

  // Messages — alternate user plain text and assistant markdown
  for (let i = 0; i < messageCount; i++) {
    const { role, isUser } = getRole(i);
    const msgBox = createNode('box', { flexDirection: 'column' });

    const roleText = createNode('text', { bold: true, fg: isUser ? '#00cc66' : '#cc66ff' });
    const roleTextNode = createNode('text', {});
    roleTextNode.text = role;
    appendChild(roleText, roleTextNode);
    appendChild(msgBox, roleText);

    if (isUser) {
      const bodyText = createNode('text', {});
      const bodyTextNode = createNode('text', {});
      bodyTextNode.text = getMessageBody(i);
      appendChild(bodyText, bodyTextNode);
      appendChild(msgBox, bodyText);
    } else {
      // Use markdown content with styled segments
      const mdIndex = Math.floor(i / 2) % MARKDOWN_MESSAGES.length;
      const segments = parseMarkdownToSegments(MARKDOWN_MESSAGES[mdIndex]!);
      const bodyText = createNode('text', { segments });
      appendChild(msgBox, bodyText);
    }

    appendChild(col, msgBox);
  }

  // Input line
  const input = createNode('text', {});
  const inputTextNode = createNode('text', {});
  inputTextNode.text = inputLineText(0);
  appendChild(input, inputTextNode);
  appendChild(col, input);

  return root;
}

/**
 * Collect all message body strings for a given message count.
 */
export function collectAllText(messageCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < messageCount; i++) {
    parts.push(getMessageBody(i));
  }
  return parts.join('\n');
}

/**
 * Collect styled segments from markdown messages for wrapSegments benchmarking.
 */
export function collectMarkdownSegments(messageCount: number): Segment[] {
  const allSegments: Segment[] = [];
  for (let i = 0; i < messageCount; i++) {
    const { isUser } = getRole(i);
    if (!isUser) {
      const mdIndex = Math.floor(i / 2) % MARKDOWN_MESSAGES.length;
      allSegments.push(...parseMarkdownToSegments(MARKDOWN_MESSAGES[mdIndex]!));
    }
  }
  return allSegments.length > 0 ? allSegments : [{ text: 'placeholder' }];
}
