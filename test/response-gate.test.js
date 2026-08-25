import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ResponseGate } from "../src/response-gate.js";

test("buffers error responses so callers can retry", () => {
  const destination = fakeDestination();
  const gate = new ResponseGate(destination);
  gate.writeHead(503, { "content-type": "application/json" });
  gate.end('{"error":"offline"}');
  assert.equal(gate.committed, false);
  assert.equal(gate.statusCode, 503);
  assert.equal(gate.bufferedBody(), '{"error":"offline"}');
  assert.deepEqual(destination.chunks, []);
});

test("commits successful JSON responses on completion", () => {
  const destination = fakeDestination();
  const gate = new ResponseGate(destination);
  gate.writeHead(200, { "content-type": "application/json" });
  gate.end('{"ok":true}');
  assert.equal(gate.committed, true);
  assert.equal(destination.status, 200);
  assert.equal(Buffer.concat(destination.chunks).toString(), '{"ok":true}');
  assert.equal(destination.ended, true);
});

test("commits streaming responses after the first complete SSE event", () => {
  const destination = fakeDestination();
  const gate = new ResponseGate(destination);
  gate.writeHead(200, { "content-type": "text/event-stream" });
  gate.write("event: response.created\n");
  assert.equal(gate.committed, false);
  gate.write("data: {}\n\n");
  assert.equal(gate.committed, true);
  gate.end("data: [DONE]\n\n");
  assert.match(Buffer.concat(destination.chunks).toString(), /response\.created/);
});

function fakeDestination() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    chunks: [],
    destroyed: false,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(callback) {
      this.ended = true;
      callback?.();
    },
    destroy() {
      this.destroyed = true;
    },
  });
}
