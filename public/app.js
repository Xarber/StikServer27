const status = document.querySelector("#status");
const devicesElement = document.querySelector("#devices");
const empty = document.querySelector("#empty");
const screen = document.querySelector("#screen");
const placeholder = document.querySelector("#placeholder");
const shell = document.querySelector("#screen-shell");
const pairButton = document.querySelector("#pair");
const token = new URLSearchParams(location.search).get("token") || localStorage.getItem("stikserver-token") || "";
if (token) localStorage.setItem("stikserver-token", token);

let socket;
let selectedDevice = null;
let currentFrameURL = null;
let retryDelay = 500;
let pointerDown = null;
let knownDevices = [];
let currentOrientation = "portrait";
let runningProcesses = [];
let latestBattery = null;
let batterySamples = [];

function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${scheme}//${location.host}/viewer?token=${encodeURIComponent(token)}`);
  socket.binaryType = "blob";
  status.textContent = "Connecting";
  status.classList.remove("online");
  socket.onopen = () => {
    retryDelay = 500;
    status.textContent = "Connected";
    status.classList.add("online");
  };
  socket.onclose = () => {
    status.textContent = "Reconnecting";
    status.classList.remove("online");
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 1.7, 5000);
  };
  socket.onmessage = event => {
    if (event.data instanceof Blob) return displayFrame(event.data);
    const message = JSON.parse(event.data);
    if (message.type === "devices") renderDevices(message.devices);
    if (message.type === "pairing") handlePairing(message);
    if (message.type === "deviceEvent" && message.deviceId === selectedDevice) {
      if (message.event?.type === "orientation") {
        currentOrientation = message.event.orientation;
        applyScreenOrientation();
      }
      handleDeviceEvent(message.event);
    }
    if (message.type === "error") showStatus(message.message, false);
  };
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function renderDevices(devices) {
  knownDevices = devices;
  devicesElement.replaceChildren();
  empty.hidden = devices.length > 0;
  if (selectedDevice && !devices.some(device => device.id === selectedDevice)) selectDevice(null);
  for (const device of devices) {
    const button = document.createElement("button");
    button.className = `device${device.id === selectedDevice ? " selected" : ""}`;
    button.dataset.deviceId = device.id;
    button.innerHTML = `<span class="device-icon">${device.kind === "iPad" ? "▭" : "▯"}</span><span><strong></strong><small></small></span>`;
    button.querySelector("strong").textContent = device.name;
    button.querySelector("small").textContent = device.controllable
      ? `${device.kind} · Ready`
      : `${device.kind} · Discovered locally`;
    if (!device.controllable) button.title = device.backendMessage || "Pair this device with StikServer";
    button.addEventListener("click", () => selectDevice(device.id));
    devicesElement.append(button);
  }
}

function selectDevice(id) {
  selectedDevice = id;
  currentOrientation = "portrait";
  applyScreenOrientation();
  const device = knownDevices.find(candidate => candidate.id === id);
  send({ type: "subscribe", deviceId: device?.controllable ? id : null });
  placeholder.hidden = Boolean(device?.controllable);
  pairButton.hidden = !device || device.mode !== "direct" || device.paired;
  if (device && !device.controllable) {
    placeholder.hidden = false;
    placeholder.querySelector("span").textContent = device.backendMessage || "Pair this device to control it";
  } else {
    placeholder.querySelector("span").textContent = id ? "Connecting to device…" : "Choose a connected device";
  }
  if (!id) {
    screen.style.display = "none";
    screen.removeAttribute("src");
  }
  for (const button of devicesElement.children) {
    button.classList.toggle("selected", button.dataset.deviceId === id);
  }
  runningProcesses = [];
  latestBattery = null;
  batterySamples = [];
  renderProcesses();
  renderBatteryHistory();
  if (id) send({ type: "batteryHistory", deviceId: id });
}

function displayFrame(blob) {
  if (!selectedDevice) return;
  const nextURL = URL.createObjectURL(blob);
  screen.onload = () => {
    if (currentFrameURL) URL.revokeObjectURL(currentFrameURL);
    currentFrameURL = nextURL;
    applyScreenOrientation();
  };
  screen.src = nextURL;
  screen.style.display = "block";
  placeholder.hidden = true;
  applyScreenOrientation();
}

function normalizedPoint(event) {
  const imageRect = screen.getBoundingClientRect();
  const landscape = currentOrientation === "landscapeLeft" || currentOrientation === "landscapeRight";
  const naturalWidth = landscape ? screen.naturalHeight : screen.naturalWidth;
  const naturalHeight = landscape ? screen.naturalWidth : screen.naturalHeight;
  const naturalRatio = (naturalWidth || imageRect.width) / (naturalHeight || imageRect.height);
  const boxRatio = imageRect.width / imageRect.height;
  let width = imageRect.width;
  let height = imageRect.height;
  let left = imageRect.left;
  let top = imageRect.top;
  if (boxRatio > naturalRatio) {
    width = height * naturalRatio;
    left += (imageRect.width - width) / 2;
  } else {
    height = width / naturalRatio;
    top += (imageRect.height - height) / 2;
  }
  return {
    x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
    y: Math.max(0, Math.min(1, (event.clientY - top) / height))
  };
}

function applyScreenOrientation() {
  const landscape = currentOrientation === "landscapeLeft" || currentOrientation === "landscapeRight";
  if (landscape) {
    screen.style.width = `${shell.clientHeight}px`;
    screen.style.height = `${shell.clientWidth}px`;
    screen.style.maxHeight = "none";
    screen.style.transform = currentOrientation === "landscapeRight" ? "rotate(90deg)" : "rotate(-90deg)";
  } else {
    screen.style.width = "100%";
    screen.style.height = "100%";
    screen.style.maxHeight = "";
    screen.style.transform = currentOrientation === "portraitUpsideDown" ? "rotate(180deg)" : "none";
  }
}

window.addEventListener("resize", applyScreenOrientation);

shell.addEventListener("pointerdown", event => {
  if (!selectedDevice || screen.style.display === "none") return;
  shell.setPointerCapture(event.pointerId);
  pointerDown = normalizedPoint(event);
  send({ type: "command", deviceId: selectedDevice, command: "touch", phase: "down", ...pointerDown });
});
shell.addEventListener("pointermove", event => {
  if (!pointerDown || !selectedDevice) return;
  send({ type: "command", deviceId: selectedDevice, command: "touch", phase: "move", ...normalizedPoint(event) });
});
shell.addEventListener("pointerup", event => {
  if (!pointerDown || !selectedDevice) return;
  send({ type: "command", deviceId: selectedDevice, command: "touch", phase: "up", ...normalizedPoint(event) });
  pointerDown = null;
});
shell.addEventListener("pointercancel", () => { pointerDown = null; });

document.querySelectorAll("[data-command]").forEach(button => {
  button.addEventListener("click", () => send({
    type: "command",
    deviceId: selectedDevice,
    command: button.dataset.command
  }));
});

document.querySelector("#text-input").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#text");
  if (!selectedDevice || !input.value) return;
  send({ type: "command", deviceId: selectedDevice, command: "text", text: input.value });
  input.value = "";
});

document.querySelector("#fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Some mobile browsers only permit fullscreen video; the responsive layout remains usable.
  }
});

document.querySelector("#screenshot").addEventListener("click", () => {
  if (!currentFrameURL) return;
  const link = document.createElement("a");
  link.href = currentFrameURL;
  link.download = `stikserver-${selectedDevice || "device"}-${new Date().toISOString().replaceAll(":", "-")}.jpg`;
  link.click();
});

document.querySelector("#disconnect-device").addEventListener("click", () => {
  send({ type: "unsubscribe" });
  if (currentFrameURL) URL.revokeObjectURL(currentFrameURL);
  currentFrameURL = null;
  screen.style.display = "none";
  screen.removeAttribute("src");
  placeholder.hidden = false;
  placeholder.querySelector("span").textContent = "Disconnected. Choose the device again to reconnect.";
});

pairButton.addEventListener("click", () => {
  if (selectedDevice) send({ type: "pair", deviceId: selectedDevice });
});

function handlePairing(message) {
  if (message.deviceId !== selectedDevice) return;
  const pairing = message.pairing;
  if (pairing.state === "pinRequired") {
    const pin = window.prompt("Enter the PIN shown on the iPhone or iPad:");
    if (pin) send({ type: "pairPin", deviceId: selectedDevice, pin: pin.trim() });
  } else if (pairing.state === "failed") {
    showStatus(pairing.message || "Pairing failed", false);
  } else {
    showStatus(`Pairing: ${pairing.state}`, pairing.state === "ready");
  }
}

function showStatus(message, online) {
  status.textContent = message;
  status.classList.toggle("online", online);
}

function command(command, fields = {}) {
  if (!selectedDevice) return showStatus("Choose a device first", false);
  send({ type: "command", deviceId: selectedDevice, command, ...fields });
}

function handleDeviceEvent(event) {
  if (!event?.type || event.type === "orientation" || event.type === "ready") return;
  if (event.type === "processes") {
    runningProcesses = event.processes || [];
    renderProcesses();
  } else if (event.type === "battery") {
    latestBattery = batteryMeasurement(event.data || {});
    renderBatteryHistory();
  } else if (event.type === "batteryHistory") {
    batterySamples = Array.isArray(event.history) ? event.history : [];
    renderBatteryHistory();
  } else if (event.type === "conditions") {
    renderConditions(event.groups || []);
    document.querySelector("#advanced-output").textContent = pretty(event);
  } else if (event.type === "configuration") {
    applyConfiguration(event);
    document.querySelector("#advanced-output").textContent = pretty(event);
  } else if (["deviceInfo", "performance", "diagnostics", "energy", "graphics", "networkActivity"].includes(event.type)) {
    document.querySelector("#overview-output").textContent = pretty(event);
  } else if (event.type === "commandResult") {
    showStatus(event.ok ? `${event.command} completed` : event.message || `${event.command} failed`, event.ok);
    if (event.ok && ["killProcess", "signalProcess"].includes(event.command)) command("processes");
  }
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

document.querySelectorAll("[data-tool-tab]").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-tool-tab]").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll("[data-tool-panel]").forEach(panel => panel.classList.toggle("active", panel.dataset.toolPanel === button.dataset.toolTab));
  });
});

document.querySelectorAll("[data-action]").forEach(button => {
  button.addEventListener("click", () => command(button.dataset.action));
});

document.querySelector("#energy-form").addEventListener("submit", event => {
  event.preventDefault();
  const pids = document.querySelector("#energy-pids").value.split(",").map(value => Number.parseInt(value.trim(), 10)).filter(value => Number.isInteger(value) && value > 0);
  if (!pids.length) return showStatus("Enter at least one process ID", false);
  command("energy", { pids });
});

document.querySelector("#process-filter").addEventListener("input", renderProcesses);

function renderProcesses() {
  const list = document.querySelector("#process-list");
  const query = document.querySelector("#process-filter").value.trim().toLowerCase();
  const matches = runningProcesses.filter(process => `${process.pid} ${process.name} ${process.realAppName}`.toLowerCase().includes(query));
  list.replaceChildren();
  if (!matches.length) {
    const emptyRow = document.createElement("p");
    emptyRow.className = "muted";
    emptyRow.textContent = runningProcesses.length ? "No matching processes." : "Load the running process list to begin.";
    list.append(emptyRow);
    return;
  }
  for (const process of matches) {
    const row = document.createElement("div");
    row.className = "process-row";
    const pid = document.createElement("small");
    pid.textContent = String(process.pid);
    const name = document.createElement("span");
    name.textContent = process.realAppName || process.name || "Unknown process";
    name.title = process.name || "";
    const terminate = document.createElement("button");
    terminate.type = "button";
    terminate.textContent = "Terminate";
    terminate.addEventListener("click", () => {
      if (window.confirm(`Terminate ${name.textContent} (${process.pid})?`)) command("killProcess", { pid: process.pid });
    });
    row.append(pid, name, terminate);
    list.append(row);
  }
}

document.querySelector("#location-form").addEventListener("submit", event => {
  event.preventDefault();
  command("setLocation", {
    latitude: Number(document.querySelector("#latitude").value),
    longitude: Number(document.querySelector("#longitude").value)
  });
});
document.querySelector("#clear-location").addEventListener("click", () => command("clearLocation"));

document.querySelectorAll("[data-command-value]").forEach(button => {
  button.addEventListener("click", () => {
    const [name, value] = button.dataset.commandValue.split(":");
    command(name, { style: value });
  });
});
document.querySelectorAll("[data-toggle-command]").forEach(input => {
  input.addEventListener("change", () => command(input.dataset.toggleCommand, { enabled: input.checked }));
});
document.querySelector("#apply-text-size").addEventListener("click", () => command("setTextSize", { size: document.querySelector("#text-size").value }));
document.querySelector("#apply-glass").addEventListener("click", () => command("setLiquidGlassOpacity", { value: Number(document.querySelector("#glass-opacity").value) }));
document.querySelector("#apply-color-filter").addEventListener("click", () => {
  const filterType = document.querySelector("#color-filter").value;
  command("setColorFilter", {
    enabled: Boolean(filterType),
    filterType: filterType || null,
    value: Number(document.querySelector("#color-filter-intensity").value)
  });
});
document.querySelector("#enable-condition").addEventListener("click", () => {
  const value = document.querySelector("#condition-profile").value;
  if (!value) return showStatus("Choose a condition profile", false);
  const [groupIdentifier, profileIdentifier] = value.split("\u0000");
  command("enableCondition", { groupIdentifier, profileIdentifier });
});
document.querySelector("#disable-condition").addEventListener("click", () => command("disableCondition"));
document.querySelectorAll("[data-danger-command]").forEach(button => {
  button.addEventListener("click", () => {
    const action = button.dataset.dangerCommand;
    if (window.confirm(`${button.textContent} the selected device now?`)) command(action);
  });
});

function applyConfiguration(configuration) {
  if (configuration.textSize) document.querySelector("#text-size").value = configuration.textSize;
  if (configuration.colorFilter) {
    document.querySelector("#color-filter").value = configuration.colorFilter.enabled ? configuration.colorFilter.type || "Grayscale" : "";
    if (configuration.colorFilter.intensity != null) document.querySelector("#color-filter-intensity").value = configuration.colorFilter.intensity;
  }
  const toggles = {
    setReduceMotion: configuration.reduceMotion,
    setReduceTransparency: configuration.reduceTransparency,
    setShowBorders: configuration.showBorders
  };
  for (const [name, value] of Object.entries(toggles)) {
    const input = document.querySelector(`[data-toggle-command="${name}"]`);
    if (input && typeof value === "boolean") input.checked = value;
  }
}

function renderConditions(groups) {
  const select = document.querySelector("#condition-profile");
  select.replaceChildren(new Option("Choose a condition profile", ""));
  for (const group of groups) {
    const optionGroup = document.createElement("optgroup");
    optionGroup.label = group.identifier;
    for (const profile of group.profiles || []) {
      optionGroup.append(new Option(profile.description || profile.identifier, `${group.identifier}\u0000${profile.identifier}`));
    }
    select.append(optionGroup);
  }
}

function batteryHistory() {
  return batterySamples;
}

function batteryMeasurement(data) {
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
  const full = number("FullChargeCapacity", "AppleRawMaxCapacity", "NominalChargeCapacity");
  const design = number("DesignCapacity", "AppleRawDesignCapacity");
  const reported = number("MaximumCapacityPercent", "BatteryHealthMetric", "StateOfHealth");
  const health = reported ?? (full != null && full <= 100 ? full : full != null && design ? full / design * 100 : null);
  let temperature = number("Temperature", "BatteryTemperature", "VirtualTemperature");
  if (temperature != null && temperature > 1000) temperature /= 100;
  else if (temperature != null && temperature > 100) temperature /= 10;
  return { health: finite(health), cycles: finite(cycles), temperature: finite(temperature), fullCapacity: finite(full), designCapacity: finite(design) };
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function renderBatteryHistory() {
  const history = selectedDevice ? batteryHistory() : [];
  const latest = latestBattery || history.at(-1) || {};
  const metrics = document.querySelector("#battery-metrics");
  metrics.replaceChildren();
  for (const [label, value] of [
    ["Health", latest.health == null ? "—" : `${latest.health.toFixed(1)}%`],
    ["Cycles", latest.cycles == null ? "—" : Math.round(latest.cycles)],
    ["Temperature", latest.temperature == null ? "—" : `${latest.temperature.toFixed(1)} °C`],
    ["Measurements", history.length]
  ]) {
    const card = document.createElement("div");
    card.className = "metric";
    const small = document.createElement("small"); small.textContent = label;
    const strong = document.createElement("strong"); strong.textContent = String(value);
    card.append(small, strong); metrics.append(card);
  }
  renderBatteryChart(history);
  renderBatteryInsights(history);
}

function renderBatteryChart(history) {
  const svg = document.querySelector("#battery-chart");
  svg.replaceChildren();
  const points = history.filter(item => Number.isFinite(item.health));
  if (points.length < 2) {
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "300"); label.setAttribute("y", "92"); label.setAttribute("text-anchor", "middle"); label.setAttribute("fill", "#888693");
    label.textContent = "Record at least two measurements to show a health trend";
    svg.append(label); return;
  }
  const min = Math.min(70, ...points.map(point => point.health)) - 2;
  const max = Math.max(100, ...points.map(point => point.health)) + 2;
  const coordinates = points.map((point, index) => {
    const x = 24 + index / (points.length - 1) * 552;
    const y = 156 - (point.health - min) / Math.max(1, max - min) * 132;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", coordinates); line.setAttribute("fill", "none"); line.setAttribute("stroke", "#7d73ff"); line.setAttribute("stroke-width", "4"); line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
}

function renderBatteryInsights(history) {
  const element = document.querySelector("#battery-insights");
  element.replaceChildren();
  const health = history.filter(item => Number.isFinite(item.health));
  const messages = [];
  if (health.length > 1) {
    const change = health.at(-1).health - health[0].health;
    messages.push(`Maximum capacity changed by ${change >= 0 ? "+" : ""}${change.toFixed(1)} points across ${health.length} measurements.`);
    const cycleDelta = health.at(-1).cycles - health[0].cycles;
    if (Number.isFinite(cycleDelta) && cycleDelta > 0) messages.push(`Observed change: ${(change / cycleDelta * 100).toFixed(2)} points per 100 cycles.`);
  } else messages.push("More measurements are needed before StikServer can calculate a trend.");
  const temperatures = history.map(item => item.temperature).filter(Number.isFinite);
  if (temperatures.length) messages.push(Math.max(...temperatures) >= 35 ? "At least one warm battery measurement was recorded." : "Recorded battery temperatures stayed below 35 °C.");
  for (const message of messages) { const row = document.createElement("div"); row.textContent = message; element.append(row); }
}

connect();
