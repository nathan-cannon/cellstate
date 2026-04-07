/**
 * Runtime terminal capability detection. Pure function — reads environment
 * variables and returns a struct. No side effects, no global state.
 */
import supportsHyperlinks from 'supports-hyperlinks';

export interface TerminalCapabilities {
  /** Terminal supports DEC private mode 2026 synchronized output */
  synchronizedOutput: boolean;
  /** Terminal supports 24-bit RGB color */
  truecolor: boolean;
  /** Terminal supports OSC 8 hyperlinks */
  hyperlinks: boolean;
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
  // Allowlist approach: only enable for terminals verified to support DEC
  // private mode 2026. Some terminals don't silently ignore BSU/ESU
  // despite the VT spec saying they should, so default-true is unsafe.
  let synchronizedOutput = false;

  // Early exclusions — multiplexers/transports that break atomicity
  if (env.TMUX || env.MOSH_CONNECTION || env.STY) {
    // skip all further checks
  }
  // TERM_PROGRAM allowlist
  else if (env.TERM_PROGRAM === 'iTerm.app'
    || env.TERM_PROGRAM === 'WezTerm'
    || env.TERM_PROGRAM === 'WarpTerminal'
    || env.TERM_PROGRAM === 'ghostty'
    || env.TERM_PROGRAM === 'contour'
    || env.TERM_PROGRAM === 'vscode'
    || env.TERM_PROGRAM === 'alacritty') {
    synchronizedOutput = true;
  }
  // TERM string checks (terminals that don't always set TERM_PROGRAM)
  else if (env.TERM?.includes('kitty') || env.KITTY_WINDOW_ID) {
    synchronizedOutput = true;
  } else if (env.TERM === 'xterm-ghostty') {
    synchronizedOutput = true;
  } else if (env.TERM?.startsWith('foot')) {
    synchronizedOutput = true;
  } else if (env.TERM?.includes('alacritty')) {
    synchronizedOutput = true;
  }
  // Env var checks for specific hosts
  else if (env.ZED_TERM || env.WT_SESSION) {
    synchronizedOutput = true;
  }
  // VTE version check (GNOME Terminal, Tilix, other GTK terminals)
  else if (env.VTE_VERSION) {
    const vte = parseInt(env.VTE_VERSION, 10);
    if (vte >= 6800) { // VTE 0.68+
      synchronizedOutput = true;
    }
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

  // ── Hyperlinks (OSC 8) ─────────────────────────────────────────────────
  // Layered detection: supports-hyperlinks library first, then additional
  // terminals the library doesn't cover.
  const HYPERLINK_TERMINALS = new Set([
    'ghostty', 'Hyper', 'kitty', 'alacritty', 'iTerm.app', 'iTerm2',
  ]);
  let hyperlinks = supportsHyperlinks.stdout;
  if (!hyperlinks) {
    if (env.TERM_PROGRAM && HYPERLINK_TERMINALS.has(env.TERM_PROGRAM)) {
      hyperlinks = true;
    } else if (env.LC_TERMINAL && HYPERLINK_TERMINALS.has(env.LC_TERMINAL)) {
      hyperlinks = true;
    } else if (env.TERM?.includes('kitty')) {
      hyperlinks = true;
    }
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
    hyperlinks,
    terminalName,
    multiplexer,
    remoteSession,
  };
}
