import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { RemotePairingDiscovery } from "./discovery.mjs";
import { NativeDeviceManager } from "./native-manager.mjs";
import { BatteryHistoryStore } from "./battery-history.mjs";

const host = process.env.STIKSERVER_HOST || "127.0.0.1";
const port = Number(process.env.STIKSERVER_PORT || 8765);
const token = process.env.STIKSERVER_TOKEN || "";
const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
const agents = new Map();
const viewers = new Set();
const discovery = new RemotePairingDiscovery();
const nativeDevices = new NativeDeviceManager();
const batteryHistoryRoot = process.env.STIKSERVER_DATA_DIR || fileURLToPath(new URL("./data/battery-history/", import.meta.url));
const batteryHistory = new BatteryHistoryStore(batteryHistoryRoot);
let directDevices = [];
let rawDirectDevices = [];

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
  const key = device => device.serviceIdentifier || device.pairingIdentifier || device.id;
  const routes = new Map(directDevices.map(device => [key(device), device]));
  for (const { metadata } of agents.values()) {
    const routeKey = key(metadata);
    const current = routes.get(routeKey);
    // Prefer StikServer's own paired LAN connection (zero relay hops). If its
    // direct discovery is not paired, use the shortest ready StikDebug route.
    if (current?.mode === "direct" && current.controllable) continue;
    if (!current || !current.controllable || Number(metadata.routeHops || 1) < Number(current.routeHops || Infinity)) {
      routes.set(routeKey, metadata);
    }
  }
  return [...routes.values()];
}

function sendJSON(peer, value) {
  peer.send(Buffer.from(JSON.stringify(value)), 0x1);
}

function publishDevices() {
  const message = { type: "devices", devices: deviceList() };
  for (const viewer of viewers) sendJSON(viewer, message);
}

function readRequestBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let failed = false;
    request.on("data", chunk => {
      if (failed) return;
      length += chunk.length;
      if (length > limit) {
        failed = true;
        reject(Object.assign(new Error("Pairing file exceeds the 1 MB limit"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    request.once("error", reject);
  });
}

function jsonResponse(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
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
    this.subscriptionRequest = 0;
    this.commandDevices = new Set();
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
        modelIdentifier: String(message.device.modelIdentifier || ""),
        serviceIdentifier: String(message.device.serviceIdentifier || "") || null,
        pairingIdentifier: String(message.device.pairingIdentifier || "") || null,
        paired: message.device.paired !== false,
        routeHops: Math.max(1, Number(message.device.routeHops || 1)),
        width: Number(message.device.width || 0),
        height: Number(message.device.height || 0),
        connected: true,
        controllable: true,
        mode: "relay"
      };
      agents.set(id, { peer: this, metadata });
      sendJSON(this, { type: "registered", deviceId: id });
      publishDevices();
      return;
    }
    if (message.type === "deviceEvent" && this.deviceId) {
      for (const viewer of viewers) {
        if (viewer.subscription === this.deviceId || viewer.commandDevices.has(this.deviceId)) {
          sendJSON(viewer, { ...message, deviceId: this.deviceId });
        }
      }
      if (message.event?.type === "batteryAnalytics" && Array.isArray(message.event.history)) {
        batteryHistory.merge(this.deviceId, message.event.history).then(history => {
          for (const viewer of viewers) {
            if (viewer.subscription === this.deviceId || viewer.commandDevices.has(this.deviceId)) {
              sendJSON(viewer, { type: "deviceEvent", deviceId: this.deviceId, event: { type: "batteryHistory", history } });
            }
          }
        }).catch(error => console.warn(`Relayed battery history: ${error.message}`));
      }
      return;
    }
    if (message.type === "relayError" && this.deviceId) {
      for (const viewer of viewers) {
        if (viewer.subscription === this.deviceId || viewer.commandDevices.has(this.deviceId)) {
          sendJSON(viewer, { type: "error", deviceId: this.deviceId, command: message.command, message: message.message || "Relayed command failed" });
        }
      }
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
      const requestNumber = ++this.subscriptionRequest;
      const previousSubscription = this.subscription;
      const id = String(message.deviceId || "");
      if (agents.has(id)) {
        this.subscription = id;
        sendJSON(agents.get(id).peer, { type: "subscribe", deviceId: id });
        sendJSON(this, { type: "subscribed", deviceId: id });
        stopDeviceIfUnused(previousSubscription);
        return;
      }
      const direct = directDevices.find(device => device.id === id && device.controllable);
      if (!direct) {
        this.subscription = null;
        sendJSON(this, { type: "subscribed", deviceId: null });
        stopDeviceIfUnused(previousSubscription);
        return;
      }
      nativeDevices.start(direct).then(() => {
        if (this.closed || this.subscriptionRequest !== requestNumber) {
          stopDirectIfUnused(id);
          return;
        }
        this.subscription = id;
        sendJSON(this, { type: "subscribed", deviceId: id });
        stopDeviceIfUnused(previousSubscription);
        refreshDirectDevices();
      }).catch(error => sendJSON(this, { type: "error", message: error.message }));
      return;
    }
    if (message.type === "unsubscribe") {
      this.subscriptionRequest += 1;
      const previousSubscription = this.subscription;
      this.subscription = null;
      sendJSON(this, { type: "subscribed", deviceId: null });
      stopDeviceIfUnused(previousSubscription);
      return;
    }
    if (message.type === "command") {
      const id = String(message.deviceId || this.subscription || "");
      const agent = agents.get(id)?.peer;
      if (!agent) {
        const direct = directDevices.find(device => device.id === id);
        if (!direct) return sendJSON(this, { type: "error", message: "Device is offline" });
        this.commandDevices.add(id);
        nativeDevices.start(direct)
          .then(() => nativeDevices.send(id, message))
          .catch(error => sendJSON(this, { type: "error", message: error.message }));
        return;
      }
      this.commandDevices.add(id);
      sendJSON(agent, { ...message, deviceId: id });
      return;
    }
    if (message.type === "pair") {
      const id = String(message.deviceId || "");
      const direct = directDevices.find(device => device.id === id);
      if (!direct) return sendJSON(this, { type: "error", message: "Device is no longer available" });
      nativeDevices.startPairing(direct).catch(error => sendJSON(this, { type: "error", message: error.message }));
      return;
    }
    if (message.type === "pairCancel") {
      nativeDevices.cancelPairing(String(message.deviceId || ""));
      return;
    }
    if (message.type === "batteryHistory") {
      const id = String(message.deviceId || this.subscription || "");
      batteryHistory.list(id)
        .then(history => sendJSON(this, { type: "deviceEvent", deviceId: id, event: { type: "batteryHistory", history } }))
        .catch(error => sendJSON(this, { type: "error", message: error.message }));
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
    const previousSubscription = this.subscription;
    viewers.delete(this);
    if (this.deviceId && agents.get(this.deviceId)?.peer === this) {
      agents.delete(this.deviceId);
      publishDevices();
    }
    this.deviceId = null;
    this.subscription = null;
    const commandDevices = [...this.commandDevices];
    this.commandDevices.clear();
    stopDeviceIfUnused(previousSubscription);
    commandDevices.forEach(stopDeviceIfUnused);
  }
}

function stopDeviceIfUnused(deviceId) {
  if (!deviceId) return;
  const agent = agents.get(deviceId)?.peer;
  if (agent) {
    const isStreaming = [...viewers].some(viewer => !viewer.closed && viewer.subscription === deviceId);
    if (!isStreaming) sendJSON(agent, { type: "unsubscribe", deviceId });
    return;
  }
  const isUsed = [...viewers].some(viewer => !viewer.closed && (
    viewer.subscription === deviceId || viewer.commandDevices.has(deviceId)
  ));
  if (isUsed) return;
  nativeDevices.stop(deviceId);
}

function stopDirectIfUnused(deviceId) {
  if (!deviceId || agents.has(deviceId)) return;
  if ([...viewers].some(viewer => !viewer.closed && viewer.subscription === deviceId)) return;
  if ([...viewers].some(viewer => !viewer.closed && viewer.commandDevices.has(deviceId))) return;
  nativeDevices.stop(deviceId);
}

const server = createServer(async (request, response) => {
  try {
    const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(requestURL.pathname);
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: true,
        controllableDevices: agents.size,
        discoveredDevices: directDevices.length,
        viewers: viewers.size,
        native: nativeDevices.availability()
      }));
      return;
    }
    if (pathname === "/api/pairing" && request.method === "POST") {
      if (!authorized(requestURL)) return jsonResponse(response, 401, { ok: false, message: "Unauthorized" });
      const id = String(requestURL.searchParams.get("deviceId") || "");
      const device = rawDirectDevices.find(candidate => candidate.id === id);
      if (!device) return jsonResponse(response, 404, { ok: false, message: "Device is no longer available" });
      const contentLength = Number(request.headers["content-length"] || 0);
      if (contentLength > 1024 * 1024) return jsonResponse(response, 413, { ok: false, message: "Pairing file exceeds the 1 MB limit" });
      const body = await readRequestBody(request);
      await nativeDevices.importPairing(device, body);
      await refreshDirectDevices();
      return jsonResponse(response, 200, { ok: true });
    }
    if (pathname === "/api/pairing" && request.method === "GET") {
      if (!authorized(requestURL)) return jsonResponse(response, 401, { ok: false, message: "Unauthorized" });
      const id = String(requestURL.searchParams.get("deviceId") || "");
      const device = rawDirectDevices.find(candidate => candidate.id === id);
      if (!device) return jsonResponse(response, 404, { ok: false, message: "Only devices paired directly with StikServer can be exported" });
      const exported = await nativeDevices.exportPairing(device);
      response.writeHead(200, {
        "content-type": "application/x-plist",
        "content-disposition": `attachment; filename="${exported.filename.replace(/["\\]/g, "-")}"`,
        "content-length": exported.bytes.length,
        "cache-control": "no-store"
      });
      response.end(exported.bytes);
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
  } catch (error) {
    if (!response.headersSent && request.url?.startsWith("/api/")) {
      jsonResponse(response, Number(error.statusCode || 400), { ok: false, message: error.message || "Request failed" });
    } else if (!response.headersSent) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
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

export const serverReady = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.removeListener("error", reject);
    const access = host === "0.0.0.0" ? "this computer's Tailscale/private IP" : host;
    console.log(`StikServer listening on http://${access}:${port}`);
    if (!token) console.warn("STIKSERVER_TOKEN is unset; only use this on a trusted private network.");
    nativeDevices.initialize()
      .then(() => refreshDirectDevices())
      .catch(error => console.warn(`Native backend: ${error.message}`));
    discovery.start();
    resolve({ host, port });
  });
});

discovery.on("changed", devices => {
  rawDirectDevices = devices;
  refreshDirectDevices();
});
discovery.on("error", error => console.warn(`Device discovery: ${error.message}`));
nativeDevices.on("frame", (deviceId, frame) => {
  for (const viewer of viewers) {
    if (viewer.subscription === deviceId) viewer.send(frame);
  }
});
nativeDevices.on("event", (deviceId, event) => {
  for (const viewer of viewers) {
    if (viewer.subscription === deviceId || viewer.commandDevices.has(deviceId)) {
      sendJSON(viewer, { type: "deviceEvent", deviceId, event });
    }
  }
  if (event.type === "batteryAnalytics") {
    batteryHistory.merge(deviceId, event.history).then(history => {
      for (const viewer of viewers) {
        if (viewer.subscription === deviceId || viewer.commandDevices.has(deviceId)) {
          sendJSON(viewer, { type: "deviceEvent", deviceId, event: { type: "batteryHistory", history } });
        }
      }
    }).catch(error => console.warn(`Battery Analytics history: ${error.message}`));
  } else if (event.type === "battery") {
    batteryHistory.record(deviceId, event.data).then(history => {
      for (const viewer of viewers) {
        if (viewer.subscription === deviceId || viewer.commandDevices.has(deviceId)) {
          sendJSON(viewer, { type: "deviceEvent", deviceId, event: { type: "batteryHistory", history } });
        }
      }
    }).catch(error => console.warn(`Battery history: ${error.message}`));
  }
});
nativeDevices.on("session", () => refreshDirectDevices());
nativeDevices.on("availability", () => refreshDirectDevices());
nativeDevices.on("pairing", (deviceId, pairing) => {
  for (const viewer of viewers) sendJSON(viewer, { type: "pairing", deviceId, pairing });
  if (pairing.state === "ready" || pairing.state === "paired") refreshDirectDevices();
});
nativeDevices.on("log", (deviceId, message) => {
  if (message) console.log(`[${deviceId}] ${message}`);
});
nativeDevices.on("error", error => console.warn(`Native backend: ${error.message}`));

let directRefreshGeneration = 0;
async function refreshDirectDevices() {
  const generation = ++directRefreshGeneration;
  const descriptions = await Promise.all(rawDirectDevices.map(device => nativeDevices.describe(device)));
  if (generation !== directRefreshGeneration) return;
  directDevices = descriptions;
  publishDevices();
}

export function stopServer() {
  discovery.stop();
  nativeDevices.stopAll();
  for (const viewer of [...viewers]) viewer.close(1001, "StikServer is shutting down");
  for (const { peer } of agents.values()) peer.close(1001, "StikServer is shutting down");
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

if (process.env.STIKSERVER_EMBEDDED !== "1") {
  const shutdownProcess = () => stopServer().finally(() => process.exit(0));
  process.once("SIGINT", shutdownProcess);
  process.once("SIGTERM", shutdownProcess);
}
