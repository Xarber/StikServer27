# StikServer

StikServer is a private-network relay for controlling iOS devices exposed by StikDebug. It serves a touch-friendly web interface that works on desktop browsers and Android without Bonjour.

## Run

Node.js 20 or newer is the only requirement.

```sh
STIKSERVER_TOKEN="choose-a-private-token" \
STIKSERVER_HOST="0.0.0.0" \
npm start
```

Open `http://<tailscale-ip>:8765/?token=choose-a-private-token` from another device on the same tailnet. Keep the port private to Tailscale or another trusted VPN. Without `STIKSERVER_HOST`, the server only accepts connections from the same computer.

The relay supports multiple StikDebug agents and multiple viewers simultaneously. Each viewer independently chooses a device. Video frames are relayed as binary WebSocket messages and control events are JSON, so the server never needs to decode the screen stream.

## Agent protocol

Connect to `/agent?token=...`, then send:

```json
{"type":"register","device":{"id":"stable-id","name":"My iPad","kind":"iPad","width":2048,"height":2732}}
```

Send JPEG frames as binary WebSocket messages. Commands arrive as JSON with `type: "command"`; touch commands contain normalized `x` and `y` coordinates. Metadata can be refreshed with `type: "metadata"`.
