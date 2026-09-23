import assert from "node:assert/strict";
import test from "node:test";
import { discoveryQuery, parseDNSPacket, RemotePairingDiscovery } from "../discovery.mjs";

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
    id: "direct:ABC",
    serviceIdentifier: "ABC",
    name: "Nearby iOS Device",
    kind: "iOS Device",
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
