import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatteryHistoryStore, batteryMeasurement } from "../battery-history.mjs";

test("normalizes modern percentage battery diagnostics", () => {
  assert.deepEqual(batteryMeasurement({ GasGauge: { CycleCount: 321, FullChargeCapacity: 89, Temperature: 3125 } }), {
    health: 89,
    cycles: 321,
    temperature: 31.25,
    fullCapacity: 89,
    designCapacity: null
  });
});

test("calculates battery health from capacities", () => {
  const measurement = batteryMeasurement({ FullChargeCapacity: 2400, DesignCapacity: 3000 });
  assert.equal(measurement.health, 80);
});

test("merges Analytics history by source without losing older samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stikserver-battery-"));
  const store = new BatteryHistoryStore(directory);
  await store.merge("device", [
    { sourceName: "Analytics-2026-01-01.ips", date: "2026-01-01", health: 95, cycles: 100 },
    { sourceName: "Analytics-2026-02-01.ips", date: "2026-02-01", health: 94, cycles: 120 }
  ]);
  await store.merge("device", [
    { sourceName: "Analytics-2026-02-01.ips", date: "2026-02-01", health: 93, cycles: 121 },
    { sourceName: "Analytics-2026-03-01.ips", date: "2026-03-01", health: 92, cycles: 140 }
  ]);
  const history = await store.list("device");
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(item => item.health), [95, 93, 92]);
  assert.doesNotReject(() => readFile(join(directory, "device.json"), "utf8"));
});
