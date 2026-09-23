import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.STIKSERVER_HOST || "127.0.0.1";
const port = Number(process.env.STIKSERVER_PORT || 8765);
const token = process.env.STIKSERVER_TOKEN || "";
const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
const agents = new Map();
const viewers = new Set();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function authorized(requestURL) {
  if (!token) return true;
  const supplied = Buffer.from(requestURL.searchParams.get("token") || "");
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function deviceList() {
  return [...agents.values()].map(({ metadata }) => metadata);
}

function sendJSON(peer, value) {
  peer.send(Buffer.from(JSON.stringify(value)), 0x1);
}

function publishDevices() {
  const message = { type: "devices", devices: deviceList() };
  for (const viewer of viewers) sendJSON(viewer, message);
}

class WebSocketPeer {
  constructor(socket, role) {
    this.socket = socket;
    this.role = role;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this.deviceId = null;
    this.subscription = null;
    socket.on("data", chunk => this.receive(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  send(payload, opcode = 0x2) {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wideLength = this.buffer.readBigUInt64BE(2);
        if (wideLength > 8n * 1024n * 1024n) return this.close(1009, "Frame too large");
        length = Number(wideLength);
        offset = 10;
      }
      if (!masked) return this.close(1002, "Client frames must be masked");
      if (length > 8 * 1024 * 1024) return this.close(1009, "Frame too large");
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.handleFrame(opcode, final, payload);
    }
  }

  handleFrame(opcode, final, payload) {
    if (opcode === 0x8) return this.close(1000, "Goodbye");
    if (opcode === 0x9) return this.send(payload, 0xA);
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) return this.close(1002, "Unexpected continuation");
      this.fragments.push(payload);
      if (final) {
        const complete = Buffer.concat(this.fragments);
        const originalOpcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = null;
        this.message(originalOpcode, complete);
      }
      return;
    }
    if (!final) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    this.message(opcode, payload);
  }

  message(opcode, payload) {
    if (opcode === 0x2) {
      if (this.role !== "agent" || !this.deviceId) return;
      for (const viewer of viewers) {
        if (viewer.subscription === this.deviceId) viewer.send(payload);
      }
      return;
    }
    if (opcode !== 0x1) return;
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      return sendJSON(this, { type: "error", message: "Invalid JSON" });
    }
    if (this.role === "agent") this.agentMessage(message);
    else this.viewerMessage(message);
  }

  agentMessage(message) {
    if (message.type === "register") {
      const id = String(message.device?.id || "").trim();
      if (!id) return sendJSON(this, { type: "error", message: "Missing device id" });
      const previous = agents.get(id)?.peer;
      if (previous && previous !== this) previous.close(4001, "Replaced by a new connection");
      if (this.deviceId && agents.get(this.deviceId)?.peer === this) agents.delete(this.deviceId);
      this.deviceId = id;
      const metadata = {
        id,
        name: String(message.device.name || "iOS Device"),
        kind: String(message.device.kind || "iPhone"),
        width: Number(message.device.width || 0),
        height: Number(message.device.height || 0),
        connected: true
      };
      agents.set(id, { peer: this, metadata });
      sendJSON(this, { type: "registered", deviceId: id });
      publishDevices();
      return;
    }
    if (message.type === "metadata" && this.deviceId) {
      const entry = agents.get(this.deviceId);
      if (entry) {
        entry.metadata = { ...entry.metadata, ...message.device, id: this.deviceId, connected: true };
        publishDevices();
      }
    }
  }

  viewerMessage(message) {
    if (message.type === "subscribe") {
      const id = String(message.deviceId || "");
      this.subscription = agents.has(id) ? id : null;
      sendJSON(this, { type: "subscribed", deviceId: this.subscription });
      return;
    }
    if (message.type === "command") {
      const id = String(message.deviceId || this.subscription || "");
      const agent = agents.get(id)?.peer;
      if (!agent) return sendJSON(this, { type: "error", message: "Device is offline" });
      sendJSON(agent, { ...message, deviceId: id });
    }
  }

  close(code, reason) {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason || "");
    const payload = Buffer.alloc(2 + Math.min(reasonBytes.length, 123));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.length - 2);
    this.send(payload, 0x8);
    this.closed = true;
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed && !viewers.has(this) && !this.deviceId) return;
    this.closed = true;
    viewers.delete(this);
    if (this.deviceId && agents.get(this.deviceId)?.peer === this) {
      agents.delete(this.deviceId);
      publishDevices();
    }
    this.deviceId = null;
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(requestURL.pathname);
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, devices: agents.size }));
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(publicRoot, safePath);
    if (!filePath.startsWith(publicRoot)) throw new Error("Invalid path");
    const data = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.on("upgrade", (request, socket) => {
  const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const role = requestURL.pathname === "/agent" ? "agent" : requestURL.pathname === "/viewer" ? "viewer" : null;
  const key = request.headers["sec-websocket-key"];
  if (!role || !key || !authorized(requestURL)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));
  const peer = new WebSocketPeer(socket, role);
  if (role === "viewer") {
    viewers.add(peer);
    sendJSON(peer, { type: "devices", devices: deviceList() });
  }
});

server.listen(port, host, () => {
  const access = host === "0.0.0.0" ? "this computer's Tailscale/private IP" : host;
  console.log(`StikServer listening on http://${access}:${port}`);
  if (!token) console.warn("STIKSERVER_TOKEN is unset; only use this on a trusted private network.");
});
