import { describe, expect, it } from 'bun:test';
import { decodeKeypress } from '../keypress.js';

describe('decodeKeypress', () => {
  it('decodes printable ASCII', () => {
    expect(decodeKeypress(Buffer.from('a'))).toEqual([{ type: 'char', char: 'a' }]);
  });

  it('decodes multiple characters (paste)', () => {
    const events = decodeKeypress(Buffer.from('hello'));
    expect(events).toHaveLength(5);
    expect(events).toEqual([
      { type: 'char', char: 'h' },
      { type: 'char', char: 'e' },
      { type: 'char', char: 'l' },
      { type: 'char', char: 'l' },
      { type: 'char', char: 'o' },
    ]);
  });

  it('decodes backspace (0x7F)', () => {
    expect(decodeKeypress(Buffer.from([0x7f]))).toEqual([{ type: 'backspace' }]);
  });

  it('decodes backspace (0x08)', () => {
    expect(decodeKeypress(Buffer.from([0x08]))).toEqual([{ type: 'backspace' }]);
  });

  it('decodes enter (0x0D)', () => {
    expect(decodeKeypress(Buffer.from([0x0d]))).toEqual([{ type: 'enter' }]);
  });

  it('decodes enter (0x0A)', () => {
    expect(decodeKeypress(Buffer.from([0x0a]))).toEqual([{ type: 'enter' }]);
  });

  it('decodes arrow up', () => {
    expect(decodeKeypress(Buffer.from('\x1b[A'))).toEqual([{ type: 'up' }]);
  });

  it('decodes arrow down', () => {
    expect(decodeKeypress(Buffer.from('\x1b[B'))).toEqual([{ type: 'down' }]);
  });

  it('decodes arrow right', () => {
    expect(decodeKeypress(Buffer.from('\x1b[C'))).toEqual([{ type: 'right' }]);
  });

  it('decodes arrow left', () => {
    expect(decodeKeypress(Buffer.from('\x1b[D'))).toEqual([{ type: 'left' }]);
  });

  it('decodes Ctrl+C', () => {
    expect(decodeKeypress(Buffer.from([0x03]))).toEqual([{ type: 'ctrl', ctrlKey: 'c' }]);
  });

  it('decodes Ctrl+D', () => {
    expect(decodeKeypress(Buffer.from([0x04]))).toEqual([{ type: 'ctrl', ctrlKey: 'd' }]);
  });

  it('decodes Ctrl+A', () => {
    expect(decodeKeypress(Buffer.from([0x01]))).toEqual([{ type: 'ctrl', ctrlKey: 'a' }]);
  });

  it('decodes Ctrl+Z', () => {
    expect(decodeKeypress(Buffer.from([0x1a]))).toEqual([{ type: 'ctrl', ctrlKey: 'z' }]);
  });

  it('decodes Home (\\x1b[H)', () => {
    expect(decodeKeypress(Buffer.from('\x1b[H'))).toEqual([{ type: 'home' }]);
  });

  it('decodes Home (\\x1b[1~)', () => {
    expect(decodeKeypress(Buffer.from('\x1b[1~'))).toEqual([{ type: 'home' }]);
  });

  it('decodes End (\\x1b[F)', () => {
    expect(decodeKeypress(Buffer.from('\x1b[F'))).toEqual([{ type: 'end' }]);
  });

  it('decodes End (\\x1b[4~)', () => {
    expect(decodeKeypress(Buffer.from('\x1b[4~'))).toEqual([{ type: 'end' }]);
  });

  it('decodes Delete (\\x1b[3~)', () => {
    expect(decodeKeypress(Buffer.from('\x1b[3~'))).toEqual([{ type: 'delete' }]);
  });

  it('decodes UTF-8 multi-byte characters', () => {
    expect(decodeKeypress(Buffer.from('é'))).toEqual([{ type: 'char', char: 'é' }]);
  });

  it('decodes emoji', () => {
    expect(decodeKeypress(Buffer.from('🎉'))).toEqual([{ type: 'char', char: '🎉' }]);
  });

  it('decodes CJK characters', () => {
    expect(decodeKeypress(Buffer.from('你'))).toEqual([{ type: 'char', char: '你' }]);
  });

  it('ignores bare escape', () => {
    expect(decodeKeypress(Buffer.from([0x1b]))).toEqual([]);
  });

  it('ignores unknown CSI sequences', () => {
    // \x1b[99~ — unknown tilde param
    const events = decodeKeypress(Buffer.from('\x1b[99~'));
    expect(events).toEqual([]);
  });

  it('ignores unknown CSI final byte', () => {
    const events = decodeKeypress(Buffer.from('\x1b[X'));
    expect(events).toEqual([]);
  });

  it('handles empty buffer', () => {
    expect(decodeKeypress(Buffer.from([]))).toEqual([]);
  });

  it('handles mixed content — text + control', () => {
    // 'a' + Ctrl+C + 'b'
    const buf = Buffer.concat([Buffer.from('a'), Buffer.from([0x03]), Buffer.from('b')]);
    expect(decodeKeypress(buf)).toEqual([
      { type: 'char', char: 'a' },
      { type: 'ctrl', ctrlKey: 'c' },
      { type: 'char', char: 'b' },
    ]);
  });

  it('handles escape sequence followed by printable', () => {
    const buf = Buffer.concat([Buffer.from('\x1b[A'), Buffer.from('x')]);
    expect(decodeKeypress(buf)).toEqual([
      { type: 'up' },
      { type: 'char', char: 'x' },
    ]);
  });

  it('handles space character', () => {
    expect(decodeKeypress(Buffer.from(' '))).toEqual([{ type: 'char', char: ' ' }]);
  });

  it('handles tilde character', () => {
    expect(decodeKeypress(Buffer.from('~'))).toEqual([{ type: 'char', char: '~' }]);
  });

  // SGR mouse sequences are consumed silently (no events produced)
  it('silently consumes SGR mouse sequences', () => {
    expect(decodeKeypress(Buffer.from('\x1b[<64;10;20M'))).toEqual([]);
    expect(decodeKeypress(Buffer.from('\x1b[<65;10;20M'))).toEqual([]);
    expect(decodeKeypress(Buffer.from('\x1b[<0;10;20M'))).toEqual([]);
    expect(decodeKeypress(Buffer.from('\x1b[<0;10;20m'))).toEqual([]);
  });

  it('SGR sequence mixed with regular keys — only keys produce events', () => {
    expect(decodeKeypress(Buffer.from('a\x1b[<64;1;1Mb'))).toEqual([
      { type: 'char', char: 'a' },
      { type: 'char', char: 'b' },
    ]);
  });
});
