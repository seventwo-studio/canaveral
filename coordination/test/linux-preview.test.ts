import assert from "node:assert/strict";
import test from "node:test";
import { parsePreview } from "../src/linux-preview.ts";

test("preview response parser rejects malformed and ambiguous upstream framing", () => {
  for (const raw of [
    "HTTP/1.1 100 Continue\r\n\r\n",
    "HTTP/1.1 200 OK\n\nabc",
    "HTTP/1.1 200 OK\r\nFolded: yes\r\n no\r\n\r\n",
    "HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nabc",
    "HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    "HTTP/1.1 204 No Content\r\n\r\nx",
    "HTTP/1.0 200 OK\r\n\r\n"+"x".repeat(65536),
  ]) assert.throws(() => parsePreview(Buffer.from(raw).toString("base64"),"GET"));
  const binary = Buffer.from("HTTP/1.0 200 OK\r\n\r\n\x00\xff","latin1").toString("base64");
  assert.deepEqual(parsePreview(binary,"GET").body,Buffer.from([0,255]));
  assert.throws(() => parsePreview(binary,"HEAD"));
  assert.throws(() => parsePreview(binary+"!","GET"));
});
