import React, { useState, useEffect, useRef } from 'react';
import { render, useInput, useApp, useFocus, useDimensions, Box, Text, Divider, measureElement, markdownToElements, highlightCode } from '../src/index.js';
import type { TNode } from '../src/tui/nodes.js';

const SECTIONS = 7;
const ACCENT = '#31f1e8';

function App() {
  const { exit } = useApp();
  const [section, setSection] = useState(0);

  useInput((key) => {
    if (key.type === 'ctrl' && key.ctrlKey === 'c') exit();
    if (key.type === 'char' && key.char === 'n') setSection(s => Math.min(s + 1, SECTIONS - 1));
    if (key.type === 'char' && key.char === 'p') setSection(s => Math.max(s - 1, 0));
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <Box borderStyle="round" borderColor="#555" paddingLeft={1} paddingRight={1} width={18}>
          <Text bold color={ACCENT}>CellState Demo</Text>
        </Box>
      </Box>

      <Text segments={[
        { text: 'Press ', style: { dim: true } },
        { text: 'n', style: { bold: true, color: ACCENT } },
        { text: '/', style: { dim: true } },
        { text: 'p', style: { bold: true, color: ACCENT } },
        { text: ' to navigate, ', style: { dim: true } },
        { text: 'Ctrl+C', style: { bold: true, color: ACCENT } },
        { text: ' to exit', style: { dim: true } },
      ]} />

      <Divider color="#333" />

      {section === 0 && <MarkdownDemo />}
      {section === 1 && <LayoutDemo />}
      {section === 2 && <RichTextDemo />}
      {section === 3 && <TruncateDemo />}
      {section === 4 && <DisplayToggleDemo />}
      {section === 5 && <MeasureDemo />}
      {section === 6 && <FocusDemo />}

      <Text segments={[
        { text: `${section + 1}/${SECTIONS}`, style: { dim: true } },
      ]} />
    </Box>
  );
}

// --- 1. Markdown rendering with syntax highlighting ---
function MarkdownDemo() {
  const md = `## Markdown Rendering

CellState parses markdown into styled \`<Box>\` and \`<Text>\` trees. Inline styles like **bold**, *italic*, and \`code\` are rendered as segments.

Fenced code blocks get syntax highlighting via Shiki:

\`\`\`typescript
interface Config {
  theme: 'nord' | 'dark';
  columns?: number;
}

function render(element: React.ReactElement, config?: Config) {
  const loop = createFrameLoop(process.stdout);
  loop.start(element);
  return { unmount: () => loop.stop() };
}
\`\`\`

Lists work too:
- Unordered items with **mixed** styles
- Nested \`inline code\` and *emphasis*

> Blockquotes are indented with a colored bar.`;

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">1. Markdown & Syntax Highlighting</Text>
      <Box paddingLeft={2} flexDirection="column">
        {markdownToElements(md)}
      </Box>
    </Box>
  );
}

// --- 2. Flexbox layout ---
function LayoutDemo() {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">2. Layout System</Text>

      <Text dim>Row split with fixed + flex:</Text>
      <Box flexDirection="row" gap={1}>
        <Box width={20} borderStyle="single" borderColor="#888" paddingLeft={1} paddingRight={1}>
          <Text bold color="#888">Sidebar</Text>
          <Text dim>width=20</Text>
        </Box>
        <Box flexGrow={1} borderStyle="single" borderColor="#888" paddingLeft={1} paddingRight={1}>
          <Text bold color="#888">Main</Text>
          <Text dim>flexGrow=1</Text>
        </Box>
      </Box>

      <Text dim>Nested boxes with padding and borders:</Text>
      <Box borderStyle="round" borderColor="#cccccc" padding={1}>
        <Box flexDirection="row" gap={2}>
          <Box flexGrow={1} borderStyle="single" borderColor="#a3be8c" paddingLeft={1} paddingRight={1}>
            <Text color="#a3be8c">Panel A</Text>
          </Box>
          <Box flexGrow={1} borderStyle="single" borderColor="#ebcb8b" paddingLeft={1} paddingRight={1}>
            <Text color="#ebcb8b">Panel B</Text>
          </Box>
          <Box flexGrow={1} borderStyle="single" borderColor="#bf616a" paddingLeft={1} paddingRight={1}>
            <Text color="#bf616a">Panel C</Text>
          </Box>
        </Box>
      </Box>

      <Text dim>Border styles:</Text>
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} borderStyle="single" borderColor="#888" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <Text>single</Text>
        </Box>
        <Box flexGrow={1} borderStyle="double" borderColor="#888" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <Text>double</Text>
        </Box>
        <Box flexGrow={1} borderStyle="round" borderColor="#888" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <Text>round</Text>
        </Box>
        <Box flexGrow={1} borderStyle="bold" borderColor="#888" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <Text>bold</Text>
        </Box>
      </Box>
    </Box>
  );
}

// --- 3. Rich text segments ---
function RichTextDemo() {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">3. Rich Text & Segments</Text>

      <Text dim>Mixed styles in a single element:</Text>
      <Text segments={[
        { text: 'Error', style: { bold: true, color: '#ff4444' } },
        { text: ': ', style: { color: '#888' } },
        { text: 'Cannot find module ', style: { color: '#cccccc' } },
        { text: "'./missing'", style: { color: '#a3be8c', italic: true } },
      ]} />

      <Text dim>Status indicators:</Text>
      <Text segments={[
        { text: '  ', style: { color: '#a3be8c' } },
        { text: '● ', style: { color: '#a3be8c' } },
        { text: '12 passed  ', style: { color: '#a3be8c' } },
        { text: '● ', style: { color: '#bf616a' } },
        { text: '2 failed  ', style: { color: '#bf616a' } },
        { text: '● ', style: { color: '#ebcb8b' } },
        { text: '3 pending', style: { color: '#ebcb8b' } },
      ]} />

      <Text dim>Inverse for highlights:</Text>
      <Text segments={[
        { text: '  Normal text ' },
        { text: ' ALERT ', style: { inverse: true, bold: true, color: '#ff4444' } },
        { text: ' back to normal ' },
        { text: ' OK ', style: { inverse: true, bold: true, color: '#a3be8c' } },
      ]} />

      <Text dim>All text attributes:</Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text bold>Bold text</Text>
        <Text italic>Italic text</Text>
        <Text underline>Underlined text</Text>
        <Text strikethrough>Strikethrough text</Text>
        <Text dim>Dim text</Text>
        <Text inverse> Inverse text </Text>
      </Box>
    </Box>
  );
}

// --- 4. Text truncation ---
function TruncateDemo() {
  const longPath = '/Users/dev/projects/cellstate/src/renderer/tui/components/very-nested/deeply/path.tsx';

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">4. Text Truncation</Text>

      <Text dim>wrap (default):</Text>
      <Box paddingLeft={2} width={50}>
        <Text>{longPath}</Text>
      </Box>

      <Text dim>truncate-end:</Text>
      <Box paddingLeft={2} width={50}>
        <Text wrap="truncate-end">{longPath}</Text>
      </Box>

      <Text dim>truncate-start (useful for file paths):</Text>
      <Box paddingLeft={2} width={50}>
        <Text wrap="truncate-start">{longPath}</Text>
      </Box>

      <Text dim>truncate-middle:</Text>
      <Box paddingLeft={2} width={50}>
        <Text wrap="truncate-middle">{longPath}</Text>
      </Box>
    </Box>
  );
}

// --- 5. display="none" with state preservation ---
function DisplayToggleDemo() {
  const [visible, setVisible] = useState(false);
  const [counter, setCounter] = useState(0);

  useInput((key) => {
    if (key.type === 'char' && key.char === 't') setVisible(v => !v);
    if (key.type === 'char' && key.char === '+') setCounter(c => c + 1);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">5. Conditional Display</Text>
      <Text segments={[
        { text: 'Press ', style: { dim: true } },
        { text: 't', style: { bold: true, color: ACCENT } },
        { text: ' to toggle, ', style: { dim: true } },
        { text: '+', style: { bold: true, color: ACCENT } },
        { text: ' to increment counter', style: { dim: true } },
      ]} />

      <Text>Content above</Text>
      <Box display={visible ? 'flex' : 'none'} borderStyle="single" borderColor="#a3be8c" paddingLeft={1} paddingRight={1}>
        <Text segments={[
          { text: 'Counter: ', style: { color: '#a3be8c' } },
          { text: `${counter}`, style: { bold: true, color: '#a3be8c' } },
          { text: '  (state preserved while hidden)', style: { dim: true } },
        ]} />
      </Box>
      <Text>Content below (shifts up when hidden)</Text>
      <Text segments={[
        { text: `display="${visible ? 'flex' : 'none'}"`, style: { dim: true } },
      ]} />
    </Box>
  );
}

// --- 6. measureElement ---
function MeasureDemo() {
  const boxRef = useRef<TNode>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      if (boxRef.current) {
        setDims(measureElement(boxRef.current));
      }
    }, 100);
    return () => clearTimeout(id);
  }, []);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">6. measureElement</Text>
      <Text dim>Read the rendered dimensions of any element via ref:</Text>
      <Box ref={boxRef} borderStyle="round" borderColor="#5e81ac" padding={1}>
        <Text>This box has a border and padding.</Text>
        <Text>Three lines of content inside.</Text>
        <Text>The ref captures the layout result.</Text>
      </Box>
      {dims && (
        <Text segments={[
          { text: '  Measured: ', style: { dim: true } },
          { text: `${dims.width}`, style: { bold: true, color: ACCENT } },
          { text: ' cols x ', style: { dim: true } },
          { text: `${dims.height}`, style: { bold: true, color: ACCENT } },
          { text: ' rows', style: { dim: true } },
        ]} />
      )}
    </Box>
  );
}

// --- 7. Focus system ---
function FocusDemo() {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="#ffaa00">7. Focus System</Text>
      <Text dim>Tab / Shift+Tab to cycle focus:</Text>
      <Box flexDirection="column" gap={0}>
        <FocusItem label="Build project" icon="+" color="#a3be8c" />
        <FocusItem label="Run tests" icon=">" color="#ebcb8b" />
        <FocusItem label="Deploy" icon="^" color="#bf616a" />
      </Box>
    </Box>
  );
}

function FocusItem({ label, icon, color }: { label: string; icon: string; color: string }) {
  const { isFocused } = useFocus();

  return (
    <Text segments={[
      { text: isFocused ? `${icon} ` : '  ', style: { color: isFocused ? color : '#444' } },
      { text: `[${label}]`, style: { bold: isFocused, color: isFocused ? color : '#555', inverse: isFocused } },
    ]} />
  );
}

const app = render(<App />);
await app.waitUntilExit();
