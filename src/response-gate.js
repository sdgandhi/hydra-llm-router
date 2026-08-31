import { EventEmitter } from "node:events";

function chunkBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk ?? ""), typeof encoding === "string" ? encoding : "utf8");
}

export class ResponseGate extends EventEmitter {
  constructor(destination, { bodyTransform = null } = {}) {
    super();
    this.destination = destination;
    this.bodyTransform = bodyTransform;
    this.statusCode = 200;
    this.responseHeaders = {};
    this.buffered = [];
    this.committed = false;
    this.finished = false;
    this.failureError = null;
  }

  get headersSent() {
    return this.committed;
  }

  get writableEnded() {
    return this.finished;
  }

  get destroyed() {
    return this.destination.destroyed;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.responseHeaders = { ...headers };
    return this;
  }

  write(chunk, encoding, callback) {
    const data = chunkBuffer(chunk, encoding);
    if (this.committed) {
      const writable = this.writeDestination(data);
      callback?.();
      return writable;
    }
    this.buffered.push(data);
    if (this.statusCode < 400 && this.isCompleteSseEventBuffered()) this.commit();
    callback?.();
    return true;
  }

  end(chunk, encoding, callback) {
    if (chunk != null) this.write(chunk, encoding);
    if (!this.committed && this.statusCode < 400) this.commit();
    this.finished = true;
    if (this.committed) {
      for (const data of this.bodyTransform?.end?.() ?? []) this.destination.write(data);
      this.destination.end(callback);
    }
    else callback?.();
    return this;
  }

  destroy(error) {
    this.failureError = error ?? new Error("Response destroyed before completion");
    this.finished = true;
    if (this.committed && !this.destination.destroyed) this.destination.destroy(error);
    return this;
  }

  once(event, listener) {
    if (event === "drain" && this.committed) {
      this.destination.once(event, listener);
      return this;
    }
    return super.once(event, listener);
  }

  off(event, listener) {
    if (event === "drain" && this.committed) {
      this.destination.off(event, listener);
      return this;
    }
    return super.off(event, listener);
  }

  commit() {
    if (this.committed) return;
    this.committed = true;
    const headers = this.bodyTransform?.headers?.(this.responseHeaders) ?? this.responseHeaders;
    this.destination.writeHead(this.statusCode, headers);
    for (const chunk of this.buffered) this.writeDestination(chunk);
    this.buffered = [];
  }

  writeDestination(chunk) {
    const chunks = this.bodyTransform?.write?.(chunk) ?? [chunk];
    let writable = true;
    for (const data of chunks) writable = this.destination.write(data) && writable;
    return writable;
  }

  bufferedBody() {
    return Buffer.concat(this.buffered).toString("utf8");
  }

  isCompleteSseEventBuffered() {
    const contentType = String(this.responseHeaders["content-type"] ?? this.responseHeaders["Content-Type"] ?? "");
    if (!contentType.includes("text/event-stream")) return false;
    return this.bufferedBody().includes("\n\n");
  }
}
