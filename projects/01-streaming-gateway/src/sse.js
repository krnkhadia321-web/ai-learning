/**
 * Server-Sent Events (SSE) writer.
 *
 * SSE is a one-way HTTP streaming protocol: the server holds the response open and
 * writes text frames until it decides to close. That's a perfect fit for LLM output,
 * which is generated one token at a time and only flows server -> client.
 *
 * Why not WebSockets? A WebSocket is bidirectional and needs an upgrade handshake,
 * its own reconnect logic, and its own framing. For "server pushes tokens, client
 * just reads", SSE is plain HTTP: it works through normal proxies, load balancers
 * and HTTP/2 with no special handling.
 *
 * WIRE FORMAT — frames are separated by a BLANK LINE:
 *
 *     event: delta\n
 *     data: {"text":"Hello"}\n
 *     \n
 *
 * Rules that bite people:
 *   - The frame terminator is `\n\n`. Forget it and the client buffers forever.
 *   - Each LINE of the payload needs its own `data: ` prefix. A raw newline inside
 *     your payload silently splits it into two fields.
 *   - A line starting with `:` is a comment. Used below as a heartbeat.
 */

/** @typedef {import('node:http').ServerResponse} ServerResponse */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {ServerResponse} res
 * @param {{ heartbeatMs?: number }} [opts]
 */
export function createSseStream(req, res, { heartbeatMs = 15_000 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',

    // Any caching layer between us and the browser must not buffer or transform
    // this response. `no-transform` specifically stops proxies from gzipping it,
    // which would defeat incremental delivery.
    'Cache-Control': 'no-cache, no-transform',

    Connection: 'keep-alive',

    // nginx-specific: without this, nginx buffers the upstream response and the
    // client gets everything at once at the end. Harmless if nginx isn't there.
    'X-Accel-Buffering': 'no',
  });

  // Send the headers NOW rather than waiting for the first body write. The client
  // needs the 200 to know the stream opened successfully.
  res.flushHeaders?.();

  // Disable Nagle's algorithm. Nagle batches small writes to reduce packet count,
  // which is exactly wrong here: every token is a small write and we want it out
  // immediately. This is the difference between smooth streaming and 200ms stutter.
  res.socket?.setNoDelay(true);

  let closed = false;

  // Idle connections get reaped by proxies and load balancers, typically after
  // 30-60s. If the model is "thinking" and emits nothing for a while, a comment
  // frame keeps the connection alive without the client seeing an event.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  // Fires when the client goes away (tab closed, navigated, network dropped) AND
  // on normal completion. The caller uses `closed` to stop doing expensive work.
  res.on('close', cleanup);

  return {
    get closed() {
      return closed;
    },

    /**
     * Write one SSE frame.
     * @param {string} event  Event name the client listens for.
     * @param {unknown} data  Serialised to JSON unless already a string.
     * @returns {boolean} false if the socket buffer is full (backpressure) or closed.
     */
    send(event, data) {
      if (closed) return false;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);

      // Per the spec, every line needs its own `data: ` prefix — otherwise an
      // embedded newline corrupts the frame.
      const body = payload
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n');

      // `res.write` returns false when the kernel/socket buffer is full. We surface
      // it so the caller can respect backpressure instead of ballooning memory.
      return res.write(`event: ${event}\n${body}\n\n`);
    },

    end() {
      if (closed) return;
      cleanup();
      res.end();
    },
  };
}
