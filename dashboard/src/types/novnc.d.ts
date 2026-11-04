/** Root export alias and the minimal raw channel accepted by noVNC 1.7's Websock.attach. */
declare module "@novnc/novnc" {
  import NativeRFB from "@novnc/novnc/lib/rfb";
  export type RFBChannel = Pick<
    WebSocket,
    | "send"
    | "close"
    | "binaryType"
    | "readyState"
    | "protocol"
    | "onmessage"
    | "onopen"
    | "onclose"
    | "onerror"
  >;
  export default class RFB extends NativeRFB {
    constructor(
      target: Element,
      channel: string | WebSocket | RTCDataChannel | RFBChannel,
      options?: ConstructorParameters<typeof NativeRFB>[2],
    );
  }
}
