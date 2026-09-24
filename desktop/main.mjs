import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import ffmpegStatic from "ffmpeg-static";
import { networkAddresses } from "./network-address.mjs";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(desktopRoot);
let mainWindow;
let stopServer;
let quitting = false;

app.setName("StikServer");
if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(startDesktop).catch(error => {
  dialog.showErrorBox("StikServer could not start", error.stack || error.message);
  app.quit();
});

async function startDesktop() {
  const userData = app.getPath("userData");
  await mkdir(userData, { recursive: true });
  const token = await persistentToken(join(userData, "access-token"));
  const port = process.env.STIKSERVER_PORT || "8765";
  process.env.STIKSERVER_EMBEDDED = "1";
  process.env.STIKSERVER_HOST = process.env.STIKSERVER_HOST || "0.0.0.0";
  process.env.STIKSERVER_PORT = port;
  process.env.STIKSERVER_TOKEN = token;
  process.env.STIKSERVER_PAIRING_DIR = join(userData, "pairings");
  process.env.STIKSERVER_DATA_DIR = join(userData, "battery-history");
  process.env.STIKSERVER_FFMPEG = unpackedPath(ffmpegStatic);
  if (app.isPackaged) {
    const nativeName = process.platform === "win32" ? "stikserver-native.exe" : "stikserver-native";
    process.env.STIKSERVER_NATIVE = join(process.resourcesPath, "native", nativeName);
    if (process.platform !== "win32") await chmod(process.env.STIKSERVER_NATIVE, 0o755).catch(() => {});
  }

  const serverModule = await import("../server.mjs");
  stopServer = serverModule.stopServer;
  await serverModule.serverReady;

  mainWindow = new BrowserWindow({
    width: 1260,
    height: 900,
    minWidth: 760,
    minHeight: 620,
    title: "StikServer",
    backgroundColor: "#08080c",
    webPreferences: {
      preload: join(desktopRoot, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault();
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
}

ipcMain.handle("stikserver:remote-links", () => remoteLinks());

ipcMain.handle("stikserver:copy-remote-link", (_event, kind = "preferred") => {
  const links = remoteLinks();
  if (kind === "both" && links.tailscale && links.lan) {
    const value = `Tailscale: ${links.tailscale.url}\nLocal network: ${links.lan.url}`;
    clipboard.writeText(value);
    return { url: value, kind, links };
  }
  const selected = kind === "lan"
    ? links.lan
    : kind === "tailscale"
      ? links.tailscale
      : links.preferred;
  if (!selected) return { url: null, kind, links };
  const url = selected.url;
  clipboard.writeText(url);
  return { url, kind: selected.kind, links };
});

app.on("before-quit", async event => {
  if (quitting || !stopServer) return;
  event.preventDefault();
  quitting = true;
  await stopServer().catch(() => {});
  app.quit();
});

app.on("window-all-closed", () => app.quit());

async function persistentToken(path) {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const token = randomBytes(24).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function unpackedPath(path) {
  return path?.replace("app.asar", "app.asar.unpacked");
}

function remoteLinks() {
  const addresses = networkAddresses(networkInterfaces());
  const tailscale = addresses.tailscale[0] ? remoteLink("tailscale", addresses.tailscale[0]) : null;
  const lan = addresses.lan[0] ? remoteLink("lan", addresses.lan[0]) : null;
  return {
    tailscale,
    lan,
    preferred: tailscale ?? lan
  };
}

function remoteLink(kind, address) {
  const token = process.env.STIKSERVER_TOKEN;
  return {
    kind,
    address,
    url: `http://${address}:${process.env.STIKSERVER_PORT}/?token=${encodeURIComponent(token)}`
  };
}
