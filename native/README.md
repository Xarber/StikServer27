# Native CoreDevice backend

This process is the direct device side of StikServer. It connects to `_remotepairing._tcp`, establishes the encrypted userspace tunnel from a remote-pairing identity, starts the CoreDevice display/HID services, and emits framed HEVC plus orientation events to the parent StikServer process.

It intentionally runs separately from the web server so multiple devices can each own an independent tunnel and decoder process. StikDebug is not involved.

Commands:

```sh
cargo run --release -- pair --host ipad.local --port 49152 --output ../pairings/ipad.plist
cargo run --release -- match --pairing ../pairings/ipad.plist --identifier ID --auth-tag TAG
cargo run --release -- stream --host ipad.local --port 49152 --pairing ../pairings/ipad.plist
```

`stream` writes framed binary records to stdout: one byte of record type, four bytes of big-endian length, then the payload. Type `1` is an Annex-B HEVC access unit and type `2` is a JSON event. It accepts one JSON control command per line on stdin.
