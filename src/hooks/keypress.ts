/** @see https://cirw.in/blog/bracketed-paste */
export interface KeypressEvent {
  type: 'char' | 'backspace' | 'delete' | 'enter' | 'left' | 'right' | 'home' | 'end' | 'up' | 'down' | 'ctrl' | 'paste' | 'tab' | 'shift-tab';
  char?: string;
  ctrlKey?: string;
  paste?: string;
}

export function decodeKeypress(data: Buffer): KeypressEvent[] {
  const str = data.toString('utf-8');
  const events: KeypressEvent[] = [];
  let i = 0;

  while (i < str.length) {
    const code = str.charCodeAt(i);

    // Escape sequence
    if (code === 0x1b) {
      if (i + 1 < str.length && str.charCodeAt(i + 1) === 0x5b) {
        // SGR mouse sequence: \x1b[< ... M/m, consume silently
        if (i + 2 < str.length && str.charCodeAt(i + 2) === 0x3c) {
          i += 3; // skip \x1b[<
          while (i < str.length) {
            const c = str[i]!;
            i++;
            if (c === 'M' || c === 'm') break;
          }
          continue;
        }

        // CSI sequence: \x1b[ ...
        i += 2;
        // Collect parameter bytes (0x30-0x3F)
        let param = '';
        while (i < str.length) {
          const c = str.charCodeAt(i);
          if (c >= 0x30 && c <= 0x3f) {
            param += str[i];
            i++;
          } else {
            break;
          }
        }
        // Final byte
        if (i < str.length) {
          const final = str[i];
          i++;
          switch (final) {
            case 'A': events.push({ type: 'up' }); break;
            case 'B': events.push({ type: 'down' }); break;
            case 'C': events.push({ type: 'right' }); break;
            case 'D': events.push({ type: 'left' }); break;
            case 'H': events.push({ type: 'home' }); break;
            case 'F': events.push({ type: 'end' }); break;
            case 'Z': events.push({ type: 'shift-tab' }); break;
            case '~':
              if (param === '1') events.push({ type: 'home' });
              else if (param === '4') events.push({ type: 'end' });
              else if (param === '3') events.push({ type: 'delete' });
              // else: unknown tilde sequence, ignore
              break;
            // Unknown final byte: ignore
          }
        }
      } else {
        // Bare escape, ignore
        i++;
      }
      continue;
    }

    // Backspace
    if (code === 0x7f || code === 0x08) {
      events.push({ type: 'backspace' });
      i++;
      continue;
    }

    // Enter
    if (code === 0x0d || code === 0x0a) {
      events.push({ type: 'enter' });
      i++;
      continue;
    }

    // Tab (0x09), handle before ctrl range
    if (code === 0x09) {
      events.push({ type: 'tab' });
      i++;
      continue;
    }

    // Ctrl+letter: terminal sends byte 0x01–0x1A for Ctrl+A through Ctrl+Z.
    // Add 0x60 to recover the lowercase ASCII letter (e.g. 0x03 → 'c' for Ctrl+C).
    if (code >= 0x01 && code <= 0x1a) {
      events.push({ type: 'ctrl', ctrlKey: String.fromCharCode(code + 0x60) });
      i++;
      continue;
    }

    // Printable ASCII or multi-byte UTF-8 (including surrogate pairs)
    if (code >= 0x20) {
      const cp = str.codePointAt(i)!;
      const char = String.fromCodePoint(cp);
      events.push({ type: 'char', char });
      i += char.length; // 2 for surrogate pairs, 1 otherwise
      continue;
    }

    // Unknown byte, skip
    i++;
  }

  return events;
}

export function onKeypress(
  callback: (key: KeypressEvent) => void,
  stdin: NodeJS.ReadableStream = process.stdin,
): () => void {
  let pasteBuffer: string | null = null;

  const handler = (data: Buffer) => {
    let str = data.toString('utf-8');

    // If we're accumulating a paste, append to buffer
    if (pasteBuffer !== null) {
      pasteBuffer += str;
      const endIdx = pasteBuffer.indexOf('\x1b[201~');
      if (endIdx !== -1) {
        // Paste complete, emit the paste event
        const pasteContent = pasteBuffer.slice(0, endIdx);
        const remaining = pasteBuffer.slice(endIdx + 6);
        pasteBuffer = null;
        callback({ type: 'paste', paste: pasteContent });
        // Process any remaining data after the paste end marker
        if (remaining.length > 0) {
          const events = decodeKeypress(Buffer.from(remaining));
          for (const event of events) {
            callback(event);
          }
        }
      }
      // If no end marker yet, keep buffering
      return;
    }

    // Check if this chunk starts a paste
    const startIdx = str.indexOf('\x1b[200~');
    if (startIdx !== -1) {
      // Process any data before the paste start
      if (startIdx > 0) {
        const events = decodeKeypress(Buffer.from(str.slice(0, startIdx)));
        for (const event of events) {
          callback(event);
        }
      }

      const afterStart = str.slice(startIdx + 6);
      const endIdx = afterStart.indexOf('\x1b[201~');
      if (endIdx !== -1) {
        // Complete paste in one chunk
        callback({ type: 'paste', paste: afterStart.slice(0, endIdx) });
        // Process remaining after paste end
        const remaining = afterStart.slice(endIdx + 6);
        if (remaining.length > 0) {
          const events = decodeKeypress(Buffer.from(remaining));
          for (const event of events) {
            callback(event);
          }
        }
      } else {
        // Paste started but not ended, start buffering
        pasteBuffer = afterStart;
      }
      return;
    }

    // Normal (non-paste) data
    const events = decodeKeypress(data);
    for (const event of events) {
      callback(event);
    }
  };

  stdin.on('data', handler);

  return () => {
    stdin.off('data', handler);
  };
}
