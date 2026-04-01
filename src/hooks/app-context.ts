import { createContext, useContext } from 'react';

export interface AppContext {
  exit: (errorOrResult?: unknown) => void;
}

export const AppCtx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(AppCtx);
  if (!ctx) {
    throw new Error('useApp must be used inside a component rendered by render()');
  }
  return ctx;
}
