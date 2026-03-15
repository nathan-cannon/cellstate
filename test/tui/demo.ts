/**
 * Standalone demo app for the custom TUI renderer frame loop.
 * Currently renders a markdown string through the full pipeline for visual verification.
 *
 * Run: bun src/renderer/tui/demo.ts
 * Debug: DEBUG=1 bun src/renderer/tui/demo.ts
 */
import { createFrameLoop } from '../../src/tui/frame-loop.js';
import React from 'react';
import { markdownToElements } from '../../src/tui/markdown.js';

const demoMarkdown = `## Analysis

The issue is in \`processEvent()\` where the callback **never fires** after the timeout.

\`\`\`typescript
function processEvent(event: Event) {
  setTimeout(() => {
    callback(event); // this line is unreachable
  }, 0);
}
\`\`\`

To fix this:

1. Remove the \`setTimeout\` wrapper
2. Call \`callback(event)\` directly
3. Verify with the existing test suite

> Note: this also affects \`handleBatch()\` which uses the same pattern.

- Unordered item one this is test content and im seeing if this wraps correctly
- Unordered item two
  - Nested item
- Unordered item three
`;

function App() {
  return markdownToElements(demoMarkdown) as React.ReactElement;
}

process.stderr.write(`Viewport: ${process.stdout.rows} rows x ${process.stdout.columns} cols\n`);

const loop = createFrameLoop(process.stdout);
loop.start(React.createElement(App));

setTimeout(() => {
  loop.stop();
  process.exit(0);
}, 500);

process.on('SIGINT', () => {
  loop.stop();
  process.exit(0);
});
