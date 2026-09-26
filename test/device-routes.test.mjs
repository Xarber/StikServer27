import test from "node:test";
import assert from "node:assert/strict";
import { selectDeviceRoutes } from "../device-routes.mjs";

test("matches a SideStore relay to a direct route using either identity", () => {
  const direct = { id: "native|bonjour", serviceIdentifier: "bonjour", pairingIdentifier: "udid", mode: "direct", controllable: true };
  const relay = { id: "sidestore-agent|udid", serviceIdentifier: "other", pairingIdentifier: "UDID", mode: "relay", controllable: true };
  assert.deepEqual(selectDeviceRoutes([direct, relay]), [direct]);
  assert.deepEqual(selectDeviceRoutes([relay, direct]), [direct]);
});
test("uses a ready relay when direct discovery is unpaired without merging names", () => {
  const direct = { id: "a", serviceIdentifier: "device-a", name: "iPad", controllable: false };
  const relay = { id: "relay-a", serviceIdentifier: "device-a", controllable: true };
  const other = { id: "b", name: "iPad", controllable: true };
  assert.deepEqual(selectDeviceRoutes([direct, relay, other]), [relay, other]);
});
