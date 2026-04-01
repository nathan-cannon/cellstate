/** Hook to make a component focusable in the Tab cycling order. */
import { useContext, useEffect, useId, useSyncExternalStore } from 'react';
import { FocusCtx } from './focus-context.js';

export interface UseFocusOptions {
  autoFocus?: boolean;
  isActive?: boolean;
  id?: string;
}

export interface UseFocusResult {
  isFocused: boolean;
}

export function useFocus(options?: UseFocusOptions): UseFocusResult {
  const registry = useContext(FocusCtx);
  if (!registry) {
    throw new Error('useFocus must be used inside a component rendered by render()');
  }

  const reactId = useId();
  const id = options?.id ?? reactId;
  const isActive = options?.isActive ?? true;
  const autoFocus = options?.autoFocus ?? false;

  useEffect(() => {
    registry.register(id, isActive, autoFocus);
    return () => registry.unregister(id);
  }, [id]);

  useEffect(() => {
    registry.updateActive(id, isActive);
  }, [id, isActive]);

  const isFocused = useSyncExternalStore(
    (cb) => registry.subscribe(cb),
    () => registry.isFocused(id),
  );

  return { isFocused };
}
