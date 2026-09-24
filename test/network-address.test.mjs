import assert from "node:assert/strict";
import test from "node:test";
import { networkAddresses, privateAddresses } from "../desktop/network-address.mjs";

test("prefers a physical LAN interface over virtual bridges", () => {
  const addresses = privateAddresses({
    bridge0: [{ family: "IPv4", internal: false, address: "192.168.234.1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.19" }],
    utun4: [{ family: "IPv4", internal: false, address: "100.94.102.4" }]
  });
  assert.deepEqual(addresses, ["192.168.1.19", "100.94.102.4", "192.168.234.1"]);
});

test("ignores public and loopback addresses", () => {
  assert.deepEqual(privateAddresses({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [{ family: "IPv4", internal: false, address: "8.8.8.8" }]
  }), []);
});

test("identifies Tailscale separately from the local network", () => {
  assert.deepEqual(networkAddresses({
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.19" }],
    utun4: [{ family: "IPv4", internal: false, address: "100.94.102.4" }]
  }), {
    tailscale: ["100.94.102.4"],
    lan: ["192.168.1.19"],
    all: ["192.168.1.19", "100.94.102.4"]
  });
});

test("does not mistake an unrelated 100.x physical interface for Tailscale", () => {
  const addresses = networkAddresses({
    eth0: [{ family: "IPv4", internal: false, address: "100.94.102.4" }]
  });
  assert.deepEqual(addresses.tailscale, []);
});
