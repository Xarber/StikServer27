import assert from "node:assert/strict";
import test from "node:test";
import { batteryMeasurement } from "../battery-history.mjs";

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
