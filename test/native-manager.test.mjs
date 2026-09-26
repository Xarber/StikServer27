import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { FramedRecordParser, JpegParser, NativeDeviceManager, isPairingPlist, pairingExportFilename, preferredAddress, videoDecoderArguments } from "../native-manager.mjs";

test("parses split native records", () => {
  const records = [];
  const parser = new FramedRecordParser((type, payload) => records.push([type, payload.toString()]));
  const payload = Buffer.from("hello");
  const header = Buffer.alloc(5);
  header[0] = 2;
  header.writeUInt32BE(payload.length, 1);
  const packet = Buffer.concat([header, payload]);
  parser.push(packet.subarray(0, 3));
  parser.push(packet.subarray(3));
  assert.deepEqual(records, [[2, "hello"]]);
});

test("extracts consecutive JPEG frames", () => {
  const frames = [];
  const parser = new JpegParser(frame => frames.push([...frame]));
  parser.push(Buffer.from([0, 0xff, 0xd8, 1, 0xff]));
  parser.push(Buffer.from([0xd9, 0xff, 0xd8, 2, 0xff, 0xd9]));
  assert.deepEqual(frames, [
    [0xff, 0xd8, 1, 0xff, 0xd9],
    [0xff, 0xd8, 2, 0xff, 0xd9]
  ]);
});

test("prefers a directly reachable Bonjour address", () => {
  assert.equal(preferredAddress({
    host: "ipad.local",
    addresses: ["fe80::1234", "192.168.1.20"]
  }), "192.168.1.20");
  assert.equal(preferredAddress({
    host: "ipad.local",
    addresses: ["fe80::1234%en0"]
  }), "fe80::1234%en0");
  assert.equal(preferredAddress({ host: "ipad.local", addresses: ["fe80::1234"] }), "ipad.local");
  assert.equal(preferredAddress({ name: "Xarber's iPad Air M2", addresses: [] }), "Xarbers-iPad-Air-M2.local");
});

test("recognizes bounded XML and binary pairing plists", () => {
  const xml = Buffer.from(`${" ".repeat(32)}<?xml version="1.0"?><plist><dict/></plist>`);
  const binary = Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(24)]);
  assert.equal(isPairingPlist(xml), true);
  assert.equal(isPairingPlist(binary), true);
  assert.equal(isPairingPlist(Buffer.from("not a pairing identity")), false);
  assert.equal(isPairingPlist(Buffer.alloc(1024 * 1024 + 1)), false);
});

test("names exported pairing identities after the device and model", () => {
  assert.equal(
    pairingExportFilename({ name: "Xarber's iPad Air M4", modelIdentifier: "iPad14,3" }),
    "xarbers-ipad-air-m4.ipad14,3.plist"
  );
});

test("leaves display orientation to the live SpringBoard transform", () => {
  const arguments_ = videoDecoderArguments();
  assert.ok(arguments_.includes("-noautorotate"));
  assert.ok(arguments_.indexOf("-noautorotate") < arguments_.indexOf("-i"));
});

test("lets the native backend release screen capture before terminating it", async () => {
  const manager = new NativeDeviceManager();
  const commands = [];
  const native = new EventEmitter();
  native.exitCode = null;
  native.signalCode = null;
  native.killed = false;
  native.kill = () => { native.killed = true; };
  native.stdin = {
    destroyed: false, writableEnded: false, writable: true,
    write(payload, callback) { commands.push(payload); callback?.(); }
  };
  const decoder = {
    exitCode: null, signalCode: null, killed: false,
    kill() { this.killed = true; }
  };
  let resolveStopped;
  const session = {
    native, decoder, stopped: false, stopTimer: null,
    stoppedPromise: new Promise(resolve => { resolveStopped = resolve; }),
    resolveStopped
  };
  manager.sessions.set("device", session);

  const stopped = manager.stop("device");
  assert.deepEqual(commands, ['{"command":"stop"}\n']);
  assert.equal(native.killed, false);
  native.exitCode = 0;
  manager.sessionEnded("device", session, "native", "native backend exited (0)");
  await stopped;

  assert.equal(decoder.killed, true);
  assert.equal(manager.sessions.has("device"), false);
});

test("stops and restarts media without closing the command session", () => {
  const manager = new NativeDeviceManager();
  const commands = [];
  const session = {
    stopped: false,
    mediaActive: true,
    native: {
      exitCode: null,
      signalCode: null,
      stdin: {
        destroyed: false, writableEnded: false, writable: true,
        write(payload, callback) { commands.push(payload); callback?.(); }
      }
    }
  };
  manager.sessions.set("device", session);

  manager.stopMedia("device");
  assert.equal(session.mediaActive, false);
  manager.startMedia("device");
  assert.equal(session.mediaActive, true);
  assert.deepEqual(commands, [
    '{"command":"stopMedia"}\n',
    '{"command":"startMedia"}\n'
  ]);
});
