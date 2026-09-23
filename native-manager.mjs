import { EventEmitter } from "node:events";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));

export function isPairingPlist(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 1024 * 1024) return false;
  if (bytes.subarray(0, 8).equals(Buffer.from("bplist00"))) return true;
  return bytes.toString("utf8", 0, Math.min(bytes.length, 512)).includes("<plist");
}

export class FramedRecordParser {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const type = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (length > 32 * 1024 * 1024) throw new Error("Native record is too large");
      if (this.buffer.length < 5 + length) return;
      const payload = Buffer.from(this.buffer.subarray(5, 5 + length));
      this.buffer = this.buffer.subarray(5 + length);
      this.onRecord(type, payload);
    }
  }
}

export class JpegParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        return;
      }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      this.onFrame(Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
  }
}

export class NativeDeviceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binary = options.binary || process.env.STIKSERVER_NATIVE || join(projectRoot, "native", "target", "release", "stikserver-native");
    this.ffmpeg = options.ffmpeg || process.env.STIKSERVER_FFMPEG || "ffmpeg";
    this.pairingDirectory = options.pairingDirectory || process.env.STIKSERVER_PAIRING_DIR || join(projectRoot, "pairings");
    this.sessions = new Map();
    this.pairingSessions = new Map();
    this.binaryAvailable = false;
    this.ffmpegAvailable = false;
  }

  async initialize() {
    await mkdir(this.pairingDirectory, { recursive: true, mode: 0o700 });
    this.binaryAvailable = await executable(this.binary);
    this.ffmpegAvailable = await commandAvailable(this.ffmpeg);
    this.emit("availability", this.availability());
  }

  availability() {
    return {
      nativeBackend: this.binaryAvailable,
      ffmpeg: this.ffmpegAvailable,
      ready: this.binaryAvailable && this.ffmpegAvailable,
      pairingDirectory: this.pairingDirectory,
      nativeBinary: this.binary
    };
  }

  pairingPath(device) {
    const identifier = String(device.serviceIdentifier || device.id).replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.pairingDirectory, `${identifier}.plist`);
  }

  async describe(device) {
    const pairingFile = this.pairingPath(device);
    const paired = await readable(pairingFile);
    const session = this.sessions.get(device.id);
    return {
      ...device,
      paired,
      controllable: paired && this.binaryAvailable && this.ffmpegAvailable,
      connected: Boolean(session && !session.stopped),
      backendMessage: !this.binaryAvailable
        ? "Build the native CoreDevice backend"
        : !this.ffmpegAvailable
          ? "FFmpeg is required for browser video"
          : !paired
            ? `Pairing identity not found: ${basename(pairingFile)}`
            : null
    };
  }

  async importPairing(device, bytes) {
    if (!this.binaryAvailable) throw new Error("Build the native CoreDevice backend before importing a pairing identity");
    if (!isPairingPlist(bytes)) throw new Error("Pairing identity must be an XML or binary plist between 32 bytes and 1 MB");
    const destination = this.pairingPath(device);
    const temporary = `${destination}.${process.pid}.upload`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await this.validatePairing(temporary);
      const tags = device.authenticationTags || [];
      if (tags.length) {
        const matches = await Promise.all(tags.map(authTag => this.matchesPairing(temporary, device.serviceIdentifier, authTag)));
        if (!matches.some(Boolean)) throw new Error("This pairing identity does not belong to the selected device");
      }
      await unlink(destination).catch(() => {});
      await rename(temporary, destination);
      this.emit("pairing", device.id, { state: "ready" });
      return destination;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  validatePairing(pairingFile) {
    return this.runPairingCheck(["validate", "--pairing", pairingFile], "Pairing validation");
  }

  matchesPairing(pairingFile, identifier, authTag) {
    return this.runPairingCheck([
      "match", "--pairing", pairingFile,
      "--identifier", String(identifier),
      "--auth-tag", String(authTag)
    ], "Pairing identity match").then(result => Boolean(result.matches));
  }

  runPairingCheck(commandArguments, label) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, commandArguments, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { errorOutput += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("exit", code => {
        if (code !== 0) return reject(new Error(errorOutput.trim() || `${label} exited with code ${code}`));
        try { resolve(JSON.parse(output)); }
        catch { reject(new Error(`${label} returned an invalid response`)); }
      });
    });
  }

  async start(device) {
    const existing = this.sessions.get(device.id);
    if (existing && !existing.stopped) return existing;
    const description = await this.describe(device);
    if (!description.controllable) throw new Error(description.backendMessage || "Device is not ready");

    const address = preferredAddress(device);
    if (!address) throw new Error("The discovered device has no reachable address");
    const native = spawn(this.binary, [
      "stream",
      "--host", address,
      "--port", String(device.port),
      "--pairing", this.pairingPath(device)
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = spawn(this.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "hevc", "-i", "pipe:0",
      "-an", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const session = { device, native, decoder, stopped: false, orientation: "unknown" };
    this.sessions.set(device.id, session);

    const records = new FramedRecordParser((type, payload) => {
      if (type === 1) {
        if (!decoder.stdin.destroyed) decoder.stdin.write(payload);
      } else if (type === 2) {
        try {
          const event = JSON.parse(payload.toString("utf8"));
          if (event.type === "orientation") session.orientation = event.orientation;
          this.emit("event", device.id, event);
        } catch (error) {
          this.emit("error", error);
        }
      }
    });
    const jpegs = new JpegParser(frame => this.emit("frame", device.id, frame));
    native.stdout.on("data", chunk => {
      try { records.push(chunk); } catch (error) { this.emit("error", error); this.stop(device.id); }
    });
    decoder.stdout.on("data", chunk => jpegs.push(chunk));
    native.stderr.on("data", chunk => this.emit("log", device.id, chunk.toString("utf8").trim()));
    decoder.stderr.on("data", chunk => this.emit("log", device.id, `decoder: ${chunk.toString("utf8").trim()}`));
    native.once("exit", (code, signal) => this.sessionEnded(device.id, `native backend exited (${code ?? signal})`));
    decoder.once("exit", (code, signal) => this.sessionEnded(device.id, `decoder exited (${code ?? signal})`));
    this.emit("session", device.id, true);
    return session;
  }

  async startPairing(device) {
    if (!this.binaryAvailable) throw new Error("Build the native CoreDevice backend before pairing");
    const existing = this.pairingSessions.get(device.id);
    if (existing) return;
    const address = preferredAddress(device);
    if (!address) throw new Error("The discovered device has no reachable address");
    const output = this.pairingPath(device);
    const child = spawn(this.binary, [
      "pair",
      "--host", address,
      "--port", String(device.port),
      "--output", output
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const pairing = { child, output, stdout: "", stderr: "" };
    this.pairingSessions.set(device.id, pairing);
    this.emit("pairing", device.id, { state: "connecting" });
    child.stdout.on("data", chunk => {
      pairing.stdout += chunk.toString("utf8");
      let newline;
      while ((newline = pairing.stdout.indexOf("\n")) >= 0) {
        const line = pairing.stdout.slice(0, newline).trim();
        pairing.stdout = pairing.stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "paired") this.emit("pairing", device.id, { state: "paired" });
        } catch { this.emit("log", device.id, `pairing: ${line}`); }
      }
    });
    child.stderr.on("data", chunk => {
      pairing.stderr += chunk.toString("utf8");
      if (pairing.stderr.includes("PIN_REQUIRED")) {
        pairing.stderr = pairing.stderr.replace("PIN_REQUIRED", "");
        this.emit("pairing", device.id, { state: "pinRequired" });
      }
    });
    child.once("error", error => this.finishPairing(device.id, error));
    child.once("exit", code => {
      if (code === 0) this.finishPairing(device.id, null);
      else this.finishPairing(device.id, new Error(`Pairing process exited with code ${code}`));
    });
  }

  submitPairingPin(deviceId, pin) {
    const pairing = this.pairingSessions.get(deviceId);
    if (!pairing || pairing.child.stdin.destroyed) throw new Error("No pairing request is waiting for a PIN");
    if (!/^\d{4,8}$/.test(pin)) throw new Error("Enter the numeric PIN shown by the device");
    pairing.child.stdin.write(`${pin}\n`);
    this.emit("pairing", deviceId, { state: "verifying" });
  }

  finishPairing(deviceId, error) {
    const pairing = this.pairingSessions.get(deviceId);
    if (!pairing) return;
    this.pairingSessions.delete(deviceId);
    if (error) this.emit("pairing", deviceId, { state: "failed", message: error.message });
    else this.emit("pairing", deviceId, { state: "ready" });
  }

  send(deviceId, command) {
    const session = this.sessions.get(deviceId);
    if (!session || session.stopped || session.native.stdin.destroyed) throw new Error("Device session is not active");
    session.native.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop(deviceId) {
    const session = this.sessions.get(deviceId);
    if (!session || session.stopped) return;
    session.stopped = true;
    if (!session.native.stdin.destroyed) session.native.stdin.write('{"command":"stop"}\n');
    session.native.kill("SIGTERM");
    session.decoder.kill("SIGTERM");
    this.sessions.delete(deviceId);
    this.emit("session", deviceId, false);
  }

  stopAll() {
    for (const deviceId of [...this.sessions.keys()]) this.stop(deviceId);
    for (const pairing of this.pairingSessions.values()) pairing.child.kill("SIGTERM");
    this.pairingSessions.clear();
  }

  sessionEnded(deviceId, message) {
    const session = this.sessions.get(deviceId);
    if (!session || session.stopped) return;
    this.emit("log", deviceId, message);
    this.stop(deviceId);
  }
}

async function executable(target) {
  if (target.includes("/")) {
    try { await access(target, constants.X_OK); return true; }
    catch { return false; }
  }
  return commandAvailable(target);
}

async function readable(target) {
  try { await access(target, constants.R_OK); return true; }
  catch { return false; }
}

function commandAvailable(command) {
  return new Promise(resolve => {
    const child = spawn(command, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", code => resolve(code === 0));
  });
}

export function preferredAddress(device) {
  const addresses = device.addresses || [];
  // Raw link-local IPv6 addresses require an interface scope (for example %en0).
  // Bonjour's IPv4 answer is therefore the safest direct endpoint. A scoped IPv6
  // address or the resolvable .local host remain valid fallbacks.
  return addresses.find(address => !address.includes(":"))
    || addresses.find(address => address.includes("%"))
    || device.host
    || addresses[0];
}
