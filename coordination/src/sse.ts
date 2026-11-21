/** Minimal server-sent event reader for the controller's event stream.
 * Follows the WHATWG field rules for `id`, `event`, `data` and comments; `retry` is ignored because
 * no client here reconnects on its own. One event and the unparsed tail are bounded, so a peer cannot
 * grow memory by never ending a line. */
export interface ServerSentEvent { id?: string; event?: string; data: string }
export async function* serverSentEvents(chunks: AsyncIterable<Buffer | string>, maxEventBytes = 1_048_576): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "", data: string[] = [], size = 0, id: string | undefined, event: string | undefined;
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = buffer.search(/\r\n|\n|\r/);
      // A lone trailing CR may be the first half of CRLF; wait for the next chunk.
      if (end === -1 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
      if (line === "") {
        if (data.length) yield { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join("\n") };
        data = []; size = 0; event = undefined;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":"), field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") { size += value.length + 1; data.push(value); }
      else if (field === "event") event = value;
      else if (field === "id" && !value.includes("\0")) id = value;
      if (size > maxEventBytes) throw new RangeError("Server-sent event exceeds its size limit.");
    }
    if (buffer.length > maxEventBytes) throw new RangeError("Server-sent event line exceeds its size limit.");
  }
}
