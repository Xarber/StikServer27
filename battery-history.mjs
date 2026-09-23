import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function batteryMeasurement(data) {
  const entries = [];
  const walk = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "number") entries.push([key.toLowerCase(), child]);
      else walk(child);
    }
  };
  walk(data);
  const number = (...names) => entries.find(([key]) => names.some(name => key === name.toLowerCase()))?.[1] ?? null;
  const cycles = number("CycleCount", "cycle_count", "last_value_CycleCount");
  const fullCapacity = number("FullChargeCapacity", "AppleRawMaxCapacity", "NominalChargeCapacity");
  const designCapacity = number("DesignCapacity", "AppleRawDesignCapacity");
  const reported = number("MaximumCapacityPercent", "BatteryHealthMetric", "StateOfHealth");
  const health = reported ?? (fullCapacity != null && fullCapacity <= 100
    ? fullCapacity
    : fullCapacity != null && designCapacity ? fullCapacity / designCapacity * 100 : null);
  let temperature = number("Temperature", "BatteryTemperature", "VirtualTemperature");
  if (temperature != null && temperature > 1000) temperature /= 100;
  else if (temperature != null && temperature > 100) temperature /= 10;
  return {
    health: finite(health),
    cycles: finite(cycles),
    temperature: finite(temperature),
    fullCapacity: finite(fullCapacity),
    designCapacity: finite(designCapacity)
  };
}

export class BatteryHistoryStore {
  constructor(directory) {
    this.directory = directory;
    this.queues = new Map();
  }

  async list(deviceId) {
    try {
      const data = JSON.parse(await readFile(this.path(deviceId), "utf8"));
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  record(deviceId, rawData) {
    const previous = this.queues.get(deviceId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const measurement = batteryMeasurement(rawData);
      if (Object.values(measurement).every(value => value == null)) return this.list(deviceId);
      const history = await this.list(deviceId);
      history.push({ ...measurement, date: new Date().toISOString() });
      const trimmed = history.slice(-1000);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.path(deviceId);
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, destination);
      return trimmed;
    });
    this.queues.set(deviceId, next);
    next.finally(() => { if (this.queues.get(deviceId) === next) this.queues.delete(deviceId); });
    return next;
  }

  path(deviceId) {
    const safe = String(deviceId).replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.directory, `${safe}.json`);
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}
