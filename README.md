# StikServer

StikServer is a private-network iOS device-control server. It discovers `_remotepairing._tcp` devices on the server's local network and serves a touch-friendly controller that works on desktop browsers and Android without requiring Bonjour on the viewing device.

## Run

Node.js 20 or newer runs discovery and the web interface. Direct pairing, screen viewing, and controls additionally use the native CoreDevice helper and FFmpeg.

```sh
STIKSERVER_TOKEN="choose-a-private-token" \
STIKSERVER_HOST="0.0.0.0" \
npm start
```

Open `http://<tailscale-ip>:8765/?token=choose-a-private-token` from another device on the same tailnet. Keep the port private to Tailscale or another trusted VPN. Without `STIKSERVER_HOST`, the server only accepts connections from the same computer.

Discovery is built into StikServer and supports multiple nearby devices and multiple viewers simultaneously. The native CoreDevice backend is being separated from the web process so discovery, pairing identities, device sessions, and screen decoders can run concurrently without coupling the browser UI to StikDebug.

Build the native helper once on the server computer, then restart StikServer:

```sh
cd native
cargo build --release
```

Install FFmpeg with the package manager for the server operating system. StikServer automatically detects both components and explains what is missing in the device list. Pairing identities are stored locally in `pairings/` and are never sent to the browser.

## Internal agent protocol

Connect to `/agent?token=...`, then send:

```json
{"type":"register","device":{"id":"stable-id","name":"My iPad","kind":"iPad","width":2048,"height":2732}}
```

Send JPEG frames as binary WebSocket messages. Commands arrive as JSON with `type: "command"`; touch commands contain normalized `x` and `y` coordinates. Metadata can be refreshed with `type: "metadata"`.

This protocol remains available as an internal backend boundary, but the intended production path is StikServer's own native CoreDevice process—not a StikDebug app relaying another device.
