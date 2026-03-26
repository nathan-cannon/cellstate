/**
 * Runtime terminal capability detection. Pure function — reads environment
 * variables and returns a struct. No side effects, no global state.
 */

export interface TerminalCapabilities {
  /** Terminal supports DEC private mode 2026 synchronized output */
  synchronizedOutput: boolean;
  /** Terminal supports 24-bit RGB color */
  truecolor: boolean;
  /** Detected terminal name for debugging */
  terminalName: string;
  /** Running inside a multiplexer */
  multiplexer: 'tmux' | 'screen' | 'zellij' | null;
  /** Running over SSH or Mosh */
  remoteSession: boolean;
}

/** Terminals known to support 24-bit RGB color. */
const TRUECOLOR_TERMINALS = new Set([
  'iTerm.app',
  'iTerm2',
  'kitty',
  'Ghostty',
  'Alacritty',
  'WezTerm',
  'Hyper',
  'vscode',
]);

export function detectCapabilities(): TerminalCapabilities {
  const env = process.env;

  // ── Multiplexer detection ──────────────────────────────────────────────
  // Check STY (not TERM) — tmux sometimes sets TERM=screen-*
  let multiplexer: TerminalCapabilities['multiplexer'] = null;
  if (env.TMUX) {
    multiplexer = 'tmux';
  } else if (env.STY) {
    multiplexer = 'screen';
  } else if (env.ZELLIJ) {
    multiplexer = 'zellij';
  }

  // ── Remote session ─────────────────────────────────────────────────────
  const remoteSession = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);

  // ── Synchronized output ────────────────────────────────────────────────
  // Disabled in multiplexers that don't pass DEC 2026 through, and in Mosh
  // which has its own screen model. Default true: terminals that don't
  // recognize mode 2026 silently ignore the sequences per the VT spec.
  let synchronizedOutput = true;
  if (multiplexer === 'tmux' || multiplexer === 'screen') {
    synchronizedOutput = false;
  }
  if (env.MOSH_CONNECTION) {
    synchronizedOutput = false;
  }

  // ── Truecolor ──────────────────────────────────────────────────────────
  // Default true: nearly every modern terminal supports RGB. Sending RGB to
  // a 256-color terminal produces degraded but functional output, which is
  // better than sending 256-color to terminals that handle RGB fine.
  let truecolor = true;
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    truecolor = true;
  } else if (env.TERM === 'linux') {
    // Linux framebuffer console — 8/16 colors only
    truecolor = false;
  } else if (env.TERM_PROGRAM && TRUECOLOR_TERMINALS.has(env.TERM_PROGRAM)) {
    truecolor = true;
  }

  // ── Terminal name ──────────────────────────────────────────────────────
  let terminalName = 'unknown';
  if (env.TERM_PROGRAM) {
    terminalName = env.TERM_PROGRAM;
    if (env.TERM_PROGRAM_VERSION) {
      terminalName += ' ' + env.TERM_PROGRAM_VERSION;
    }
  } else if (env.TERM) {
    terminalName = env.TERM;
  }

  return {
    synchronizedOutput,
    truecolor,
    terminalName,
    multiplexer,
    remoteSession,
  };
}
