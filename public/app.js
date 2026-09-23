const status = document.querySelector("#status");
const devicesElement = document.querySelector("#devices");
const empty = document.querySelector("#empty");
const screen = document.querySelector("#screen");
const placeholder = document.querySelector("#placeholder");
const shell = document.querySelector("#screen-shell");
const token = new URLSearchParams(location.search).get("token") || localStorage.getItem("stikserver-token") || "";
if (token) localStorage.setItem("stikserver-token", token);

let socket;
let selectedDevice = null;
let currentFrameURL = null;
let retryDelay = 500;
let pointerDown = null;

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
  };
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function renderDevices(devices) {
  devicesElement.replaceChildren();
  empty.hidden = devices.length > 0;
  if (selectedDevice && !devices.some(device => device.id === selectedDevice)) selectDevice(null);
  for (const device of devices) {
    const button = document.createElement("button");
    button.className = `device${device.id === selectedDevice ? " selected" : ""}`;
    button.dataset.deviceId = device.id;
    button.innerHTML = `<span class="device-icon">${device.kind === "iPad" ? "▭" : "▯"}</span><span><strong></strong><small></small></span>`;
    button.querySelector("strong").textContent = device.name;
    button.querySelector("small").textContent = `${device.kind} · Connected`;
    button.addEventListener("click", () => selectDevice(device.id));
    devicesElement.append(button);
  }
}

function selectDevice(id) {
  selectedDevice = id;
  send({ type: "subscribe", deviceId: id });
  placeholder.hidden = Boolean(id);
  if (!id) {
    screen.style.display = "none";
    screen.removeAttribute("src");
  }
  for (const button of devicesElement.children) {
    button.classList.toggle("selected", button.dataset.deviceId === id);
  }
}

function displayFrame(blob) {
  if (!selectedDevice) return;
  const nextURL = URL.createObjectURL(blob);
  screen.onload = () => {
    if (currentFrameURL) URL.revokeObjectURL(currentFrameURL);
    currentFrameURL = nextURL;
  };
  screen.src = nextURL;
  screen.style.display = "block";
  placeholder.hidden = true;
}

function normalizedPoint(event) {
  const imageRect = screen.getBoundingClientRect();
  const naturalRatio = (screen.naturalWidth || imageRect.width) / (screen.naturalHeight || imageRect.height);
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

document.querySelector("#fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Some mobile browsers only permit fullscreen video; the responsive layout remains usable.
  }
});

connect();
