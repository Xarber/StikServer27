use std::{env, net::IpAddr, path::PathBuf, process::ExitCode, time::Duration};

use idevice::{
    IdeviceError, ReadWrite, RsdService,
    core_device::{
        ButtonState, CallInfoBlob, DisplayServiceClient, HevcDepacketizer, IndigoHidClient,
        MainKeyboardService, OrientationServiceClient, RotationDirection, RtpPacket,
        TOUCHSCREEN_STATE_CONTACT, TOUCHSCREEN_STATE_RELEASE, UniversalHidServiceClient,
        build_screen_audio_offer, build_screen_video_offer, build_start_audio_parameters,
        build_start_video_parameters,
    },
    remote_pairing::{
        PeerDevice, RemotePairingClient, RpPairingFile, RpPairingSocket,
        connect_tls_psk_tunnel_native,
    },
    rsd::RsdHandshake,
    springboardservices::{InterfaceOrientation, SpringBoardServicesClient},
    tcp,
};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use uuid::Uuid;

const CLIENT_SUPPORTED_FEATURES: u64 = 140;

#[derive(Debug)]
struct Arguments {
    command: String,
    host: String,
    port: u16,
    pairing: Option<PathBuf>,
    output: Option<PathBuf>,
    identifier: Option<String>,
    auth_tag: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlCommand {
    command: String,
    phase: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    text: Option<String>,
}

struct MediaSession {
    display: DisplayServiceClient<Box<dyn ReadWrite>>,
    audio_udp: tcp::handle::UdpSocketHandle,
    video_udp: tcp::handle::UdpSocketHandle,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("stikserver-native: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments = parse_arguments()?;
    match arguments.command.as_str() {
        "pair" => pair(arguments).await,
        "match" => match_pairing(arguments).await,
        "stream" => stream(arguments).await,
        other => Err(format!("unknown command: {other}").into()),
    }
}

fn parse_arguments() -> Result<Arguments, Box<dyn std::error::Error>> {
    let mut values = env::args().skip(1);
    let command = values.next().ok_or("expected pair, match, or stream")?;
    let mut result = Arguments {
        command,
        host: String::new(),
        port: 0,
        pairing: None,
        output: None,
        identifier: None,
        auth_tag: None,
    };
    while let Some(flag) = values.next() {
        let value = values
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--host" => result.host = value,
            "--port" => result.port = value.parse()?,
            "--pairing" => result.pairing = Some(value.into()),
            "--output" => result.output = Some(value.into()),
            "--identifier" => result.identifier = Some(value),
            "--auth-tag" => result.auth_tag = Some(value),
            _ => return Err(format!("unknown option: {flag}").into()),
        }
    }
    Ok(result)
}

async fn pair(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    require_endpoint(&arguments)?;
    let output = arguments.output.ok_or("pair requires --output")?;
    let stream = connect_endpoint(&arguments.host, arguments.port).await?;
    let host_label = "StikServer";
    let mut pairing = RpPairingFile::generate(host_label);
    let mut client = RemotePairingClient::new(RpPairingSocket::new(stream), host_label);
    client
        .connect(&mut pairing, async || {
            eprintln!("PIN_REQUIRED");
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
            line.trim().to_string()
        })
        .await?;
    pairing.write_to_file(&output).await?;
    println!("{}", json!({ "type": "paired", "path": output }));
    Ok(())
}

async fn match_pairing(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    let pairing_path = arguments.pairing.ok_or("match requires --pairing")?;
    let identifier = arguments.identifier.ok_or("match requires --identifier")?;
    let auth_tag = arguments.auth_tag.ok_or("match requires --auth-tag")?;
    let pairing = RpPairingFile::read_from_file(pairing_path).await?;
    let matches = pairing
        .alt_irk()
        .is_some_and(|irk| PeerDevice::validate_auth_tag(irk, &identifier, &auth_tag));
    println!("{}", json!({ "matches": matches }));
    Ok(())
}

async fn stream(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    require_endpoint(&arguments)?;
    let pairing_path = arguments.pairing.ok_or("stream requires --pairing")?;
    let mut pairing = RpPairingFile::read_from_file(&pairing_path).await?;
    let initial_stream = connect_endpoint(&arguments.host, arguments.port).await?;
    let host_label = "StikServer";
    let mut pairing_client =
        RemotePairingClient::new(RpPairingSocket::new(initial_stream), host_label);
    pairing_client
        .connect(&mut pairing, async || String::new())
        .await?;
    pairing.write_to_file(&pairing_path).await?;

    let tunnel_port = pairing_client.create_tcp_listener().await?;
    let tunnel_stream = connect_endpoint(&arguments.host, tunnel_port).await?;
    let tunnel =
        connect_tls_psk_tunnel_native(tunnel_stream, pairing_client.encryption_key()).await?;
    let client_ip: IpAddr = tunnel.info.client_address.parse()?;
    let server_ip: IpAddr = tunnel.info.server_address.parse()?;
    let rsd_port = tunnel.info.server_rsd_port;
    let adapter = tcp::adapter::Adapter::new(Box::new(tunnel.into_inner()), client_ip, server_ip);
    let mut handle = adapter.to_async_handle();
    let rsd_stream = handle.connect(rsd_port).await?;
    let mut handshake = RsdHandshake::new(rsd_stream).await?;

    let mut media = start_screen_media_session(&mut handle, &mut handshake).await?;
    let mut universal_hid =
        UniversalHidServiceClient::connect_rsd(&mut handle, &mut handshake).await?;
    let mut main_keyboard = universal_hid.create_main_keyboard().await.ok();
    let mut buttons = IndigoHidClient::connect_rsd(&mut handle, &mut handshake).await?;
    let mut orientation =
        OrientationServiceClient::connect_rsd(&mut handle, &mut handshake).await?;
    let mut springboard = SpringBoardServicesClient::connect_rsd(&mut handle, &mut handshake)
        .await
        .ok();

    let mut stdin_lines = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut depacketizer = HevcDepacketizer::new();
    let mut orientation_interval = tokio::time::interval(Duration::from_millis(750));
    let mut interface_orientation = InterfaceOrientation::Unknown;
    write_event(&mut output, json!({ "type": "ready" })).await?;

    loop {
        tokio::select! {
            datagram = media.video_udp.recv() => {
                let datagram = datagram?;
                let Some(packet) = RtpPacket::parse(&datagram.data) else { continue };
                if packet.payload_type != 100 { continue; }
                let marker = packet.marker;
                depacketizer.push(packet.sequence_number, packet.timestamp, packet.payload);
                if marker {
                    let bytes = depacketizer.take_output();
                    if !bytes.is_empty() { write_record(&mut output, 1, &bytes).await?; }
                }
            }
            line = stdin_lines.next_line() => {
                let Some(line) = line? else { break };
                let command: ControlCommand = serde_json::from_str(&line)?;
                if command.command == "stop" { break; }
                handle_command(
                    command,
                    &mut universal_hid,
                    &mut main_keyboard,
                    &mut buttons,
                    &mut orientation,
                    &interface_orientation,
                ).await?;
            }
            _ = orientation_interval.tick() => {
                if let Some(client) = springboard.as_mut()
                    && let Ok(value) = client.get_interface_orientation().await
                {
                    interface_orientation = value;
                    write_event(&mut output, json!({
                        "type": "orientation",
                        "orientation": orientation_name(&interface_orientation)
                    })).await?;
                }
            }
        }
    }

    if let Some(mut keyboard) = main_keyboard.take() {
        let _ = universal_hid.remove_main_keyboard(&mut keyboard).await;
    }
    let _ = media.display.stop_media_stream().await;
    drop(media.audio_udp);
    Ok(())
}

async fn start_screen_media_session(
    adapter: &mut tcp::handle::AdapterHandle,
    handshake: &mut RsdHandshake,
) -> Result<MediaSession, IdeviceError> {
    let mut display = DisplayServiceClient::connect_rsd(adapter, handshake).await?;
    let audio_udp = adapter.bind_udp(0).await?;
    let video_udp = adapter.bind_udp(0).await?;
    let receiver_ip = adapter.host_ip().to_string();
    let sender_ip = adapter.peer_ip().to_string();
    let client_session_id = Uuid::new_v4();
    let call_info = CallInfoBlob {
        call_id: 0,
        client_version: 1,
        device_type: "Mac17,7".into(),
        framework_version: "2205.3.1".into(),
        os_version: "25F71".into(),
        device_name: Some("StikServer".into()),
        audio_device_uid: None,
    };

    let audio_offer =
        build_screen_audio_offer(&Uuid::new_v4().to_string().to_uppercase(), &call_info)?;
    display
        .start_media_stream(build_start_audio_parameters(
            &receiver_ip,
            audio_udp.local_port(),
            &sender_ip,
            50000,
            audio_offer,
            CLIENT_SUPPORTED_FEATURES,
            client_session_id,
        ))
        .await?;

    let video_offer = build_screen_video_offer(
        &Uuid::new_v4().to_string().to_uppercase(),
        &call_info,
        Uuid::new_v4().as_u128() as u32,
    )?;
    display
        .start_media_stream(build_start_video_parameters(
            &receiver_ip,
            video_udp.local_port(),
            &sender_ip,
            50001,
            video_offer,
            CLIENT_SUPPORTED_FEATURES,
            1,
            client_session_id,
        ))
        .await?;
    Ok(MediaSession {
        display,
        audio_udp,
        video_udp,
    })
}

async fn handle_command(
    command: ControlCommand,
    universal_hid: &mut UniversalHidServiceClient<Box<dyn ReadWrite>>,
    main_keyboard: &mut Option<MainKeyboardService>,
    buttons: &mut IndigoHidClient<Box<dyn ReadWrite>>,
    orientation: &mut OrientationServiceClient<Box<dyn ReadWrite>>,
    interface_orientation: &InterfaceOrientation,
) -> Result<(), Box<dyn std::error::Error>> {
    match command.command.as_str() {
        "touch" => {
            let state = match command.phase.as_deref() {
                Some("down" | "move") => TOUCHSCREEN_STATE_CONTACT,
                Some("up") => TOUCHSCREEN_STATE_RELEASE,
                _ => return Ok(()),
            };
            let (x, y) = device_point(
                command.x.unwrap_or(0.0),
                command.y.unwrap_or(0.0),
                interface_orientation,
            );
            universal_hid.send_touchscreen(state, x, y, None).await?;
        }
        "home" => press_button(buttons, 0x0C, 0x40, 80).await?,
        "lock" => press_button(buttons, 0x0C, 0x30, 200).await?,
        "volumeUp" => press_button(buttons, 0x0C, 0xE9, 80).await?,
        "volumeDown" => press_button(buttons, 0x0C, 0xEA, 80).await?,
        "mute" => press_button(buttons, 0x0C, 0xE2, 80).await?,
        "siri" => press_button(buttons, 0x0C, 0xCF, 1_200).await?,
        "rotateLeft" => {
            orientation.rotate(RotationDirection::Left).await?;
        }
        "rotateRight" => {
            orientation.rotate(RotationDirection::Right).await?;
        }
        "softwareKeyboard" => {
            if let Some(mut keyboard) = main_keyboard.take() {
                universal_hid.remove_main_keyboard(&mut keyboard).await?;
            } else {
                *main_keyboard = Some(universal_hid.create_main_keyboard().await?);
            }
        }
        "backspace" => keyboard_tap(buttons, 0x2A, 0).await?,
        "text" => {
            for character in command.text.unwrap_or_default().chars().take(2_000) {
                if let Some((usage, modifiers)) = keyboard_key(character) {
                    keyboard_tap(buttons, usage, modifiers).await?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

async fn press_button(
    client: &mut IndigoHidClient<Box<dyn ReadWrite>>,
    page: u64,
    code: u64,
    hold_ms: u64,
) -> Result<(), IdeviceError> {
    client.send_button(page, code, ButtonState::Down).await?;
    tokio::time::sleep(Duration::from_millis(hold_ms)).await;
    client.send_button(page, code, ButtonState::Up).await
}

async fn keyboard_tap(
    client: &mut IndigoHidClient<Box<dyn ReadWrite>>,
    usage: u64,
    modifiers: u8,
) -> Result<(), IdeviceError> {
    for bit in 0u8..8 {
        if modifiers & (1 << bit) != 0 {
            client
                .send_keyboard(0xE0 + u64::from(bit), ButtonState::Down)
                .await?;
        }
    }
    client.send_keyboard(usage, ButtonState::Down).await?;
    client.send_keyboard(usage, ButtonState::Up).await?;
    for bit in (0u8..8).rev() {
        if modifiers & (1 << bit) != 0 {
            client
                .send_keyboard(0xE0 + u64::from(bit), ButtonState::Up)
                .await?;
        }
    }
    Ok(())
}

fn keyboard_key(character: char) -> Option<(u64, u8)> {
    let shift = 0x02;
    match character {
        'a'..='z' => Some((0x04 + u64::from(character as u8 - b'a'), 0)),
        'A'..='Z' => Some((0x04 + u64::from(character as u8 - b'A'), shift)),
        '1'..='9' => Some((0x1E + u64::from(character as u8 - b'1'), 0)),
        '0' => Some((0x27, 0)),
        '\n' | '\r' => Some((0x28, 0)),
        '\t' => Some((0x2B, 0)),
        ' ' => Some((0x2C, 0)),
        '-' => Some((0x2D, 0)),
        '_' => Some((0x2D, shift)),
        '=' => Some((0x2E, 0)),
        '+' => Some((0x2E, shift)),
        '[' => Some((0x2F, 0)),
        '{' => Some((0x2F, shift)),
        ']' => Some((0x30, 0)),
        '}' => Some((0x30, shift)),
        '\\' => Some((0x31, 0)),
        '|' => Some((0x31, shift)),
        ';' => Some((0x33, 0)),
        ':' => Some((0x33, shift)),
        '\'' => Some((0x34, 0)),
        '"' => Some((0x34, shift)),
        '`' => Some((0x35, 0)),
        '~' => Some((0x35, shift)),
        ',' => Some((0x36, 0)),
        '<' => Some((0x36, shift)),
        '.' => Some((0x37, 0)),
        '>' => Some((0x37, shift)),
        '/' => Some((0x38, 0)),
        '?' => Some((0x38, shift)),
        '!' => Some((0x1E, shift)),
        '@' => Some((0x1F, shift)),
        '#' => Some((0x20, shift)),
        '$' => Some((0x21, shift)),
        '%' => Some((0x22, shift)),
        '^' => Some((0x23, shift)),
        '&' => Some((0x24, shift)),
        '*' => Some((0x25, shift)),
        '(' => Some((0x26, shift)),
        ')' => Some((0x27, shift)),
        _ => None,
    }
}

fn normalized(value: f64) -> u16 {
    (value.clamp(0.0, 1.0) * f64::from(u16::MAX)).round() as u16
}

fn device_point(x: f64, y: f64, orientation: &InterfaceOrientation) -> (u16, u16) {
    let x = x.clamp(0.0, 1.0);
    let y = y.clamp(0.0, 1.0);
    let (device_x, device_y) = match orientation {
        InterfaceOrientation::Portrait | InterfaceOrientation::Unknown => (x, y),
        InterfaceOrientation::PortraitUpsideDown => (1.0 - x, 1.0 - y),
        InterfaceOrientation::LandscapeRight => (y, 1.0 - x),
        InterfaceOrientation::LandscapeLeft => (1.0 - y, x),
    };
    (normalized(device_x), normalized(device_y))
}

fn orientation_name(value: &InterfaceOrientation) -> &'static str {
    match value {
        InterfaceOrientation::Portrait => "portrait",
        InterfaceOrientation::PortraitUpsideDown => "portraitUpsideDown",
        InterfaceOrientation::LandscapeRight => "landscapeRight",
        InterfaceOrientation::LandscapeLeft => "landscapeLeft",
        InterfaceOrientation::Unknown => "unknown",
    }
}

async fn write_event(
    output: &mut tokio::io::Stdout,
    value: serde_json::Value,
) -> Result<(), std::io::Error> {
    write_record(output, 2, value.to_string().as_bytes()).await
}

async fn write_record(
    output: &mut tokio::io::Stdout,
    kind: u8,
    bytes: &[u8],
) -> Result<(), std::io::Error> {
    output.write_u8(kind).await?;
    output.write_u32(bytes.len() as u32).await?;
    output.write_all(bytes).await?;
    output.flush().await
}

async fn connect_endpoint(host: &str, port: u16) -> Result<TcpStream, std::io::Error> {
    TcpStream::connect((host, port)).await
}

fn require_endpoint(arguments: &Arguments) -> Result<(), Box<dyn std::error::Error>> {
    if arguments.host.is_empty() || arguments.port == 0 {
        return Err("--host and --port are required".into());
    }
    Ok(())
}
