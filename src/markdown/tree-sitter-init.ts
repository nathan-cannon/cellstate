/**
 * Tree-sitter initialization and language registry.
 *
 * Uses @kreuzberg/tree-sitter-language-pack for grammar management.
 * Grammars are downloaded on demand and cached locally.
 */
import {
  init as langPackInit,
  hasLanguage,
  download,
} from '@kreuzberg/tree-sitter-language-pack';

// ── Singleton state ──

let initPromise: Promise<void> | null = null;
let initialized = false;

// ── Language alias map ──

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  htm: 'html',
  jsonc: 'json',
  rs: 'rust',
};

/** Canonical language name. */
export function canonLang(lang: string): string {
  const lower = lang.toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

// ── Initialization ──

/**
 * Initialize the tree-sitter language pack.
 * Downloads core language grammars for syntax highlighting.
 * Safe to call multiple times — only runs once.
 */
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  langPackInit({
    languages: [
      'typescript', 'tsx', 'javascript', 'python', 'bash', 'json',
      'go', 'rust', 'html', 'css', 'yaml', 'c', 'cpp', 'java',
      'ruby', 'php', 'swift', 'kotlin', 'scala', 'lua', 'r',
      'toml', 'sql', 'markdown',
    ],
  });
  initialized = true;
}

/** Whether initTreeSitter() has completed. */
export function isInitialized(): boolean {
  return initialized;
}

// ── Language registry ──

/**
 * Check if a language is supported for highlighting.
 * Returns true if the language pack has a grammar for this language.
 */
export function isLanguageSupported(lang: string): boolean {
  if (!initialized) return false;
  return hasLanguage(canonLang(lang));
}

/**
 * Ensure a language grammar is downloaded and ready.
 * Downloads on demand if not already cached.
 */
export function ensureLanguage(lang: string): boolean {
  if (!initialized) return false;
  const canonical = canonLang(lang);
  if (hasLanguage(canonical)) return true;
  try {
    download([canonical]);
    return hasLanguage(canonical);
  } catch {
    return false;
  }
}

/**
 * Pre-load a set of language grammars concurrently.
 */
export async function preloadLanguages(langs: string[]): Promise<void> {
  if (!initialized) await initTreeSitter();
  const toDownload = langs.map(canonLang).filter(l => !hasLanguage(l));
  if (toDownload.length > 0) {
    try {
      download(toDownload);
    } catch {
      // Best-effort — some languages may not be available
    }
  }
}

/**
 * @deprecated No longer needed — kreuzberg handles grammar paths internally.
 * Kept for backward compatibility; this is a no-op.
 */
export function setWasmDir(_dir: string): void {
  // No-op: kreuzberg manages its own cache directory
}
