/** A single scoped PTY. Raw output may split UTF-8 and escape sequences. */
import { ConsumerConfigurationError } from './consumer-client.ts';
import { checked, controlBytes, identifier, interrupted, record, Serial, SessionError, timeout, validText } from './sdk.ts';
import type { SessionChannel } from './sdk.ts';
export type TerminalEvent = Buffer | { type: 'truncated' } | { type: 'exited'; exitCode: number | null } | null;
export class TerminalClient {
  readonly sessionId: string;
  readonly connection: SessionChannel;
  #closed = false;
  #reads = new Serial();
  #writes = new Serial();
  exited = false;
  exitCode: number | null = null;
  truncated = false;
  constructor(connection: SessionChannel, sessionId: string) { this.sessionId = identifier(sessionId); this.connection = connection; }
  get closed(): boolean { return this.#closed; }
  close(): void { if (!this.#closed) { this.#closed = true; this.connection.close(); } }
  [Symbol.dispose](): void { this.close(); }
  #check(): void { if (this.#closed) throw new SessionError('Terminal connection ended; input is not replayed.', 'session_disconnected', this.sessionId, false, 410); }
  #failure(error: unknown): never { try { this.close(); } catch {} throw interrupted(error, this.sessionId); }
  #control(value: Record<string, unknown>): Promise<void> {
    controlBytes(value);
    return this.#writes.run(async () => { this.#check(); try { await this.connection.sendControl(value); } catch (error) { this.#failure(error); } });
  }
  write(text: string): Promise<void> {
    if (!validText(text) || [...text].length > 16000) throw new ConsumerConfigurationError('Terminal input must be valid Unicode without NUL, within 16000 characters.');
    return this.#control({ action: 'shell-write', arguments: { text } });
  }
  resize(cols: number, rows: number): Promise<void> {
    if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 500)) throw new ConsumerConfigurationError('Terminal dimensions must be integers from 1 through 500.');
    return this.#control({ action: 'shell-resize', arguments: { cols, rows } });
  }
  receive(timeoutMs = 30_000): Promise<TerminalEvent> {
    timeout(timeoutMs, true);
    return this.#reads.run(async () => {
      this.#check();
      try {
        const value = checked(await this.connection.receive(timeoutMs), this.sessionId); this.#check();
        if (value === null || (Buffer.isBuffer(value) && value.length <= 65536)) return value;
        if (record(value)) {
          if (value.type === 'truncated' && Object.keys(value).length === 1) { this.truncated = true; return { type: 'truncated' }; }
          if (value.type === 'exited' && Object.keys(value).sort().join(',') === 'exitCode,type' &&
              (value.exitCode === null || Number.isSafeInteger(value.exitCode))) {
            this.exited = true; this.exitCode = value.exitCode as number | null; this.close(); return { type: 'exited', exitCode: this.exitCode };
          }
        }
        throw new SessionError('Invalid terminal output control.', 'session_protocol_error', this.sessionId);
      } catch (error) { return this.#failure(error); }
    });
  }
}
