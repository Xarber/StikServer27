import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import ffmpegStatic from "ffmpeg-static";
import { privateAddresses } from "./network-address.mjs";

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

ipcMain.handle("stikserver:copy-remote-link", () => {
  const address = privateAddresses(networkInterfaces())[0];
  if (!address) return { url: null };
  const token = process.env.STIKSERVER_TOKEN;
  const url = `http://${address}:${process.env.STIKSERVER_PORT}/?token=${encodeURIComponent(token)}`;
  clipboard.writeText(url);
  return { url };
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
