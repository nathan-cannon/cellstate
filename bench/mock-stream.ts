/**
 * Mock stdout/stdin for benchmarks and tests. MockStdout extends EventEmitter
 * (not Writable) because Writable can return false from write(), which would
 * trigger backpressure and stall the frame loop.
 */
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

const DEC_2026_OFF = '\x1b[?2026l';

export interface FrameRecord {
  ts: number;
  bytes: number;
  data: string;
}

// Plain EventEmitter, not Writable. Node's Writable can return false from write(),
// which causes CellState's frame loop to set isFlushing=true and stall.
export class MockStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY = true as const;
  fd = 1 as const;

  private _frameBuf: { ts: number; bytes: number; data: string }[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _frameResolve: ((frame: FrameRecord) => void) | null = null;
  private _frames: FrameRecord[] = [];

  constructor(cols = 120, rows = 40) {
    super();
    this.columns = cols;
    this.rows = rows;
  }

  // Must return true; CellState's frame loop sets isFlushing=true on false.
  write(chunk: string | Buffer, ...args: unknown[]): boolean {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;

    const cb = typeof args[args.length - 1] === 'function'
      ? (args[args.length - 1] as () => void)
      : null;

    this._frameBuf.push({ ts: performance.now(), bytes: size, data: str });

    if (str.includes(DEC_2026_OFF)) {
      this._flushFrame();
    } else {
      // No DEC 2026 marker; batch writes in same tick
      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this._flushFrame(), 1);
    }

    if (cb) cb();
    return true;
  }

  private _flushFrame(): void {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._frameBuf.length === 0) return;

    const lastTs = this._frameBuf[this._frameBuf.length - 1]!.ts;
    const totalBytes = this._frameBuf.reduce((s, f) => s + f.bytes, 0);
    const allData = this._frameBuf.map((f) => f.data).join('');
    this._frameBuf = [];

    const frame: FrameRecord = { ts: lastTs, bytes: totalBytes, data: allData };
    this._frames.push(frame);

    if (this._frameResolve) {
      const resolve = this._frameResolve;
      this._frameResolve = null;
      resolve(frame);
    }
  }

  nextFrame(): Promise<FrameRecord> {
    return new Promise((resolve) => {
      this._frameResolve = resolve;
    });
  }

  nextFrameTimeout(ms: number): Promise<FrameRecord | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._frameResolve = null;
        resolve(null);
      }, ms);

      this._frameResolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  resetFrames(): void {
    this._frames = [];
    this._frameBuf = [];
  }

  get frameCount(): number {
    return this._frames.length;
  }

  get writable(): boolean {
    return true;
  }

  get writableEnded(): boolean {
    return false;
  }

  get destroyed(): boolean {
    return false;
  }

  cursorTo(_x: number, _y?: number): boolean {
    return true;
  }
  clearScreenDown(): boolean {
    return true;
  }
  moveCursor(_dx: number, _dy: number): boolean {
    return true;
  }
  clearLine(_dir: number): boolean {
    return true;
  }
  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
  end(): this {
    return this;
  }
}

// Emits both 'data' (CellState) and 'readable' (Ink) on keypress.
export class MockStdin extends EventEmitter {
  isTTY = true as const;
  fd = 0 as const;
  isRaw = false;
  private _readBuffer: Buffer | null = null;

  setRawMode(flag: boolean): this {
    this.isRaw = flag;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  // Ink drains stdin via readable + read(); return buffered data once then null.
  read(): Buffer | null {
    const buf = this._readBuffer;
    this._readBuffer = null;
    return buf;
  }

  setEncoding(_encoding: string): this {
    return this;
  }

  unref(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  // Returns performance.now() timestamp for latency measurement.
  emitKeypress(char: string): number {
    const buf = Buffer.from(char);
    this._readBuffer = buf;
    const t0 = performance.now();
    this.emit('data', buf);
    this.emit('readable');
    return t0;
  }
}
