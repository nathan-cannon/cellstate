/** Focus registry for Tab/Shift-Tab cycling. Tab events forwarded from render.ts. */
import { createContext } from 'react';

interface FocusEntry {
  id: string;
  isActive: boolean;
}

export class FocusRegistry {
  entries: FocusEntry[] = [];
  focusedId: string | null = null;
  enabled: boolean = true;
  listeners: Set<() => void> = new Set();

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  register(id: string, isActive: boolean, autoFocus: boolean): void {
    this.entries.push({ id, isActive });
    if (autoFocus && this.focusedId === null && this.enabled) {
      this.focusedId = id;
    }
    this.notify();
  }

  unregister(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.focusedId === id) {
      this.focusedId = null;
    }
    this.notify();
  }

  updateActive(id: string, isActive: boolean): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) {
      entry.isActive = isActive;
      if (this.focusedId === id && !isActive) {
        this.focusedId = null;
      }
      this.notify();
    }
  }

  focus(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry && entry.isActive && this.enabled) {
      this.focusedId = id;
      this.notify();
    }
  }

  focusNext(): void {
    if (!this.enabled) return;
    const active = this.entries.filter((e) => e.isActive);
    if (active.length === 0) return;

    if (this.focusedId === null) {
      this.focusedId = active[0]!.id;
      this.notify();
      return;
    }

    const idx = active.findIndex((e) => e.id === this.focusedId);
    const next = idx === -1 ? 0 : (idx + 1) % active.length;
    this.focusedId = active[next]!.id;
    this.notify();
  }

  focusPrevious(): void {
    if (!this.enabled) return;
    const active = this.entries.filter((e) => e.isActive);
    if (active.length === 0) return;

    if (this.focusedId === null) {
      this.focusedId = active[active.length - 1]!.id;
      this.notify();
      return;
    }

    const idx = active.findIndex((e) => e.id === this.focusedId);
    const prev = idx === -1 ? active.length - 1 : (idx - 1 + active.length) % active.length;
    this.focusedId = active[prev]!.id;
    this.notify();
  }

  enableFocus(): void {
    this.enabled = true;
    this.notify();
  }

  disableFocus(): void {
    this.enabled = false;
    this.focusedId = null;
    this.notify();
  }

  getActiveId(): string | null {
    return this.focusedId;
  }

  isFocused(id: string): boolean {
    return this.enabled && this.focusedId === id;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const FocusCtx = createContext<FocusRegistry | null>(null);
