import type { KeypressEvent } from './keypress.js';

export type InputState = {
  value: string;
  cursor: number;
};

export function createInputState(): InputState {
  return { value: '', cursor: 0 };
}

export function handleKey(state: InputState, key: KeypressEvent): InputState {
  switch (key.type) {
    case 'char': {
      const ch = key.char ?? '';
      return {
        value: state.value.slice(0, state.cursor) + ch + state.value.slice(state.cursor),
        cursor: state.cursor + ch.length,
      };
    }
    case 'backspace':
      if (state.cursor === 0) return state;
      return {
        value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
        cursor: state.cursor - 1,
      };
    case 'delete':
      if (state.cursor >= state.value.length) return state;
      return {
        value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1),
        cursor: state.cursor,
      };
    case 'left':
      if (state.cursor === 0) return state;
      return { value: state.value, cursor: state.cursor - 1 };
    case 'right':
      if (state.cursor >= state.value.length) return state;
      return { value: state.value, cursor: state.cursor + 1 };
    case 'home':
      return { value: state.value, cursor: 0 };
    case 'end':
      return { value: state.value, cursor: state.value.length };
    case 'enter':
    case 'up':
    case 'down':
    case 'ctrl':
    case 'paste':
    default:
      return state;
  }
}
