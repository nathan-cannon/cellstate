import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectCapabilities } from '../../src/core/capabilities.js';

// Save and restore process.env around each test to avoid cross-contamination.
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear all capability-relevant variables for a clean slate
  delete process.env.TMUX;
  delete process.env.STY;
  delete process.env.ZELLIJ;
  delete process.env.MOSH_CONNECTION;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.COLORTERM;
  delete process.env.TERM;
  delete process.env.TERM_PROGRAM;
  delete process.env.TERM_PROGRAM_VERSION;
  delete process.env.WT_SESSION;
  delete process.env.ZED_TERM;
  delete process.env.KITTY_WINDOW_ID;
  delete process.env.VTE_VERSION;
});

afterEach(() => {
  process.env = savedEnv;
});

describe('detectCapabilities', () => {
  // ── Defaults ───────────────────────────────────────────────────────────

  it('clean environment: synchronizedOutput defaults to false without allowlisted terminal', () => {
    const caps = detectCapabilities();
    expect(caps.synchronizedOutput).toBe(false);
    expect(caps.truecolor).toBe(true);
    expect(caps.multiplexer).toBeNull();
    expect(caps.remoteSession).toBe(false);
    expect(caps.terminalName).toBe('unknown');
  });

  // ── Multiplexer detection ──────────────────────────────────────────────

  it('TMUX set: synchronizedOutput false, multiplexer tmux', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    const caps = detectCapabilities();
    expect(caps.synchronizedOutput).toBe(false);
    expect(caps.multiplexer).toBe('tmux');
  });

  it('STY set: multiplexer screen, synchronizedOutput false', () => {
    process.env.STY = '12345.pts-0.hostname';
    const caps = detectCapabilities();
    expect(caps.multiplexer).toBe('screen');
    expect(caps.synchronizedOutput).toBe(false);
  });

  it('ZELLIJ set: multiplexer zellij, synchronizedOutput false', () => {
    process.env.ZELLIJ = '0';
    const caps = detectCapabilities();
    expect(caps.multiplexer).toBe('zellij');
    // Zellij is not on the synchronizedOutput allowlist
    expect(caps.synchronizedOutput).toBe(false);
  });

  // ── Remote session ─────────────────────────────────────────────────────

  it('MOSH_CONNECTION set: remoteSession true, synchronizedOutput false', () => {
    process.env.MOSH_CONNECTION = '192.168.1.1 60001';
    const caps = detectCapabilities();
    expect(caps.remoteSession).toBe(true);
    expect(caps.synchronizedOutput).toBe(false);
  });

  it('SSH_CONNECTION set: remoteSession true, synchronizedOutput false without allowlisted terminal', () => {
    process.env.SSH_CONNECTION = '192.168.1.1 12345 192.168.1.2 22';
    const caps = detectCapabilities();
    expect(caps.remoteSession).toBe(true);
    // No allowlisted TERM_PROGRAM set, so synchronizedOutput is false
    expect(caps.synchronizedOutput).toBe(false);
  });

  it('SSH_CLIENT set: remoteSession true', () => {
    process.env.SSH_CLIENT = '192.168.1.1 12345 22';
    const caps = detectCapabilities();
    expect(caps.remoteSession).toBe(true);
  });

  // ── Truecolor detection ────────────────────────────────────────────────

  it('COLORTERM=truecolor: truecolor true', () => {
    process.env.COLORTERM = 'truecolor';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('COLORTERM=24bit: truecolor true', () => {
    process.env.COLORTERM = '24bit';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM=linux: truecolor false', () => {
    process.env.TERM = 'linux';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(false);
  });

  it('TERM_PROGRAM=iTerm.app with no COLORTERM: truecolor true', () => {
    process.env.TERM_PROGRAM = 'iTerm.app';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=vscode: truecolor true', () => {
    process.env.TERM_PROGRAM = 'vscode';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=kitty: truecolor true', () => {
    process.env.TERM_PROGRAM = 'kitty';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=Ghostty: truecolor true', () => {
    process.env.TERM_PROGRAM = 'Ghostty';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=Alacritty: truecolor true', () => {
    process.env.TERM_PROGRAM = 'Alacritty';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=WezTerm: truecolor true', () => {
    process.env.TERM_PROGRAM = 'WezTerm';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  it('TERM_PROGRAM=Hyper: truecolor true', () => {
    process.env.TERM_PROGRAM = 'Hyper';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(true);
  });

  // ── Terminal name ──────────────────────────────────────────────────────

  it('TERM_PROGRAM=WezTerm, TERM_PROGRAM_VERSION=20240203: terminalName includes both', () => {
    process.env.TERM_PROGRAM = 'WezTerm';
    process.env.TERM_PROGRAM_VERSION = '20240203';
    const caps = detectCapabilities();
    expect(caps.terminalName).toBe('WezTerm 20240203');
  });

  it('TERM_PROGRAM only: terminalName is TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'kitty';
    const caps = detectCapabilities();
    expect(caps.terminalName).toBe('kitty');
  });

  it('TERM only (no TERM_PROGRAM): terminalName falls back to TERM', () => {
    process.env.TERM = 'xterm-256color';
    const caps = detectCapabilities();
    expect(caps.terminalName).toBe('xterm-256color');
  });

  // ── Precedence / combination ───────────────────────────────────────────

  it('TMUX + TERM_PROGRAM=iTerm.app: multiplexer tmux, synchronizedOutput false', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TERM_PROGRAM = 'iTerm.app';
    const caps = detectCapabilities();
    expect(caps.multiplexer).toBe('tmux');
    expect(caps.synchronizedOutput).toBe(false);
    // truecolor is still true (iTerm is known)
    expect(caps.truecolor).toBe(true);
    // terminalName uses TERM_PROGRAM
    expect(caps.terminalName).toBe('iTerm.app');
  });

  it('TERM=linux overrides default truecolor even with unknown TERM_PROGRAM', () => {
    process.env.TERM = 'linux';
    const caps = detectCapabilities();
    expect(caps.truecolor).toBe(false);
  });

  it('COLORTERM=truecolor overrides TERM=linux', () => {
    process.env.TERM = 'linux';
    process.env.COLORTERM = 'truecolor';
    const caps = detectCapabilities();
    // COLORTERM check comes first and sets true
    expect(caps.truecolor).toBe(true);
  });
});
