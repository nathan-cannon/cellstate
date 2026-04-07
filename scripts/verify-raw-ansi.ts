/**
 * Standalone verification script for the RawAnsi pipeline and ANSI wrap carry.
 *
 * Run: npx tsx scripts/verify-raw-ansi.ts
 */
import React from 'react';
import { mountRoot, setFlexNodeFactory } from '../src/core/reconciler.js';
import { createFlexNodeFactory } from '../src/layout/yoga-flex.js';
import { paintTree } from '../src/core/paint.js';
import { createCellBuffer } from '../src/core/cell-buffer.js';
import { CharTable } from '../src/core/char-table.js';
import { StyleTable } from '../src/core/style-table.js';
import { LinkTable } from '../src/core/link-table.js';
import { createPerf } from '../src/core/perf.js';
import { Box, Markdown } from '../src/components/elements.js';
import { Markdown as MarkdownComponent } from '../src/components/markdown.js';
import { wrapAnsiText, generateAnsiLines } from '../src/markdown/ansi-generator.js';
import { initTreeSitter } from '../src/markdown/tree-sitter-init.js';
import type { TNode } from '../src/core/nodes.js';
import type { MarkdownBlock } from '../src/markdown/ansi-generator.js';

// ── Helpers ──

let passes = 0;
let fails = 0;

function check(label: string, value: number | string, condition: boolean, detail?: string): void {
  const icon = condition ? '\x1b[32m\u2713 PASS\x1b[0m' : '\x1b[31m\u2717 FAIL\x1b[0m';
  const valStr = typeof value === 'number' ? String(value).padStart(8) : value;
  console.log(`  ${label.padEnd(25)} ${valStr}   ${icon}${detail ? `  (${detail})` : ''}`);
  if (condition) passes++;
  else fails++;
}

function escapeAnsi(s: string): string {
  return s.replace(/\x1b/g, '\\x1b');
}

// ── Test 1: paintRawAnsi pipeline ──

async function test1(): Promise<void> {
  console.log('\n\x1b[1m\u2550\u2550\u2550 Test 1: paintRawAnsi pipeline \u2550\u2550\u2550\x1b[0m');

  const COLS = 80;

  const mdContent = `# Hello World

This is a **bold** paragraph with some \`inline code\`.

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

- Item one
- Item two
- Item three
`;

  const perf = createPerf(true);
  const charTable = new CharTable();
  const styleTable = new StyleTable();
  const linkTable = new LinkTable();

  // Render through reconciler
  const root = await new Promise<TNode>((resolve) => {
    setFlexNodeFactory(createFlexNodeFactory());

    const element = React.createElement(
      Box as any,
      { width: COLS },
      React.createElement(MarkdownComponent, { children: mdContent, width: COLS }),
    );

    mountRoot(element, (r: TNode) => {
      resolve(r);
    });
  });

  // Give React a tick to commit
  await new Promise<void>((r) => setTimeout(r, 50));

  // Re-capture root after commit settles (mountRoot fires onFrame synchronously
  // for the first commit, but the React concurrent scheduler may need a tick)
  const root2 = await new Promise<TNode>((resolve) => {
    setFlexNodeFactory(createFlexNodeFactory());
    mountRoot(
      React.createElement(
        Box as any,
        { width: COLS },
        React.createElement(MarkdownComponent, { children: mdContent, width: COLS }),
      ),
      (r: TNode) => resolve(r),
    );
  });
  await new Promise<void>((r) => setTimeout(r, 50));

  // Run layout
  root2.flexNode!.setWidth(COLS);
  root2.flexNode!.calculateLayout(COLS);

  const height = root2.flexNode!.getComputedHeight();
  if (height <= 0) {
    console.log('  \x1b[31mFAIL: Computed height is 0 — tree may be empty.\x1b[0m');
    console.log('  Inspecting tree...');
    printTree(root2, 2);
    fails++;
    return;
  }

  const buf = createCellBuffer(COLS, height);
  paintTree(root2, buf, null, charTable, styleTable, linkTable, 0, perf);

  const snap = perf.snapshot();
  if (!snap) {
    console.log('  \x1b[31mFAIL: Perf snapshot is null\x1b[0m');
    fails++;
    return;
  }

  const c = snap.counts;
  const t = snap.timings;

  check('walkNodeRawAnsi', c.walkNodeRawAnsi, c.walkNodeRawAnsi > 0);
  check('paintRawAnsiCalls', c.paintRawAnsiCalls, c.paintRawAnsiCalls > 0);
  check('rawAnsiCellsWritten', c.rawAnsiCellsWritten, c.rawAnsiCellsWritten > 0);
  check('walkNodeText', c.walkNodeText, c.walkNodeText === 0, 'no fallback to text path');
  console.log(`  ${'paintRawAnsi time'.padEnd(25)} ${t.paintRawAnsi.toFixed(2)}ms`);

  if (c.walkNodeRawAnsi === 0) {
    console.log('\n  \x1b[31mFAIL: Markdown component is NOT using the raw-ansi path.');
    console.log('  Check that <Markdown> renders <raw-ansi> elements, not <text> elements.\x1b[0m');
    console.log('\n  Tree structure:');
    printTree(root2, 2);
  }
}

function printTree(node: TNode, indent: number): void {
  const pad = ' '.repeat(indent);
  const extra: string[] = [];
  if (node.text !== null) extra.push(`text=${JSON.stringify(node.text.slice(0, 40))}`);
  if (node.props.lines) extra.push(`lines=[${node.props.lines.length} items]`);
  if (node.props.rawWidth) extra.push(`rawWidth=${node.props.rawWidth}`);
  if (node.props.segments) extra.push(`segments=[${node.props.segments.length}]`);
  const w = node.flexNode ? ` ${node.flexNode.getComputedWidth()}x${node.flexNode.getComputedHeight()}` : '';
  console.log(`${pad}<${node.type}${w}>${extra.length ? ' ' + extra.join(', ') : ''}`);
  for (const child of node.children) {
    printTree(child, indent + 2);
  }
}

// ── Test 2: ANSI wrap carry ──

function test2(): void {
  console.log('\n\x1b[1m\u2550\u2550\u2550 Test 2: ANSI wrap carry \u2550\u2550\u2550\x1b[0m');

  const input = '\x1b[1;31mThis is bold red text that should wrap across multiple lines and stay styled\x1b[0m';
  const lines = wrapAnsiText(input, 20);

  console.log('  Input (escaped): ' + escapeAnsi(input));
  console.log(`  Width: 20, Lines: ${lines.length}`);
  console.log();

  let allContinuationsHaveSgr = true;

  for (let i = 0; i < lines.length; i++) {
    const raw = escapeAnsi(lines[i]!);
    console.log(`  Line ${i}: "${raw}"`);

    if (i > 0) {
      // Check that the continuation line starts with an SGR sequence
      const startsWithSgr = lines[i]!.startsWith('\x1b[');
      if (!startsWithSgr) {
        allContinuationsHaveSgr = false;
      }
    }
  }

  console.log();
  check('Continuation lines have SGR', allContinuationsHaveSgr ? 'yes' : 'no', allContinuationsHaveSgr);

  if (!allContinuationsHaveSgr) {
    console.log('\n  \x1b[31mFAIL: Continuation lines are missing SGR state.');
    console.log('  wrapAnsiText needs to track active styles and re-emit them');
    console.log('  at the start of each wrapped line.\x1b[0m');
  }

  // Show rendered output so the user can see bold red carries
  console.log('\n  Rendered (terminal interprets colors):');
  for (let i = 0; i < lines.length; i++) {
    console.log(`    ${lines[i]}`);
  }
  console.log('\x1b[0m'); // ensure reset
}

// ── Test 3: Visual code block wrap ──

function test3(): void {
  console.log('\n\x1b[1m\u2550\u2550\u2550 Test 3: Visual code block wrap \u2550\u2550\u2550\x1b[0m');

  const code = `function reallyLongFunctionName(parameterOne: string, parameterTwo: number): boolean {
  const result = parameterOne.length > parameterTwo;
  return result;
}`;

  const block: MarkdownBlock = {
    type: 'code',
    raw: '```typescript\n' + code + '\n```',
    rawLength: 0,
    lang: 'typescript',
    code,
  };

  const WIDTH = 30;
  const ansiLines = generateAnsiLines([block], WIDTH);

  console.log(`  Code block at width ${WIDTH}:`);
  console.log();

  console.log('  Raw (escaped):');
  for (let i = 0; i < ansiLines.length; i++) {
    console.log(`    ${String(i).padStart(2)}: ${escapeAnsi(ansiLines[i]!)}`);
  }

  console.log();
  console.log('  Rendered (terminal shows colors):');
  for (let i = 0; i < ansiLines.length; i++) {
    console.log(`    ${String(i).padStart(2)}: ${ansiLines[i]}`);
  }
  console.log('\x1b[0m'); // ensure reset

  // Check that wrapped code lines carry style
  let codeHasEscapes = false;
  for (const line of ansiLines) {
    if (line.includes('\x1b[')) {
      codeHasEscapes = true;
      break;
    }
  }
  check('Code has syntax highlighting', codeHasEscapes ? 'yes' : 'no', codeHasEscapes);
  if (!codeHasEscapes) {
    console.log('\n  \x1b[31mFAIL: Code block has no ANSI escapes — syntax highlighting is not working.');
    console.log('  Check that initTreeSitter() was called and the language pack is installed.\x1b[0m');
  }
}

// ── Main ──

async function main(): Promise<void> {
  console.log('\x1b[1m=== RawAnsi Pipeline & Wrap Carry Verification ===\x1b[0m');

  // Initialize tree-sitter language pack for syntax highlighting
  await initTreeSitter();

  await test1();
  test2();
  test3();

  console.log('\n\x1b[1m=== Summary ===\x1b[0m');
  console.log(`  \x1b[32m${passes} passed\x1b[0m, \x1b[${fails > 0 ? '31' : '32'}m${fails} failed\x1b[0m`);

  if (fails > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
