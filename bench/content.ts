/**
 * Benchmark content: message data, TNode tree builders, and markdown
 * content shared across all scenarios. Tree builders bypass React to
 * isolate pipeline stages from reconciliation overhead.
 */
import { createNode, appendChild, type TNode, type Segment } from '../src/core/nodes.js';
import { highlightCode } from '../src/components/highlighter.js';
import { flattenInline } from '../src/components/markdown-inline.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { PhrasingContent } from 'mdast';
import type { FlexNodeFactory } from '../src/layout/flex-node.js';
import { applyBoxProps } from '../src/layout/apply-props.js';
import { computeTextLayout } from '../src/layout/text-layout.js';

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

export function parseMarkdownToSegments(markdown: string): Segment[] {
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
 * Create a TNode with an optional FlexNode, mirroring the reconciler's
 * createInstance logic for box/text/root nodes.
 */
function makeNode(
  type: TNode['type'],
  props: Record<string, any>,
  factory?: FlexNodeFactory,
): TNode {
  const flexNode = factory ? factory() : undefined;
  const node = createNode(type, props, flexNode);
  if (flexNode) {
    if (type === 'text') {
      flexNode.setMeasureFunc((width, widthMode) =>
        computeTextLayout(node, width, widthMode),
      );
    } else {
      applyBoxProps(flexNode, props, type === 'root');
    }
  }
  return node;
}

/**
 * Build a chat UI tree with N messages. Same visual output as the React ChatUI component.
 * Pass a FlexNodeFactory to attach layout nodes (required for paintTree benchmarks).
 */
export function buildChatTree(
  messageCount: number,
  counter: number,
  streamingText?: string,
  factory?: FlexNodeFactory,
): TNode {
  const root = makeNode('root', {}, factory);

  // Outer column box
  const col = makeNode('box', { flexDirection: 'column' }, factory);
  appendChild(root, col);

  // Header
  const header = makeNode('text', { bold: true, fg: '#5599ff' }, factory);
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

    const msgBox = makeNode('box', { flexDirection: 'column' }, factory);

    const roleText = makeNode('text', { bold: true, fg: isUser ? '#00cc66' : '#cc66ff' }, factory);
    const roleTextNode = createNode('text', {});
    roleTextNode.text = role;
    appendChild(roleText, roleTextNode);
    appendChild(msgBox, roleText);

    const bodyText = makeNode('text', {}, factory);
    const bodyTextNode = createNode('text', {});
    bodyTextNode.text = body;
    appendChild(bodyText, bodyTextNode);
    appendChild(msgBox, bodyText);

    appendChild(col, msgBox);
  }

  // Input line
  const input = makeNode('text', {}, factory);
  const inputTextNode = createNode('text', {});
  inputTextNode.text = inputLineText(counter);
  appendChild(input, inputTextNode);
  appendChild(col, input);

  return root;
}

/**
 * Build a chat UI tree with markdown content (styled segments).
 * Pass a FlexNodeFactory to attach layout nodes (required for paintTree benchmarks).
 */
export function buildMarkdownChatTree(
  messageCount: number,
  factory?: FlexNodeFactory,
): TNode {
  const root = makeNode('root', {}, factory);
  const col = makeNode('box', { flexDirection: 'column' }, factory);
  appendChild(root, col);

  // Header
  const header = makeNode('text', { bold: true, fg: '#5599ff' }, factory);
  const headerTextNode = createNode('text', {});
  headerTextNode.text = headerText(messageCount);
  appendChild(header, headerTextNode);
  appendChild(col, header);

  // Messages — alternate user plain text and assistant markdown
  for (let i = 0; i < messageCount; i++) {
    const { role, isUser } = getRole(i);
    const msgBox = makeNode('box', { flexDirection: 'column' }, factory);

    const roleText = makeNode('text', { bold: true, fg: isUser ? '#00cc66' : '#cc66ff' }, factory);
    const roleTextNode = createNode('text', {});
    roleTextNode.text = role;
    appendChild(roleText, roleTextNode);
    appendChild(msgBox, roleText);

    if (isUser) {
      const bodyText = makeNode('text', {}, factory);
      const bodyTextNode = createNode('text', {});
      bodyTextNode.text = getMessageBody(i);
      appendChild(bodyText, bodyTextNode);
      appendChild(msgBox, bodyText);
    } else {
      // Use markdown content with styled segments
      const mdIndex = Math.floor(i / 2) % MARKDOWN_MESSAGES.length;
      const segments = parseMarkdownToSegments(MARKDOWN_MESSAGES[mdIndex]!);
      const bodyText = makeNode('text', { segments }, factory);
      appendChild(msgBox, bodyText);
    }

    appendChild(col, msgBox);
  }

  // Input line
  const input = makeNode('text', {}, factory);
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

// ── Code generation for bulk-update benchmarks ──

const CODE_FRAGMENTS = [
  'export interface Config {\n  host: string;\n  port: number;\n  debug: boolean;\n  retries: number;\n}',
  'function validateInput(input: unknown): input is Config {\n  if (typeof input !== "object" || input === null) return false;\n  const obj = input as Record<string, unknown>;\n  return typeof obj.host === "string" && typeof obj.port === "number";\n}',
  'async function fetchWithRetry(url: string, retries: number): Promise<Response> {\n  for (let attempt = 0; attempt < retries; attempt++) {\n    try {\n      const response = await fetch(url);\n      if (response.ok) return response;\n      console.warn(`Attempt ${attempt + 1} failed: ${response.status}`);\n    } catch (err) {\n      if (attempt === retries - 1) throw err;\n      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));\n    }\n  }\n  throw new Error("Exhausted retries");\n}',
  'class ConnectionPool {\n  private connections: Map<string, Connection> = new Map();\n  private maxSize: number;\n\n  constructor(maxSize = 10) {\n    this.maxSize = maxSize;\n  }\n\n  async acquire(key: string): Promise<Connection> {\n    const existing = this.connections.get(key);\n    if (existing && existing.isAlive()) return existing;\n    if (this.connections.size >= this.maxSize) {\n      await this.evictOldest();\n    }\n    const conn = await Connection.create(key);\n    this.connections.set(key, conn);\n    return conn;\n  }\n\n  private async evictOldest(): Promise<void> {\n    let oldest: string | null = null;\n    let oldestTime = Infinity;\n    for (const [key, conn] of this.connections) {\n      if (conn.lastUsed < oldestTime) {\n        oldest = key;\n        oldestTime = conn.lastUsed;\n      }\n    }\n    if (oldest) {\n      const conn = this.connections.get(oldest)!;\n      await conn.close();\n      this.connections.delete(oldest);\n    }\n  }\n}',
  'function processEvents(events: Event[]): ProcessedResult[] {\n  const results: ProcessedResult[] = [];\n  const seen = new Set<string>();\n\n  for (const event of events) {\n    if (seen.has(event.id)) continue;\n    seen.add(event.id);\n\n    switch (event.type) {\n      case "create":\n        results.push({ id: event.id, action: "insert", data: event.payload });\n        break;\n      case "update":\n        results.push({ id: event.id, action: "merge", data: event.payload });\n        break;\n      case "delete":\n        results.push({ id: event.id, action: "remove", data: null });\n        break;\n      default:\n        console.warn(`Unknown event type: ${event.type}`);\n    }\n  }\n\n  return results;\n}',
  '// Middleware chain for request processing\nfunction createMiddleware(config: Config) {\n  const logger = createLogger(config.debug);\n  const limiter = new RateLimiter(config.retries);\n\n  return async (req: Request, res: Response, next: NextFn) => {\n    const startTime = performance.now();\n    logger.info(`${req.method} ${req.path}`);\n\n    try {\n      await limiter.check(req.ip);\n      await next();\n    } catch (err) {\n      if (err instanceof RateLimitError) {\n        res.status(429).json({ error: "Too many requests" });\n      } else {\n        res.status(500).json({ error: "Internal server error" });\n      }\n    } finally {\n      const duration = performance.now() - startTime;\n      logger.info(`Completed in ${duration.toFixed(1)}ms`);\n    }\n  };\n}',
];

/**
 * Generate a raw markdown string containing a prose intro and a fenced
 * TypeScript code block of approximately `lineCount` lines.
 * Returns raw markdown suitable for markdownToElements().
 */
export function generateCodeResponse(lineCount: number): string {
  const intro = `Here's the implementation. I've added proper error handling, connection pooling, and retry logic as discussed.\n\nThe key changes are in the middleware chain and the event processor:\n`;

  const codeLines: string[] = [];
  let fragIdx = 0;
  while (codeLines.length < lineCount) {
    const fragment = CODE_FRAGMENTS[fragIdx % CODE_FRAGMENTS.length]!;
    const lines = fragment.split('\n');
    if (codeLines.length > 0) codeLines.push('');
    codeLines.push(...lines);
    fragIdx++;
  }
  // Trim to requested size
  codeLines.length = Math.min(codeLines.length, lineCount);

  return `${intro}\n\`\`\`typescript\n${codeLines.join('\n')}\n\`\`\`\n\nThis should resolve the timeout issues you were seeing in production.`;
}

export const TOOL_CALL_MESSAGES = [
  'Running: `npm test -- --coverage`',
  'Running: `tsc --noEmit`',
  'Running: `eslint src/ --fix`',
  'Running: `git diff HEAD~1 --stat`',
  'Running: `node scripts/migrate.js`',
  'Running: `docker compose up -d`',
  'Running: `curl -s localhost:3000/health`',
  'Running: `psql -c "SELECT count(*) FROM sessions"`',
  'Running: `npm run build`',
  'Running: `kubectl rollout status deploy/api`',
];

export const TOOL_RESULT_TEMPLATE = `PASS src/core/reconciler.test.ts
  ✓ creates root node (3ms)
  ✓ appends child correctly (1ms)
  ✓ removes child without orphan (2ms)
  ✓ handles text content update (1ms)
PASS src/core/paint.test.ts
  ✓ paints empty tree (1ms)
  ✓ paints text node with style (4ms)
  ✓ blits unchanged subtree (2ms)
  ✓ handles wide characters (3ms)
  ✓ continuation cells are correct (1ms)
PASS src/core/emit.test.ts
  ✓ diffs identical buffers (0ms)
  ✓ diffs single cell change (1ms)
  ✓ serializes full viewport (2ms)
  ✓ handles style transitions (1ms)
PASS src/core/layout.test.ts
  ✓ wraps text at boundary (1ms)
  ✓ wraps segments preserving style (2ms)
  ✓ truncates with ellipsis (1ms)
  ✓ handles zero-width chars (1ms)
PASS src/core/cell-buffer.test.ts
  ✓ creates buffer with correct dimensions (0ms)
  ✓ writes and reads cells (1ms)
  ✓ blit region copies correctly (2ms)
  ✓ viewport slice is zero-copy (0ms)
  ✓ expand damage for shrink (1ms)
  ✓ resize buffer reuses backing (1ms)

Test Suites: 5 passed, 5 total
Tests:       23 passed, 23 total
Snapshots:   0 total
Time:        1.847s
Ran all test suites.
------------|---------|----------|---------|---------|
File        | % Stmts | % Branch | % Funcs | % Lines |
------------|---------|----------|---------|---------|
All files   |   89.12 |    78.45 |   91.30 |   88.76 |
 cell.ts    |   100.0 |    100.0 |   100.0 |   100.0 |
 emit.ts    |    92.3 |     84.6 |    90.0 |    91.8 |
 layout.ts  |    87.5 |     73.3 |    88.9 |    87.1 |
 nodes.ts   |    95.0 |     90.0 |   100.0 |    94.7 |
 paint.ts   |    84.2 |     71.4 |    85.7 |    83.6 |
 reconciler |    85.7 |     66.7 |    90.9 |    85.0 |
------------|---------|----------|---------|---------|`;

/**
 * Generate tool result output of approximately `lineCount` lines by
 * repeating/trimming the template.
 */
export function generateToolResult(lineCount: number): string {
  const templateLines = TOOL_RESULT_TEMPLATE.split('\n');
  const result: string[] = [];
  while (result.length < lineCount) {
    result.push(...templateLines);
  }
  result.length = Math.min(result.length, lineCount);
  return result.join('\n');
}
