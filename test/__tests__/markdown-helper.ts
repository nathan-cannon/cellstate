import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight } from "cli-highlight";

marked.use(
  markedTerminal({
    highlight: (code: string, lang: string) =>
      highlight(code, { language: lang || "text", ignoreIllegals: true }),
  })
);

/** Render markdown to ANSI-styled terminal text. */
export function renderMarkdown(text: string): string {
  return (marked.parse(text) as string).trimEnd();
}
