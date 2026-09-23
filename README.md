# StikServer

StikServer is a desktop iPhone and iPad controller. The application starts its own private web server, Bonjour discovery, CoreDevice sessions, video decoder and controller window. No separate Node.js, Rust or FFmpeg setup is required in the packaged app.

## Install the desktop app

Download the package for macOS, Windows or Linux from the latest **Build desktop app** workflow, extract it, and open StikServer. The device list and controls are built into the application.

StikServer generates and stores a private access token automatically. Use **Copy remote access link** inside the desktop app to open the same controller from an Android phone, tablet or another computer. The controlled iPhone or iPad must be visible to the StikServer computer over the local network.

Pair normally with the PIN shown by iOS, or import an existing XML/binary pairing plist from the device controls. Pairing identities and battery history stay in the desktop application's private data directory and are never sent back to a browser.

## Development

The command-line server remains available for development. It requires Node.js 20 or newer, FFmpeg, and the native helper:

```sh
cd native
cargo build --release
cd ..
STIKSERVER_TOKEN="choose-a-private-token" STIKSERVER_HOST="0.0.0.0" npm start
```

Run `npm install` and `npm run desktop` to develop the Electron application, or `npm run dist` to package it. Production packages include FFmpeg and the matching native CoreDevice helper.

The browser controller includes process inspection and termination, persistent battery-health history, location simulation, diagnostics, CPU/system performance, energy, graphics/FPS and network samples, appearance and accessibility settings, Xcode device-condition profiles, and device power controls. Battery history is kept on the server in `data/battery-history/`, so it is shared by all authorized viewers without exposing pairing identities.

## Internal agent protocol

Connect to `/agent?token=...`, then send:

```json
{"type":"register","device":{"id":"stable-id","name":"My iPad","kind":"iPad","width":2048,"height":2732}}
```

Send JPEG frames as binary WebSocket messages. Commands arrive as JSON with `type: "command"`; touch commands contain normalized `x` and `y` coordinates. Metadata can be refreshed with `type: "metadata"`.

This protocol remains available as an internal backend boundary, but the intended production path is StikServer's own native CoreDevice process—not a StikDebug app relaying another device.
