/** Drives the client side of the dashboard relay without a network. */
export class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  protocol = "canaveral-session-v1";
  binaryType = "blob";
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  control(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
  bytes(value: Uint8Array) {
    this.onmessage?.({ data: value.slice().buffer } as MessageEvent);
  }
}
