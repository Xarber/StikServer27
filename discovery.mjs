import dgram from "node:dgram";
import { EventEmitter } from "node:events";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE = "_remotepairing._tcp.local";

function readName(packet, start, depth = 0) {
  if (depth > 20) throw new Error("DNS compression loop");
  const labels = [];
  let offset = start;
  let nextOffset = start;
  let jumped = false;
  while (offset < packet.length) {
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("Truncated DNS pointer");
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1];
      if (!jumped) nextOffset = offset + 2;
      labels.push(readName(packet, pointer, depth + 1).name);
      jumped = true;
      break;
    }
    offset += 1;
    if (length === 0) {
      if (!jumped) nextOffset = offset;
      break;
    }
    if (offset + length > packet.length) throw new Error("Truncated DNS label");
    labels.push(packet.subarray(offset, offset + length).toString("utf8"));
    offset += length;
    if (!jumped) nextOffset = offset;
  }
  return { name: labels.filter(Boolean).join("."), offset: nextOffset };
}

function ipv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  return groups.join(":");
}

export function parseDNSPacket(packet) {
  if (packet.length < 12) throw new Error("Truncated DNS header");
  const questionCount = packet.readUInt16BE(4);
  const answerCount = packet.readUInt16BE(6);
  const authorityCount = packet.readUInt16BE(8);
  const additionalCount = packet.readUInt16BE(10);
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    offset = readName(packet, offset).offset + 4;
    if (offset > packet.length) throw new Error("Truncated DNS question");
  }

  const records = [];
  for (let index = 0; index < answerCount + authorityCount + additionalCount; index += 1) {
    const owner = readName(packet, offset);
    offset = owner.offset;
    if (offset + 10 > packet.length) throw new Error("Truncated DNS record");
    const type = packet.readUInt16BE(offset);
    const ttl = packet.readUInt32BE(offset + 4);
    const length = packet.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    const end = dataOffset + length;
    if (end > packet.length) throw new Error("Truncated DNS data");
    let value;
    if (type === 1 && length === 4) {
      value = [...packet.subarray(dataOffset, end)].join(".");
    } else if (type === 28 && length === 16) {
      value = ipv6(packet.subarray(dataOffset, end));
    } else if (type === 12) {
      value = readName(packet, dataOffset).name;
    } else if (type === 33 && length >= 6) {
      value = {
        priority: packet.readUInt16BE(dataOffset),
        weight: packet.readUInt16BE(dataOffset + 2),
        port: packet.readUInt16BE(dataOffset + 4),
        target: readName(packet, dataOffset + 6).name
      };
    } else if (type === 16) {
      value = {};
      let cursor = dataOffset;
      while (cursor < end) {
        const textLength = packet[cursor];
        cursor += 1;
        const text = packet.subarray(cursor, Math.min(cursor + textLength, end)).toString("utf8");
        cursor += textLength;
        const equals = text.indexOf("=");
        if (equals >= 0) value[text.slice(0, equals)] = text.slice(equals + 1);
        else if (text) value[text] = true;
      }
    }
    records.push({ name: owner.name, type, ttl, value });
    offset = end;
  }
  return records;
}

function encodeName(name) {
  const chunks = [];
  for (const label of name.split(".")) {
    const bytes = Buffer.from(label);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

export function discoveryQuery() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(12, 0);
  question.writeUInt16BE(1, 2);
  return Buffer.concat([header, encodeName(SERVICE), question]);
}

export class RemotePairingDiscovery extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.timer = null;
    this.expiryTimer = null;
    this.instances = new Map();
    this.hostAddresses = new Map();
  }

  start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", error => this.emit("error", error));
    socket.on("message", packet => {
      try { this.consume(parseDNSPacket(packet)); }
      catch (error) { this.emit("packetError", error); }
    });
    socket.bind(MDNS_PORT, () => {
      try { socket.addMembership(MDNS_ADDRESS); }
      catch (error) { this.emit("error", error); }
      socket.setMulticastTTL(255);
      this.query();
    });
    this.timer = setInterval(() => this.query(), 5_000);
    this.expiryTimer = setInterval(() => this.expire(), 2_000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.expiryTimer);
    this.timer = null;
    this.expiryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.instances.clear();
    this.hostAddresses.clear();
  }

  query() {
    if (!this.socket) return;
    this.socket.send(discoveryQuery(), MDNS_PORT, MDNS_ADDRESS);
  }

  consume(records) {
    const now = Date.now();
    for (const record of records) {
      if ((record.type === 1 || record.type === 28) && record.value) {
        const current = this.hostAddresses.get(record.name) || new Map();
        current.set(record.value, now + Math.max(record.ttl, 1) * 1_000);
        this.hostAddresses.set(record.name, current);
      }
    }

    for (const record of records) {
      if (record.type === 12 && record.name.toLowerCase() === SERVICE && record.value) {
        const current = this.instances.get(record.value) || { instance: record.value, txt: {} };
        current.expiresAt = now + Math.max(record.ttl, 1) * 1_000;
        this.instances.set(record.value, current);
      } else if (record.type === 33 && record.value) {
        const current = this.instances.get(record.name) || { instance: record.name, txt: {} };
        current.target = record.value.target;
        current.port = record.value.port;
        current.expiresAt = now + Math.max(record.ttl, 1) * 1_000;
        this.instances.set(record.name, current);
      } else if (record.type === 16 && record.value) {
        const current = this.instances.get(record.name) || { instance: record.name, txt: {} };
        current.txt = { ...current.txt, ...record.value };
        current.expiresAt = now + Math.max(record.ttl, 1) * 1_000;
        this.instances.set(record.name, current);
      }
    }
    this.publish();
  }

  expire() {
    const now = Date.now();
    let changed = false;
    for (const [name, instance] of this.instances) {
      if ((instance.expiresAt || 0) <= now) {
        this.instances.delete(name);
        changed = true;
      }
    }
    for (const [host, addresses] of this.hostAddresses) {
      for (const [address, expiresAt] of addresses) {
        if (expiresAt <= now) addresses.delete(address);
      }
      if (!addresses.size) this.hostAddresses.delete(host);
    }
    if (changed) this.publish();
  }

  devices() {
    const groups = new Map();
    for (const instance of this.instances.values()) {
      if (!instance.target || !instance.port) continue;
      const addresses = [...(this.hostAddresses.get(instance.target)?.keys() || [])];
      const stableIdentifier = instance.txt.udid || instance.txt.deviceIdentifier || instance.txt.serialNumber;
      const physicalKey = stableIdentifier || addresses.find(address => !address.includes(":")) || instance.target;
      const current = groups.get(physicalKey) || [];
      current.push({ instance, addresses });
      groups.set(physicalKey, current);
    }

    return [...groups.entries()].map(([physicalKey, advertisements]) => {
      advertisements.sort((left, right) => (right.instance.expiresAt || 0) - (left.instance.expiresAt || 0));
      const latest = advertisements[0].instance;
      const identifiers = advertisements.map(({ instance }) => instance.txt.identifier || instance.instance.replace(`.${SERVICE}`, ""));
      const pairingCandidates = advertisements.map(({ instance }) => ({
        identifier: instance.txt.identifier || instance.instance.replace(`.${SERVICE}`, ""),
        authenticationTags: Object.entries(instance.txt)
          .filter(([key]) => key === "authTag" || key.startsWith("authTag"))
          .map(([, value]) => String(value))
      }));
      const model = advertisements.map(({ instance }) => instance.txt.model).find(Boolean) || "";
      const hostHint = String(latest.target || "").toLowerCase();
      const kind = model.startsWith("iPad") || hostHint.includes("ipad")
        ? "iPad"
        : model.startsWith("iPhone") || hostHint.includes("iphone")
          ? "iPhone"
          : "iOS Device";
      const addresses = [...new Set(advertisements.flatMap(advertisement => advertisement.addresses))];
      const advertisedName = advertisements.map(({ instance }) => instance.txt.name).find(Boolean);
      const hostName = String(latest.target || "").replace(/\.local\.?$/i, "").replaceAll("-", " ");
      return {
        id: `direct:${physicalKey}`,
        pairingIdentifier: physicalKey,
        serviceIdentifier: identifiers[0],
        pairingCandidates,
        name: advertisedName || hostName || `Nearby ${kind}`,
        kind,
        model,
        host: latest.target,
        port: latest.port,
        addresses,
        authenticationTags: [...new Set(pairingCandidates.flatMap(candidate => candidate.authenticationTags))],
        mode: "direct",
        connected: false,
        controllable: false
      };
    });
  }

  publish() {
    this.emit("changed", this.devices());
  }
}
