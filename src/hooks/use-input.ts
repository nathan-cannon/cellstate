import { useEffect, useRef } from 'react';
import { onKeypress, type KeypressEvent } from './keypress.js';

export interface UseInputOptions {
  active?: boolean;
}

/**
 * Subscribe to raw keypress events. The callback fires for every
 * decoded keypress while `active` is true (default).
 *
 * Cleans up the stdin listener on unmount or when `active` becomes false.
 */
export function useInput(
  callback: (key: KeypressEvent) => void,
  options?: UseInputOptions,
): void {
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; }, [callback]);

  const active = options?.active ?? true;

  useEffect(() => {
    if (!active) return;

    const cleanup = onKeypress((key) => {
      callbackRef.current(key);
    });

    return cleanup;
  }, [active]);
}
