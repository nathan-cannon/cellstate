import { useContext, useSyncExternalStore } from 'react';
import { FocusCtx } from './focus-context.js';

export interface UseFocusManagerResult {
  focus: (id: string) => void;
  focusNext: () => void;
  focusPrevious: () => void;
  enableFocus: () => void;
  disableFocus: () => void;
  activeId: string | null;
}

export function useFocusManager(): UseFocusManagerResult {
  const registry = useContext(FocusCtx);
  if (!registry) {
    throw new Error('useFocusManager must be used inside a component rendered by render()');
  }

  const activeId = useSyncExternalStore(
    (cb) => registry.subscribe(cb),
    () => registry.getActiveId(),
  );

  return {
    focus: (id: string) => registry.focus(id),
    focusNext: () => registry.focusNext(),
    focusPrevious: () => registry.focusPrevious(),
    enableFocus: () => registry.enableFocus(),
    disableFocus: () => registry.disableFocus(),
    activeId,
  };
}
