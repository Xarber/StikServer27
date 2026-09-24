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
      await this.write(deviceId, history);
      return history;
    });
    this.queues.set(deviceId, next);
    next.finally(() => { if (this.queues.get(deviceId) === next) this.queues.delete(deviceId); });
    return next;
  }

  merge(deviceId, incoming) {
    const previous = this.queues.get(deviceId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const history = await this.list(deviceId);
      const bySource = new Map(history.filter(item => item?.sourceName).map(item => [item.sourceName, item]));
      const withoutSource = history.filter(item => !item?.sourceName);
      for (const item of Array.isArray(incoming) ? incoming : []) {
        const sample = analyticsMeasurement(item);
        if (sample) bySource.set(sample.sourceName, sample);
      }
      const merged = [...withoutSource, ...bySource.values()].sort((left, right) =>
        String(left.date || "").localeCompare(String(right.date || ""))
      );
      await this.write(deviceId, merged);
      return merged;
    });
    this.queues.set(deviceId, next);
    next.finally(() => { if (this.queues.get(deviceId) === next) this.queues.delete(deviceId); });
    return next;
  }

  async write(deviceId, history) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(deviceId);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  path(deviceId) {
    const safe = String(deviceId).replace(/[^a-zA-Z0-9._-]/g, "_");
    return join(this.directory, `${safe}.json`);
  }
}

function analyticsMeasurement(value) {
  if (!value || typeof value !== "object" || typeof value.sourceName !== "string" || !value.sourceName) return null;
  const sample = {
    date: validDate(value.date),
    health: optionalNumber(value.health),
    cycles: optionalNumber(value.cycles),
    temperature: optionalNumber(value.temperature),
    fullCapacity: optionalNumber(value.fullCapacity),
    designCapacity: optionalNumber(value.designCapacity),
    sourceName: value.sourceName
  };
  return [sample.health, sample.cycles, sample.fullCapacity].some(item => item != null) ? sample : null;
}

function validDate(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function optionalNumber(value) {
  return value == null || value === "" ? null : finite(Number(value));
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}
