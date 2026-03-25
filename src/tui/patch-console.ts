/**
 * Redirects console.log/info/warn/error/debug to stderr so they don't
 * corrupt the rendered frame on stdout. Returns a cleanup function.
 */
import util from 'node:util';

export function patchConsole(stdout: NodeJS.WriteStream): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  function redirect(method: (...args: any[]) => void, stream: NodeJS.WritableStream) {
    return (...args: any[]) => {
      const message = util.format(...args);
      stream.write(message + '\n');
    };
  }

  // Redirect all console methods to stderr so they don't corrupt
  // the rendered output on stdout. console.warn and console.error already
  // go to stderr by default in Node, but we patch them for consistency.
  console.log = redirect(originalLog, process.stderr);
  console.info = redirect(originalInfo, process.stderr);
  console.warn = redirect(originalWarn, process.stderr);
  console.error = redirect(originalError, process.stderr);
  console.debug = redirect(originalDebug, process.stderr);

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    console.debug = originalDebug;
  };
}
