const status = document.querySelector("#status");
const devicesElement = document.querySelector("#devices");
const empty = document.querySelector("#empty");
const screen = document.querySelector("#screen");
const placeholder = document.querySelector("#placeholder");
const shell = document.querySelector("#screen-shell");
const pairButton = document.querySelector("#pair");
const importPairingButton = document.querySelector("#import-pairing");
const pairingFileInput = document.querySelector("#pairing-file");
const pairingDialog = document.querySelector("#pairing-dialog");
const pairingStatus = document.querySelector("#pairing-status");
const pairingPin = document.querySelector("#pairing-pin");
const pairingPinHelp = document.querySelector("#pairing-pin-help");
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
let mirroringDevice = null;
const discoveryHelpTimer = setTimeout(() => {
  if (!knownDevices.length) {
    empty.textContent = "No devices found. On macOS, allow StikServer in System Settings › Privacy & Security › Local Network, then reopen the app. The iPhone or iPad must be on the same local network.";
  }
}, 8_000);

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
    if (message.type === "subscribed") handleSubscription(message.deviceId);
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
  if (devices.length) clearTimeout(discoveryHelpTimer);
  empty.hidden = devices.length > 0;
  if (!devices.length && empty.textContent.startsWith("No devices found")) {
    // Preserve the actionable permission message after the initial search timeout.
  } else if (!devices.length) {
    empty.textContent = "Searching the local network for iPhone and iPad devices…";
  }
  if (selectedDevice && !devices.some(device => device.id === selectedDevice)) selectDevice(null);
  const existing = new Map(
    [...devicesElement.querySelectorAll(".device[data-device-id]")]
      .map(button => [button.dataset.deviceId, button])
  );
  const orderedButtons = [];
  for (const device of devices) {
    let button = existing.get(device.id);
    if (!button) {
      button = document.createElement("button");
      button.innerHTML = `<span class="device-icon" aria-hidden="true"></span><span><strong></strong><small class="device-state"></small><small class="device-identifier"></small></span>`;
      button.addEventListener("click", () => selectDevice(button.dataset.deviceId));
    }
    button.className = `device${device.id === selectedDevice ? " selected" : ""}`;
    button.dataset.deviceId = device.id;
    const iconKind = device.kind === "iPad" ? "ipad" : "iphone";
    button.querySelector(".device-icon").className = `device-icon ${iconKind}`;
    button.querySelector("strong").textContent = device.name;
    button.querySelector(".device-state").textContent = device.controllable
      ? `${device.kind} · Ready`
      : `${device.kind} · Discovered locally`;
    const identifier = device.serviceIdentifier || device.pairingIdentifier || device.id;
    button.querySelector(".device-identifier").textContent = identifier;
    button.querySelector(".device-identifier").title = identifier;
    button.title = device.controllable ? "" : device.backendMessage || "Pair this device with StikServer";
    orderedButtons.push(button);
    existing.delete(device.id);
  }
  existing.values().forEach(button => button.remove());
  const currentOrder = [...devicesElement.children].map(button => button.dataset.deviceId);
  const desiredOrder = orderedButtons.map(button => button.dataset.deviceId);
  if (currentOrder.join("\u0000") !== desiredOrder.join("\u0000")) {
    orderedButtons.forEach(button => devicesElement.append(button));
  }
}

function selectDevice(id) {
  if (mirroringDevice && mirroringDevice !== id) stopMirroring();
  selectedDevice = id;
  currentOrientation = "portrait";
  clearCurrentFrame();
  applyScreenOrientation();
  const device = knownDevices.find(candidate => candidate.id === id);
  placeholder.hidden = false;
  pairButton.hidden = !device || device.mode !== "direct" || device.paired;
  importPairingButton.hidden = !device || device.mode !== "direct" || device.paired;
  if (device && !device.controllable) {
    placeholder.hidden = false;
    placeholder.querySelector("span").textContent = device.backendMessage || "Pair this device to control it";
  } else {
    placeholder.querySelector("span").textContent = id ? "Ready to view this device" : "Choose a connected device";
  }
  if (!id) {
    clearCurrentFrame();
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
  refreshTab(document.querySelector("[data-tool-tab].active")?.dataset.toolTab || "screen");
}

function handleSubscription(deviceId) {
  if (!selectedDevice || deviceId !== selectedDevice) return;
  placeholder.hidden = false;
  placeholder.querySelector("span").textContent = "Waiting for display…";
  mirroringDevice = deviceId;
  showStatus("Connected to device", true);
}

function displayFrame(blob) {
  if (!selectedDevice) return;
  const nextURL = URL.createObjectURL(blob);
  screen.onload = () => {
    if (currentFrameURL) URL.revokeObjectURL(currentFrameURL);
    currentFrameURL = nextURL;
    applyScreenOrientation();
    placeholder.hidden = true;
    showStatus("Viewing device", true);
  };
  screen.src = nextURL;
  screen.style.display = "block";
  applyScreenOrientation();
}

function normalizedPoint(event) {
  const imageRect = screen.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - imageRect.left) / imageRect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - imageRect.top) / imageRect.height))
  };
}

function applyScreenOrientation() {
  if (!screen.naturalWidth || !screen.naturalHeight || screen.style.display === "none") return;
  const landscape = currentOrientation === "landscapeLeft" || currentOrientation === "landscapeRight";
  const displayWidth = landscape ? screen.naturalHeight : screen.naturalWidth;
  const displayHeight = landscape ? screen.naturalWidth : screen.naturalHeight;
  const scale = Math.min(shell.clientWidth / displayWidth, shell.clientHeight / displayHeight);
  screen.style.width = `${screen.naturalWidth * scale}px`;
  screen.style.height = `${screen.naturalHeight * scale}px`;
  const rotation = currentOrientation === "landscapeRight" ? 90
    : currentOrientation === "landscapeLeft" ? -90
      : currentOrientation === "portraitUpsideDown" ? 180 : 0;
  screen.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
}

window.addEventListener("resize", applyScreenOrientation);

shell.addEventListener("pointerdown", event => {
  if (event.target.closest(".fullscreen-controls")) return;
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

document.querySelectorAll(".live-text").forEach(installLiveKeyboard);

function installLiveKeyboard(liveText) {
  let composingText = false;
  liveText.addEventListener("compositionstart", () => { composingText = true; });
  liveText.addEventListener("compositionend", event => {
    composingText = false;
    if (event.data) command("text", { text: event.data });
    liveText.value = "";
  });
  liveText.addEventListener("beforeinput", event => {
    if (composingText) return;
    if (event.inputType.startsWith("delete")) {
      event.preventDefault();
      command("backspace");
    } else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      event.preventDefault();
      command("text", { text: "\n" });
    } else if (event.data) {
      event.preventDefault();
      command("text", { text: event.data });
    }
    liveText.value = "";
  });
  liveText.addEventListener("paste", event => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text) command("text", { text });
  });
  liveText.addEventListener("input", () => {
    if (composingText || !liveText.value) return;
    command("text", { text: liveText.value });
    liveText.value = "";
  });
}

document.querySelectorAll("[data-fullscreen]").forEach(button => button.addEventListener("click", toggleFullscreen));

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen();
  } catch {
    showStatus("Fullscreen is unavailable in this browser", false);
  }
}

document.addEventListener("fullscreenchange", () => {
  applyScreenOrientation();
  document.querySelectorAll("[data-fullscreen]").forEach(button => {
    button.title = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-label", button.title);
  });
});

document.querySelectorAll("[data-screenshot]").forEach(button => button.addEventListener("click", () => {
  if (!currentFrameURL) return;
  const link = document.createElement("a");
  link.href = currentFrameURL;
  link.download = `stikserver-${selectedDevice || "device"}-${new Date().toISOString().replaceAll(":", "-")}.jpg`;
  link.click();
}));

document.querySelectorAll("[data-view-screen]").forEach(button => button.addEventListener("click", startMirroring));
document.querySelectorAll("[data-disconnect]").forEach(button => button.addEventListener("click", stopMirroring));

function startMirroring() {
  const device = knownDevices.find(candidate => candidate.id === selectedDevice);
  if (!device) return showStatus("Choose a device first", false);
  if (!device.controllable) return showStatus(device.backendMessage || "Pair this device first", false);
  placeholder.hidden = false;
  placeholder.querySelector("span").textContent = "Connecting to device…";
  send({ type: "subscribe", deviceId: device.id });
}

function stopMirroring() {
  send({ type: "unsubscribe" });
  mirroringDevice = null;
  clearCurrentFrame();
  placeholder.hidden = false;
  placeholder.querySelector("span").textContent = selectedDevice ? "Mirroring stopped" : "Choose a connected device";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function clearCurrentFrame() {
  if (currentFrameURL) URL.revokeObjectURL(currentFrameURL);
  currentFrameURL = null;
  screen.style.display = "none";
  screen.removeAttribute("src");
}

document.querySelectorAll("[data-focus-keyboard]").forEach(button => button.addEventListener("click", () => {
  const capture = document.querySelector("#remote-keyboard-capture");
  capture.value = "";
  capture.focus({ preventScroll: true });
}));

installFloatingControls();

function installFloatingControls() {
  const palette = document.querySelector("#fullscreen-controls");
  const toggle = document.querySelector("#toggle-fullscreen-controls");
  const handle = document.querySelector("#controls-drag-handle");
  toggle.addEventListener("click", () => {
    const expanded = palette.classList.toggle("expanded");
    toggle.querySelector("use")?.setAttribute("href", expanded ? "/icons.svg#chevron-down" : "/icons.svg#chevron-up");
    toggle.setAttribute("aria-label", expanded ? "Collapse controls" : "Expand controls");
  });
  let drag = null;
  handle.addEventListener("pointerdown", event => {
    const paletteRect = palette.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: paletteRect.left - shellRect.left, top: paletteRect.top - shellRect.top };
    palette.style.left = `${drag.left}px`;
    palette.style.top = `${drag.top}px`;
    palette.style.right = "auto";
    palette.style.bottom = "auto";
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", event => {
    if (!drag) return;
    const left = Math.min(Math.max(8, drag.left + event.clientX - drag.x), Math.max(8, shell.clientWidth - palette.offsetWidth - 8));
    const top = Math.min(Math.max(8, drag.top + event.clientY - drag.y), Math.max(8, shell.clientHeight - palette.offsetHeight - 8));
    palette.style.left = `${left}px`;
    palette.style.top = `${top}px`;
  });
  const endDrag = () => { drag = null; };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

pairButton.addEventListener("click", () => {
  if (!selectedDevice) return;
  pairingStatus.textContent = "Starting pairing…";
  pairingPin.hidden = true;
  pairingPinHelp.hidden = true;
  pairingDialog.showModal();
  send({ type: "pair", deviceId: selectedDevice });
});

document.querySelector("#cancel-pairing").addEventListener("click", () => {
  if (selectedDevice) send({ type: "pairCancel", deviceId: selectedDevice });
  pairingDialog.close();
});
pairingDialog.addEventListener("cancel", event => {
  event.preventDefault();
  if (selectedDevice) send({ type: "pairCancel", deviceId: selectedDevice });
  pairingDialog.close();
});

importPairingButton.addEventListener("click", () => pairingFileInput.click());
pairingFileInput.addEventListener("change", async () => {
  const file = pairingFileInput.files?.[0];
  const deviceId = selectedDevice;
  pairingFileInput.value = "";
  if (!file || !deviceId) return;
  if (file.size > 1024 * 1024) return showStatus("Pairing files must be smaller than 1 MB", false);
  showStatus("Validating pairing file…", false);
  try {
    const query = new URLSearchParams({ deviceId });
    if (token) query.set("token", token);
    const response = await fetch(`/api/pairing?${query}`, {
      method: "POST",
      headers: { "content-type": "application/x-plist" },
      body: file
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Pairing import failed");
    showStatus("Pairing file imported", true);
  } catch (error) {
    showStatus(error.message || "Pairing import failed", false);
  }
});

function handlePairing(message) {
  if (message.deviceId !== selectedDevice) return;
  const pairing = message.pairing;
  if (pairing.state === "advertising") {
    pairingStatus.textContent = "Waiting for the device to choose StikServer…";
  } else if (pairing.state === "showPin") {
    pairingStatus.textContent = "StikServer is ready to pair.";
    pairingPin.value = pairing.pin;
    pairingPin.textContent = pairing.pin;
    pairingPin.hidden = false;
    pairingPinHelp.hidden = false;
  } else if (pairing.state === "failed") {
    pairingStatus.textContent = pairing.message || "Pairing failed";
    showStatus(pairing.message || "Pairing failed", false);
  } else if (pairing.state === "ready") {
    pairingStatus.textContent = "Paired successfully.";
    showStatus("Device paired", true);
    setTimeout(() => pairingDialog.open && pairingDialog.close(), 900);
  } else if (pairing.state === "cancelled") {
    if (pairingDialog.open) pairingDialog.close();
  } else {
    pairingStatus.textContent = `Pairing: ${pairing.state}`;
  }
}

function showStatus(message, online) {
  status.textContent = message;
  status.classList.toggle("online", online);
}

if (window.stikDesktop) {
  configureRemoteLinkActions();
}

async function configureRemoteLinkActions() {
  const container = document.querySelector("#desktop-actions");
  const description = document.querySelector("#remote-link-description");
  const preferredButton = document.querySelector("#copy-remote-link");
  const lanButton = document.querySelector("#copy-lan-link");
  const bothButton = document.querySelector("#copy-both-links");
  container.hidden = false;

  let links;
  try { links = await window.stikDesktop.remoteLinks(); } catch {}
  if (!links?.preferred) {
    preferredButton.hidden = false;
    preferredButton.addEventListener("click", () => copyRemoteLink("preferred"));
    return;
  }

  preferredButton.hidden = false;
  preferredButton.textContent = links.tailscale ? "Copy Tailscale link" : "Copy local link";
  lanButton.hidden = !(links.tailscale && links.lan);
  bothButton.hidden = !(links.tailscale && links.lan);
  description.textContent = links.tailscale
    ? "Tailscale detected. Its private link is preferred for remote access."
    : "Copy the local-network link for another device on this network.";
  preferredButton.addEventListener("click", () => copyRemoteLink("preferred"));
  lanButton.addEventListener("click", () => copyRemoteLink("lan"));
  bothButton.addEventListener("click", () => copyRemoteLink("both"));
}

async function copyRemoteLink(kind) {
  const result = await window.stikDesktop.copyRemoteLink(kind);
  const label = result?.kind === "both" ? "both access links" : result?.kind === "tailscale" ? "Tailscale link" : "local link";
  showStatus(result?.url ? `Copied ${label}` : "No matching private-network address is available", Boolean(result?.url));
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
  } else if (event.type === "batteryAnalyticsError") {
    showStatus(event.message || "Could not read battery Analytics", false);
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
    refreshTab(button.dataset.toolTab);
  });
});

document.querySelectorAll("[data-refresh-tab]").forEach(button => {
  button.addEventListener("click", () => refreshTab(button.dataset.refreshTab, true));
});

function refreshTab(tab, manual = false) {
  if (!selectedDevice || tab === "screen" || tab === "location") return;
  if (tab === "overview") {
    command("deviceInfo");
    command("performance");
  } else if (tab === "processes") {
    command("processes");
  } else if (tab === "battery") {
    send({ type: "batteryHistory", deviceId: selectedDevice });
    command("batteryAnalytics");
  } else if (tab === "advanced") {
    command("configuration");
    command("conditions");
  }
  if (manual) showStatus("Refreshing…", true);
}

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
    emptyRow.textContent = runningProcesses.length ? "No matching processes." : "No process data yet.";
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
    label.textContent = "At least two Analytics samples are needed to show a health trend";
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
