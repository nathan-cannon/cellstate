import { describe, it, expect } from 'bun:test';
import { createInputState, handleKey, type InputState } from '../../../src/tui/input.js';
import type { KeypressEvent } from '../../../src/tui/keypress.js';

function typeString(state: InputState, str: string): InputState {
  for (const ch of str) {
    state = handleKey(state, { type: 'char', char: ch });
  }
  return state;
}

describe('handleKey', () => {
  it('inserts a character at cursor 0', () => {
    const state = handleKey(createInputState(), { type: 'char', char: 'a' });
    expect(state.value).toBe('a');
    expect(state.cursor).toBe(1);
  });

  it('types multiple characters', () => {
    const state = typeString(createInputState(), 'hello');
    expect(state.value).toBe('hello');
    expect(state.cursor).toBe(5);
  });

  it('backspace deletes character before cursor', () => {
    let state = typeString(createInputState(), 'hello');
    state = handleKey(state, { type: 'backspace' });
    expect(state.value).toBe('hell');
    expect(state.cursor).toBe(4);
  });

  it('backspace at start does nothing', () => {
    const state = createInputState();
    const result = handleKey(state, { type: 'backspace' });
    expect(result).toBe(state);
  });

  it('delete removes character at cursor', () => {
    let state = typeString(createInputState(), 'hello');
    state = { ...state, cursor: 0 };
    state = handleKey(state, { type: 'delete' });
    expect(state.value).toBe('ello');
    expect(state.cursor).toBe(0);
  });

  it('delete at end does nothing', () => {
    const state = typeString(createInputState(), 'hello');
    const result = handleKey(state, { type: 'delete' });
    expect(result).toBe(state);
  });

  it('left moves cursor left', () => {
    let state = typeString(createInputState(), 'hello');
    state = handleKey(state, { type: 'left' });
    expect(state.cursor).toBe(4);
    expect(state.value).toBe('hello');
  });

  it('right moves cursor right', () => {
    let state = typeString(createInputState(), 'hello');
    state = { ...state, cursor: 2 };
    state = handleKey(state, { type: 'right' });
    expect(state.cursor).toBe(3);
    expect(state.value).toBe('hello');
  });

  it('left at start does not move', () => {
    const state = createInputState();
    const result = handleKey(state, { type: 'left' });
    expect(result).toBe(state);
  });

  it('right at end does not move', () => {
    const state = typeString(createInputState(), 'hello');
    const result = handleKey(state, { type: 'right' });
    expect(result).toBe(state);
  });

  it('home moves cursor to 0', () => {
    let state = typeString(createInputState(), 'hello');
    state = handleKey(state, { type: 'home' });
    expect(state.cursor).toBe(0);
    expect(state.value).toBe('hello');
  });

  it('end moves cursor to value.length', () => {
    let state = typeString(createInputState(), 'hello');
    state = { ...state, cursor: 2 };
    state = handleKey(state, { type: 'end' });
    expect(state.cursor).toBe(5);
    expect(state.value).toBe('hello');
  });

  it('inserts in middle', () => {
    let state: InputState = { value: 'hllo', cursor: 1 };
    state = handleKey(state, { type: 'char', char: 'e' });
    expect(state.value).toBe('hello');
    expect(state.cursor).toBe(2);
  });

  it('enter returns state unchanged', () => {
    const state = typeString(createInputState(), 'hello');
    const result = handleKey(state, { type: 'enter' });
    expect(result).toBe(state);
  });

  it('ctrl returns state unchanged', () => {
    const state = typeString(createInputState(), 'hello');
    const result = handleKey(state, { type: 'ctrl', ctrlKey: 'c' });
    expect(result).toBe(state);
  });
});
