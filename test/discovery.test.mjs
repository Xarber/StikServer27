import assert from "node:assert/strict";
import test from "node:test";
import { discoveryQuery, parseDNSPacket, parseDnsSdZoneLine, RemotePairingDiscovery } from "../discovery.mjs";

function name(value) {
  const chunks = value.split(".").flatMap(label => {
    const bytes = [...Buffer.from(label)];
    return [bytes.length, ...bytes];
  });
  return Buffer.from([...chunks, 0]);
}

function record(owner, type, ttl, data) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(ttl, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), header, data]);
}

test("builds a PTR discovery query", () => {
  const query = discoveryQuery();
  assert.equal(query.readUInt16BE(4), 1);
  assert.match(query.toString("latin1"), /remotepairing/);
});

test("parses and publishes a remote-pairing service", () => {
  const service = "_remotepairing._tcp.local";
  const instance = `ABC.${service}`;
  const host = "ipad.local";
  const ptr = record(service, 12, 120, name(instance));
  const srvPrefix = Buffer.alloc(6);
  srvPrefix.writeUInt16BE(49152, 4);
  const srv = record(instance, 33, 120, Buffer.concat([srvPrefix, name(host)]));
  const txtValue = Buffer.from("identifier=ABC");
  const txt = record(instance, 16, 120, Buffer.concat([Buffer.from([txtValue.length]), txtValue]));
  const address = record(host, 1, 120, Buffer.from([192, 168, 1, 20]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(4, 6);
  const records = parseDNSPacket(Buffer.concat([header, ptr, srv, txt, address]));
  const discovery = new RemotePairingDiscovery();
  discovery.consume(records);
  assert.deepEqual(discovery.devices()[0], {
    id: "direct:192.168.1.20",
    pairingIdentifier: "192.168.1.20",
    serviceIdentifier: "ABC",
    pairingCandidates: [{ identifier: "ABC", authenticationTags: [] }],
    name: "ipad",
    kind: "iPad",
    model: "",
    host,
    port: 49152,
    addresses: ["192.168.1.20"],
    authenticationTags: [],
    mode: "direct",
    connected: false,
    controllable: false
  });
});

test("groups rotating advertisements for the same physical device", () => {
  const discovery = new RemotePairingDiscovery();
  discovery.hostAddresses.set("ipad.local", new Map([["192.168.1.20", Date.now() + 60_000]]));
  discovery.instances.set("first", {
    instance: `OLD._remotepairing._tcp.local`, target: "ipad.local", port: 49152,
    txt: { identifier: "OLD", authTag: "old-tag", model: "iPad16,6" }, expiresAt: Date.now() + 30_000
  });
  discovery.instances.set("second", {
    instance: `NEW._remotepairing._tcp.local`, target: "ipad.local", port: 49153,
    txt: { identifier: "NEW", authTag: "new-tag", model: "iPad16,6" }, expiresAt: Date.now() + 60_000
  });
  const devices = discovery.devices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "direct:192.168.1.20");
  assert.equal(devices[0].port, 49153);
  assert.deepEqual(devices[0].authenticationTags.sort(), ["new-tag", "old-tag"]);
  assert.equal(devices[0].pairingCandidates.length, 2);
});

test("ignores unrelated Bonjour SRV and TXT records", () => {
  const discovery = new RemotePairingDiscovery();
  discovery.consume([
    { name: "Living Room._googlecast._tcp.local", type: 33, ttl: 120, value: { port: 8009, target: "tv.local" } },
    { name: "Living Room._googlecast._tcp.local", type: 16, ttl: 120, value: { identifier: "NOT-IOS" } },
    { name: "MacBook._rfb._tcp.local", type: 33, ttl: 120, value: { port: 5900, target: "macbook.local" } },
    { name: "Router._adisk._tcp.local", type: 33, ttl: 120, value: { port: 445, target: "router.local" } }
  ]);
  assert.deepEqual(discovery.devices(), []);
});

test("parses the macOS dns-sd zone fallback", () => {
  const service = "29A701C5-6F4F-401C-B531-E6B8D05B5FC8._remotepairing._tcp";
  assert.deepEqual(
    parseDnsSdZoneLine(`${service} SRV 0 0 49152 Xarbers-iPad-Air-M2.local.`),
    {
      name: `${service}.local`,
      type: 33,
      ttl: 30,
      value: { priority: 0, weight: 0, port: 49152, target: "Xarbers-iPad-Air-M2.local" }
    }
  );
  assert.deepEqual(
    parseDnsSdZoneLine(`${service} TXT "identifier=device-id" "authTag=abc123" "flags=0"`),
    {
      name: `${service}.local`,
      type: 16,
      ttl: 30,
      value: { identifier: "device-id", authTag: "abc123", flags: "0" }
    }
  );
  assert.equal(parseDnsSdZoneLine("_googlecast._tcp PTR unrelated"), null);
});
