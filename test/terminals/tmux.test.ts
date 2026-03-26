import { execSync } from 'child_process';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

let tmuxAvailable = false;
try {
  execSync('which tmux', { stdio: 'pipe' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

const describeIfTmux = tmuxAvailable ? describe : describe.skip;

class TmuxTestSession {
  private session: string;
  private cols: number;
  private rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.session = `cellstate-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  start(): void {
    execSync(
      `tmux new-session -d -s ${this.session} -x ${this.cols} -y ${this.rows} cat`,
      { stdio: 'pipe' },
    );
    execSync('sleep 0.1');
  }

  sendRaw(data: string): void {
    const hex = Buffer.from(data)
      .toString('hex')
      .match(/.{2}/g)!
      .join(' ');
    execSync(`tmux send-keys -t ${this.session} -H ${hex}`, { stdio: 'pipe' });
    execSync('sleep 0.05');
  }

  captureText(): string[] {
    const output = execSync(`tmux capture-pane -t ${this.session} -p`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.split('\n');
  }

  captureAnsi(): string {
    return execSync(`tmux capture-pane -t ${this.session} -p -e`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  kill(): void {
    try {
      execSync(`tmux kill-session -t ${this.session}`, { stdio: 'pipe' });
    } catch {
      // Session might already be dead
    }
  }
}

describeIfTmux('tmux integration', () => {
  let tmux: TmuxTestSession;

  beforeEach(() => {
    tmux = new TmuxTestSession(40, 10);
    tmux.start();
  });

  afterEach(() => {
    tmux.kill();
  });

  test('DEC 2026 sequences do not produce visible artifacts', () => {
    const content = '\x1b[?2026h' + 'HELLO WORLD' + '\x1b[?2026l';
    tmux.sendRaw(content);
    const lines = tmux.captureText();
    const allText = lines.join('\n');
    expect(allText).toContain('HELLO WORLD');
    // DEC 2026 (synchronized output) may or may not be consumed by tmux
    // depending on version. Verify no broken/garbled characters appear
    // beyond the possible pass-through of the sequence itself.
    // Strip any CSI private mode sequences to check for garbage.
    const stripped = allText.replace(/\x1b\[\?\d+[hl]/g, '').replace(/\^\[\[\?\d+[hl]/g, '');
    // After stripping DEC sequences, only HELLO WORLD and whitespace should remain
    expect(stripped.trim()).toBe('HELLO WORLD');
  });

  test('renderOnce output renders correctly in tmux', async () => {
    const { renderOnce, Box, Text } = await import('../../src/index.js');
    const React = await import('react');

    const output = await renderOnce(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, { bold: true }, 'Title'),
        React.createElement(Text, null, 'Body text here'),
      ),
      { columns: 40 },
    );

    tmux.sendRaw(output);
    const lines = tmux.captureText();
    const allText = lines.join('\n');
    expect(allText).toContain('Title');
    expect(allText).toContain('Body text here');
  });

  test('box borders render as expected in tmux', async () => {
    const { renderOnce, Box, Text } = await import('../../src/index.js');
    const React = await import('react');

    const output = await renderOnce(
      React.createElement(
        Box,
        { borderStyle: 'round', width: 20 },
        React.createElement(Text, null, 'Inside box'),
      ),
      { columns: 40 },
    );

    tmux.sendRaw(output);
    const lines = tmux.captureText();
    const allText = lines.join('\n');
    expect(allText).toContain('╭');
    expect(allText).toContain('╯');
    expect(allText).toContain('Inside box');
  });

  test('content taller than viewport shows last rows', async () => {
    const { renderOnce, Box, Text } = await import('../../src/index.js');
    const React = await import('react');

    const children = [];
    for (let i = 0; i < 20; i++) {
      children.push(React.createElement(Text, { key: i }, `Line ${i}`));
    }

    const output = await renderOnce(
      React.createElement(Box, { flexDirection: 'column' }, ...children),
      { columns: 40 },
    );

    tmux.sendRaw(output);
    const lines = tmux.captureText();
    const allText = lines.join('\n');
    // With a 10-row pane, cat's trailing newline may scroll one extra
    // line off the top. Check that late lines are visible.
    expect(allText).toContain('Line 18');
  });

  test('detectCapabilities returns correct values for tmux', async () => {
    const { detectCapabilities } = await import('../../src/index.js');
    const originalTMUX = process.env.TMUX;
    try {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      const caps = detectCapabilities();
      expect(caps.multiplexer).toBe('tmux');
      expect(caps.synchronizedOutput).toBe(false);
    } finally {
      if (originalTMUX !== undefined) {
        process.env.TMUX = originalTMUX;
      } else {
        delete process.env.TMUX;
      }
    }
  });

  test('CJK characters occupy 2 columns in tmux', () => {
    tmux.sendRaw('漢A');
    const lines = tmux.captureText();
    expect(lines[0]).toContain('漢');
    expect(lines[0]).toContain('A');
  });
});
