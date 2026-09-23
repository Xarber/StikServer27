use std::{env, net::IpAddr, path::PathBuf, process::ExitCode, time::Duration};

use idevice::{
    IdeviceError, ReadWrite, RsdService,
    core_device::{
        AppServiceClient, ButtonState, CallInfoBlob, ConfigurationServiceClient,
        DisplayServiceClient, HevcDepacketizer, IndigoHidClient, MainKeyboardService,
        OrientationServiceClient, RotationDirection, RtpPacket, TOUCHSCREEN_STATE_CONTACT,
        TOUCHSCREEN_STATE_RELEASE, UniversalHidServiceClient, UserInterfaceStyle,
        build_screen_audio_offer, build_screen_video_offer, build_start_audio_parameters,
        build_start_video_parameters,
    },
    diagnostics_relay::DiagnosticsRelayClient,
    dvt::{
        condition_inducer::ConditionInducerClient,
        device_info::DeviceInfoClient,
        energy_monitor::{EnergyMonitorClient, EnergySample},
        graphics::GraphicsClient,
        location_simulation::LocationSimulationClient,
        network_monitor::{NetworkEvent, NetworkMonitorClient},
        remote_server::RemoteServerClient,
        sysmontap::{SysmontapClient, SysmontapConfig},
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
    pid: Option<u32>,
    pids: Option<Vec<u32>>,
    signal: Option<u32>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    style: Option<String>,
    enabled: Option<bool>,
    value: Option<f64>,
    size: Option<String>,
    filter_type: Option<String>,
    group_identifier: Option<String>,
    profile_identifier: Option<String>,
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
        "validate" => validate_pairing(arguments).await,
        "match" => match_pairing(arguments).await,
        "stream" => stream(arguments).await,
        other => Err(format!("unknown command: {other}").into()),
    }
}

async fn validate_pairing(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    let pairing_path = arguments.pairing.ok_or("validate requires --pairing")?;
    RpPairingFile::read_from_file(pairing_path).await?;
    println!("{}", json!({ "valid": true }));
    Ok(())
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
    let mut app_service = AppServiceClient::connect_rsd(&mut handle, &mut handshake).await?;
    let mut configuration =
        ConfigurationServiceClient::connect_rsd(&mut handle, &mut handshake).await?;
    let mut diagnostics = DiagnosticsRelayClient::connect_rsd(&mut handle, &mut handshake).await?;

    let mut dvt = RemoteServerClient::connect_rsd(&mut handle, &mut handshake).await?;
    dvt.read_message(0).await?;

    // Location simulation only remains active while its Instruments channel is alive.
    // Give it a dedicated DVT connection so process and performance requests cannot
    // invalidate the simulated location.
    let mut location_dvt = RemoteServerClient::connect_rsd(&mut handle, &mut handshake).await?;
    location_dvt.read_message(0).await?;
    let mut location = LocationSimulationClient::new(&mut location_dvt).await?;

    // Device conditions (network, thermal, CPU and other Xcode profiles) similarly
    // keep their own long-lived channel.
    let mut condition_dvt = RemoteServerClient::connect_rsd(&mut handle, &mut handshake).await?;
    condition_dvt.read_message(0).await?;
    let mut conditions = ConditionInducerClient::new(&mut condition_dvt).await?;

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
                let command_name = command.command.clone();
                let result = handle_command(
                    command,
                    &mut universal_hid,
                    &mut main_keyboard,
                    &mut buttons,
                    &mut orientation,
                    &interface_orientation,
                    &mut app_service,
                    &mut configuration,
                    &mut diagnostics,
                    &mut dvt,
                    &mut location,
                    &mut conditions,
                ).await;
                match result {
                    Ok(Some(event)) => write_event(&mut output, event).await?,
                    Ok(None) => {}
                    Err(error) => {
                        write_event(&mut output, json!({
                            "type": "commandResult",
                            "command": command_name,
                            "ok": false,
                            "message": error.to_string()
                        })).await?;
                    }
                }
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
    app_service: &mut AppServiceClient<Box<dyn ReadWrite>>,
    configuration: &mut ConfigurationServiceClient<Box<dyn ReadWrite>>,
    diagnostics: &mut DiagnosticsRelayClient,
    dvt: &mut RemoteServerClient<Box<dyn ReadWrite>>,
    location: &mut LocationSimulationClient<'_, Box<dyn ReadWrite>>,
    conditions: &mut ConditionInducerClient<'_, Box<dyn ReadWrite>>,
) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error>> {
    match command.command.as_str() {
        "touch" => {
            let state = match command.phase.as_deref() {
                Some("down" | "move") => TOUCHSCREEN_STATE_CONTACT,
                Some("up") => TOUCHSCREEN_STATE_RELEASE,
                _ => return Ok(None),
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
        "processes" => {
            let mut info = DeviceInfoClient::new(dvt).await?;
            let processes = info.running_processes().await?;
            return Ok(Some(json!({
                "type": "processes",
                "processes": processes.into_iter().map(|process| json!({
                    "pid": process.pid,
                    "name": process.name,
                    "realAppName": process.real_app_name,
                    "isApplication": process.is_application,
                    "startPageCount": process.start_page_count
                })).collect::<Vec<_>>()
            })));
        }
        "killProcess" | "signalProcess" => {
            let pid = command.pid.ok_or("process command requires pid")?;
            let signal = if command.command == "killProcess" {
                9
            } else {
                command.signal.unwrap_or(15)
            };
            app_service.send_signal(pid, signal).await?;
            return Ok(Some(command_result(
                &command.command,
                json!({
                    "pid": pid,
                    "signal": signal
                }),
            )));
        }
        "battery" => {
            let values = diagnostics.gasguage().await?.unwrap_or_default();
            return Ok(Some(json!({ "type": "battery", "data": values })));
        }
        "diagnostics" => {
            let values = diagnostics.all().await?.unwrap_or_default();
            return Ok(Some(json!({ "type": "diagnostics", "data": values })));
        }
        "deviceInfo" => {
            let mut info = DeviceInfoClient::new(dvt).await?;
            let hardware = info.hardware_information().await?;
            let network = info.network_information().await?;
            let kernel = info.mach_kernel_name().await?;
            return Ok(Some(json!({
                "type": "deviceInfo",
                "hardware": hardware,
                "network": network,
                "kernel": kernel
            })));
        }
        "performance" => {
            let (process_attributes, system_attributes) = {
                let mut info = DeviceInfoClient::new(dvt).await?;
                (
                    info.sysmon_process_attributes().await?,
                    info.sysmon_system_attributes().await?,
                )
            };
            let mut monitor = SysmontapClient::new(dvt).await?;
            monitor
                .set_config(&SysmontapConfig {
                    interval_ms: 750,
                    process_attributes: process_attributes.clone(),
                    system_attributes: system_attributes.clone(),
                })
                .await?;
            monitor.start().await?;
            let sample = monitor.next_sample().await?;
            let _ = monitor.stop().await;
            return Ok(Some(json!({
                "type": "performance",
                "processAttributes": process_attributes,
                "systemAttributes": system_attributes,
                "processes": sample.processes,
                "system": sample.system,
                "cpu": sample.system_cpu_usage
            })));
        }
        "energy" => {
            let pids = command
                .pids
                .filter(|values| !values.is_empty())
                .ok_or("energy requires at least one pid")?;
            let mut monitor = EnergyMonitorClient::new(dvt).await?;
            monitor.start_sampling(&pids).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            let bytes = monitor.sample_attributes(&pids).await?;
            let _ = monitor.stop_sampling(&pids).await;
            let samples = EnergySample::from_bytes(&bytes)?;
            return Ok(Some(json!({
                "type": "energy",
                "samples": samples.into_iter().map(|sample| json!({
                    "pid": sample.pid,
                    "timestamp": sample.timestamp,
                    "total": sample.total_energy,
                    "cpu": sample.cpu_energy,
                    "gpu": sample.gpu_energy,
                    "network": sample.networking_energy,
                    "display": sample.display_energy,
                    "location": sample.location_energy,
                    "appState": sample.appstate_energy
                })).collect::<Vec<_>>()
            })));
        }
        "graphics" => {
            let mut monitor = GraphicsClient::new(dvt).await?;
            monitor.start_sampling(0.5).await?;
            let sample = tokio::time::timeout(Duration::from_secs(4), monitor.sample())
                .await
                .map_err(|_| "graphics sample timed out")??;
            let _ = monitor.stop_sampling().await;
            return Ok(Some(json!({
                "type": "graphics",
                "timestamp": sample.timestamp,
                "fps": sample.fps,
                "allocatedMemory": sample.alloc_system_memory,
                "usedMemory": sample.in_use_system_memory,
                "driverMemory": sample.in_use_system_memory_driver,
                "gpu": sample.gpu_bundle_name,
                "recoveryCount": sample.recovery_count
            })));
        }
        "networkActivity" => {
            let mut monitor = NetworkMonitorClient::new(dvt).await?;
            monitor.start_monitoring().await?;
            let event = tokio::time::timeout(Duration::from_secs(4), monitor.next_event())
                .await
                .map_err(|_| "network activity sample timed out")??;
            let _ = monitor.stop_monitoring().await;
            let data = match event {
                NetworkEvent::InterfaceDetection(value) => json!({
                    "kind": "interface",
                    "interfaceIndex": value.interface_index,
                    "name": value.name
                }),
                NetworkEvent::ConnectionDetection(value) => json!({
                    "kind": "connection",
                    "pid": value.pid,
                    "interfaceIndex": value.interface_index,
                    "local": value.local_address.map(|address| json!({ "address": address.addr, "port": address.port, "family": address.family })),
                    "remote": value.remote_address.map(|address| json!({ "address": address.addr, "port": address.port, "family": address.family })),
                    "receiveBufferSize": value.recv_buffer_size,
                    "receiveBufferUsed": value.recv_buffer_used,
                    "serial": value.serial_number,
                    "connectionKind": value.kind
                }),
                NetworkEvent::ConnectionUpdate(value) => json!({
                    "kind": "update",
                    "receivePackets": value.rx_packets,
                    "receiveBytes": value.rx_bytes,
                    "transmitPackets": value.tx_packets,
                    "transmitBytes": value.tx_bytes,
                    "retransmits": value.tx_retx,
                    "minimumRTT": value.min_rtt,
                    "averageRTT": value.avg_rtt,
                    "serial": value.connection_serial,
                    "time": value.time
                }),
                NetworkEvent::Unknown(kind) => json!({ "kind": "unknown", "messageType": kind }),
            };
            return Ok(Some(json!({ "type": "networkActivity", "event": data })));
        }
        "setLocation" => {
            let latitude = command.latitude.ok_or("setLocation requires latitude")?;
            let longitude = command.longitude.ok_or("setLocation requires longitude")?;
            if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
                return Err("location coordinates are out of range".into());
            }
            location.set(latitude, longitude).await?;
            return Ok(Some(command_result(
                "setLocation",
                json!({
                    "latitude": latitude,
                    "longitude": longitude
                }),
            )));
        }
        "clearLocation" => {
            location.clear().await?;
            return Ok(Some(command_result("clearLocation", json!({}))));
        }
        "configuration" => {
            let style = configuration.get_user_interface_style().await.ok();
            let color_filter = configuration.get_color_filter().await.ok();
            let text_size = configuration.get_device_text_size().await.ok();
            let reduce_motion = configuration.get_reduce_motion().await.ok();
            let reduce_transparency = configuration.get_reduce_transparency().await.ok();
            let show_borders = configuration.get_show_borders().await.ok();
            return Ok(Some(json!({
                "type": "configuration",
                "appearance": style.map(|value| match value {
                    UserInterfaceStyle::Light => "light",
                    UserInterfaceStyle::Dark => "dark"
                }),
                "colorFilter": color_filter.map(|filter| json!({
                    "enabled": filter.enabled,
                    "type": filter.filter_type,
                    "intensity": filter.intensity
                })),
                "textSize": text_size,
                "reduceMotion": reduce_motion,
                "reduceTransparency": reduce_transparency,
                "showBorders": show_borders
            })));
        }
        "setAppearance" => {
            let style = match command.style.as_deref() {
                Some("light") => UserInterfaceStyle::Light,
                Some("dark") => UserInterfaceStyle::Dark,
                _ => return Err("setAppearance requires light or dark".into()),
            };
            configuration.set_user_interface_style(style).await?;
            return Ok(Some(command_result(
                "setAppearance",
                json!({ "style": command.style }),
            )));
        }
        "setLiquidGlassOpacity" => {
            let value = command
                .value
                .ok_or("setLiquidGlassOpacity requires value")?;
            configuration.set_liquid_glass_opacity(value as f32).await?;
            return Ok(Some(command_result(
                "setLiquidGlassOpacity",
                json!({ "value": value }),
            )));
        }
        "setColorFilter" => {
            let enabled = command.enabled.unwrap_or(false);
            let intensity = command.value.map(|value| value as f32);
            configuration
                .set_color_filter(enabled, command.filter_type.as_deref(), intensity)
                .await?;
            return Ok(Some(command_result(
                "setColorFilter",
                json!({ "enabled": enabled }),
            )));
        }
        "setTextSize" => {
            let size = command.size.as_deref().ok_or("setTextSize requires size")?;
            configuration.set_device_text_size(size).await?;
            return Ok(Some(command_result("setTextSize", json!({ "size": size }))));
        }
        "setReduceMotion" => {
            let enabled = command.enabled.ok_or("setReduceMotion requires enabled")?;
            configuration.set_reduce_motion(enabled).await?;
            return Ok(Some(command_result(
                "setReduceMotion",
                json!({ "enabled": enabled }),
            )));
        }
        "setReduceTransparency" => {
            let enabled = command
                .enabled
                .ok_or("setReduceTransparency requires enabled")?;
            configuration.set_reduce_transparency(enabled).await?;
            return Ok(Some(command_result(
                "setReduceTransparency",
                json!({ "enabled": enabled }),
            )));
        }
        "setIncreaseContrast" => {
            let enabled = command
                .enabled
                .ok_or("setIncreaseContrast requires enabled")?;
            configuration.set_increase_contrast(enabled).await?;
            return Ok(Some(command_result(
                "setIncreaseContrast",
                json!({ "enabled": enabled }),
            )));
        }
        "setShowBorders" => {
            let enabled = command.enabled.ok_or("setShowBorders requires enabled")?;
            configuration.set_show_borders(enabled).await?;
            return Ok(Some(command_result(
                "setShowBorders",
                json!({ "enabled": enabled }),
            )));
        }
        "conditions" => {
            let groups = conditions.available_conditions().await?;
            return Ok(Some(json!({
                "type": "conditions",
                "groups": groups.into_iter().map(|group| json!({
                    "identifier": group.identifier,
                    "profiles": group.profiles.into_iter().map(|profile| json!({
                        "identifier": profile.identifier,
                        "description": profile.description
                    })).collect::<Vec<_>>()
                })).collect::<Vec<_>>()
            })));
        }
        "enableCondition" => {
            let group = command
                .group_identifier
                .as_deref()
                .ok_or("enableCondition requires groupIdentifier")?;
            let profile = command
                .profile_identifier
                .as_deref()
                .ok_or("enableCondition requires profileIdentifier")?;
            conditions.enable_condition(group, profile).await?;
            return Ok(Some(command_result(
                "enableCondition",
                json!({
                    "groupIdentifier": group,
                    "profileIdentifier": profile
                }),
            )));
        }
        "disableCondition" => {
            conditions.disable_condition().await?;
            return Ok(Some(command_result("disableCondition", json!({}))));
        }
        "restart" => {
            diagnostics.restart().await?;
            return Ok(Some(command_result("restart", json!({}))));
        }
        "shutdown" => {
            diagnostics.shutdown().await?;
            return Ok(Some(command_result("shutdown", json!({}))));
        }
        "sleep" => {
            diagnostics.sleep().await?;
            return Ok(Some(command_result("sleep", json!({}))));
        }
        _ => {}
    }
    Ok(None)
}

fn command_result(command: &str, data: serde_json::Value) -> serde_json::Value {
    json!({
        "type": "commandResult",
        "command": command,
        "ok": true,
        "data": data
    })
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
