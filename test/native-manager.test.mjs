import assert from "node:assert/strict";
import test from "node:test";
import { FramedRecordParser, JpegParser, preferredAddress } from "../native-manager.mjs";

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
});
