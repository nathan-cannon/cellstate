/** Main entry point for terminal applications. */
import React from 'react';
import { createFrameLoop } from './frame-loop.js';
import { AppCtx } from '../hooks/app-context.js';
import { FocusRegistry, FocusCtx } from '../hooks/focus-context.js';
import { onKeypress } from '../hooks/keypress.js';
import { patchConsole } from './patch-console.js';
import { writeFileSync } from 'node:fs';
import type tty from 'node:tty';
import type { TerminalCapabilities } from './capabilities.js';

export interface RenderOptions {
  stdout?: tty.WriteStream;
  stdin?: tty.ReadStream;
  patchConsole?: boolean;
  capabilities?: Partial<TerminalCapabilities>;
}

export interface RenderInstance {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  dumpFrameLog: (path: string) => void;
}

/**
 * ErrorBoundary catches errors from the React component tree during
 * reconciliation. Without this, async render errors would leave the
 * terminal in raw mode with a hidden cursor.
 */
class ErrorBoundary extends React.Component<
  { children?: React.ReactNode; onError: (error: Error) => void },
  { hasError: boolean }
> {
  constructor(props: { children?: React.ReactNode; onError: (error: Error) => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): React.ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/**
 * Mount a React element into the terminal with the full rendering pipeline:
 * frame loop, raw mode, cursor management, and cleanup.
 *
 * Does NOT handle Ctrl+C, SIGINT, or any app-level signal handling.
 * The consumer is responsible for calling unmount() when appropriate.
 */
export function render(
  element: React.ReactElement,
  options?: RenderOptions,
): RenderInstance {
  const stdout = options?.stdout ?? process.stdout;
  const stdin = options?.stdin ?? process.stdin;

  let unmounted = false;
  let exitResolve: ((value?: unknown) => void) | null = null;
  let exitReject: ((error: Error) => void) | null = null;
  const exitPromise = new Promise<unknown>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });

  const loop = createFrameLoop(stdout, options?.capabilities);

  function handleError(error: Error): void {
    // Restore terminal state before printing
    unmount();
    process.stderr.write(error.stack ?? error.message);
    process.stderr.write('\n');
  }

  function exit(errorOrResult?: unknown): void {
    unmount();
    if (errorOrResult instanceof Error) {
      if (exitReject) {
        exitReject(errorOrResult);
        exitReject = null;
        exitResolve = null;
      }
    } else {
      if (exitResolve) {
        exitResolve(errorOrResult);
        exitResolve = null;
        exitReject = null;
      }
    }
  }

  const focusRegistry = new FocusRegistry();

  const wrapped = React.createElement(
    ErrorBoundary,
    { onError: handleError },
    React.createElement(
      AppCtx.Provider,
      { value: { exit } },
      React.createElement(
        FocusCtx.Provider,
        { value: focusRegistry },
        element,
      ),
    ),
  );

  // Restore raw mode and bracketed paste after suspend/resume (Ctrl+Z → fg).
  // Some platforms reset terminal modes on SIGTSTP; re-apply them on SIGCONT.
  // Registered BEFORE loop.start() so it fires before frame-loop's SIGCONT
  // handler — raw mode must be restored before processFrame writes to stdout.
  const sigcontHandler = process.platform !== 'win32' ? () => {
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?2004h'); // re-enable bracketed paste
  } : null;
  if (sigcontHandler) {
    process.on('SIGCONT', sigcontHandler);
  }

  // Start frame loop (cursor hide, reconciler mount, drain/resize listeners)
  loop.start(wrapped);

  // Raw mode — process keypresses as raw bytes
  stdin.setRawMode(true);
  stdin.resume();
  // Bracketed paste: terminal wraps pasted text in escape sequences so
  // the keypress decoder delivers it as a single 'paste' event.
  stdout.write('\x1b[?2004h');

  const unpatchConsole = (options?.patchConsole !== false)
    ? patchConsole(stdout)
    : null;

  const focusCleanup = onKeypress((key) => {
    if (key.type === 'tab') {
      focusRegistry.focusNext();
    } else if (key.type === 'shift-tab') {
      focusRegistry.focusPrevious();
    }
  }, stdin);

  // Keep the Node.js event loop alive while the app is running.
  // Without this, the process would exit after stdin is paused.
  const keepAlive = setInterval(() => {}, 60_000);

  // Restore cursor on any exit path (including process.exit from consumer)
  const exitHandler = () => {
    writeFileSync(1, '\x1b[?25h');
  };
  process.on('exit', exitHandler);

  function unmount(): void {
    if (unmounted) return;
    unmounted = true;

    clearInterval(keepAlive);
    if (sigcontHandler) {
      process.off('SIGCONT', sigcontHandler);
    }
    unpatchConsole?.();
    focusCleanup();
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\x1b[?2004l'); // disable bracketed paste mode
    loop.stop();
    process.off('exit', exitHandler);

    // If exit() wasn't called, resolve with undefined
    if (exitResolve) {
      exitResolve(undefined);
      exitResolve = null;
      exitReject = null;
    }
  }

  return {
    unmount,
    waitUntilExit: () => exitPromise,
    dumpFrameLog: (path: string) => loop.dumpFrameLog(path),
  };
}
