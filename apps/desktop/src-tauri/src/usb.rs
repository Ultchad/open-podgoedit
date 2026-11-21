//! Native libusb transport for the POD Go.
//!
//! This mirrors `apps/android/.../PodgoUsbBridge.kt`: one reader thread owns
//! the IN endpoint and queues replies, and writes travel through the same
//! thread so the libusb handle is never shared between threads. The protocol
//! itself stays in the web app's WASM flows, so reads and every gated write
//! follow exactly the same rules as WebUSB and Android.
//!
//! Binary data crosses the Tauri boundary as base64.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusb::{Context, DeviceHandle, Direction, TransferType, UsbContext};
use serde::Serialize;

/// Line 6 vendor id and the POD Go / POD Go Wireless product ids.
const LINE6_VENDOR_ID: u16 = 0x0e41;
const PODGO_PRODUCT_IDS: [u16; 2] = [0x4247, 0x424b];

const BULK_IN_BUFFER: usize = 512;
const MAX_QUEUED_PACKETS: usize = 64;
/// The page never waits longer than this for one reply.
const MAX_READ_WAIT_MS: u64 = 5_000;
/// Short IN timeout so a pending write is picked up promptly.
const READ_POLL_MS: u64 = 25;
const WRITE_TIMEOUT_MS: u64 = 2_000;

/// The pedal this link is open to. Field names match `PodgoDeviceInfo` in the
/// web app (`productId`, `endpointOut`, …).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub product_id: u16,
    pub product_name: String,
    pub interface_number: u8,
    pub endpoint_out: u8,
    pub endpoint_in: u8,
}

/// The vendor interface and its bulk pair.
struct Endpoints {
    interface: u8,
    setting: u8,
    out: u8,
    input: u8,
}

enum Writer {
    Write(Vec<u8>, Sender<Result<(), String>>),
}

/// Packets the reader thread received and the page has not taken yet.
struct Queue {
    packets: Mutex<VecDeque<Vec<u8>>>,
    ready: Condvar,
    running: AtomicBool,
    /// Set when libusb reports a fatal error, so the page sees it instead of
    /// waiting for a reply that can never arrive.
    error: Mutex<Option<String>>,
}

impl Queue {
    fn new() -> Self {
        Self {
            packets: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            running: AtomicBool::new(true),
            error: Mutex::new(None),
        }
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn fail(&self, message: String) {
        if let Ok(mut error) = self.error.lock() {
            if error.is_none() {
                *error = Some(message);
            }
        }
        self.running.store(false, Ordering::SeqCst);
        self.ready.notify_all();
    }

    fn push(&self, packet: Vec<u8>) {
        if let Ok(mut packets) = self.packets.lock() {
            if packets.len() >= MAX_QUEUED_PACKETS {
                // Keep the newest reply: dropping an older one is what the
                // Android bridge does too.
                packets.pop_front();
            }
            packets.push_back(packet);
        }
        self.ready.notify_all();
    }

    fn discard(&self) {
        if let Ok(mut packets) = self.packets.lock() {
            packets.clear();
        }
    }

    /// Next queued reply as base64, or `None` on timeout.
    fn read(&self, timeout_ms: u64) -> Result<Option<String>, String> {
        let wait = Duration::from_millis(timeout_ms.min(MAX_READ_WAIT_MS));
        let deadline = Instant::now() + wait;
        let mut packets = self
            .packets
            .lock()
            .map_err(|_| "the USB packet queue is poisoned".to_string())?;
        loop {
            if let Some(packet) = packets.pop_front() {
                return Ok(Some(BASE64.encode(packet)));
            }
            if let Ok(error) = self.error.lock() {
                if let Some(message) = error.as_ref() {
                    return Err(message.clone());
                }
            }
            if !self.is_running() {
                return Err("the USB link is closed".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            let remaining = deadline - now;
            let (guard, _) = self
                .ready
                .wait_timeout(packets, remaining)
                .map_err(|_| "the USB packet queue is poisoned".to_string())?;
            packets = guard;
        }
    }
}

/// One open pedal session.
struct Session {
    info: DeviceInfo,
    queue: Arc<Queue>,
    writer: Sender<Writer>,
    reader: JoinHandle<()>,
}

impl Session {
    fn shutdown(self) {
        self.queue.running.store(false, Ordering::SeqCst);
        self.queue.ready.notify_all();
        // Dropping `writer` also disconnects the channel, so a reader parked in
        // `try_recv` still notices.
        drop(self.writer);
        let _ = self.reader.join();
    }
}

/// Application state: at most one open pedal.
#[derive(Default)]
pub struct UsbState {
    session: Mutex<Option<Session>>,
}

impl UsbState {
    fn open(&self) -> Result<DeviceInfo, String> {
        let mut slot = self
            .session
            .lock()
            .map_err(|_| "the USB state is poisoned".to_string())?;
        if let Some(session) = slot.as_ref() {
            if session.queue.is_running() {
                return Ok(session.info.clone());
            }
        }
        if let Some(stale) = slot.take() {
            stale.shutdown();
        }

        let (handle, endpoints, info) = open_pedal()?;
        let queue = Arc::new(Queue::new());
        let (writer, messages) = mpsc::channel();
        let reader_queue = Arc::clone(&queue);
        let reader = thread::Builder::new()
            .name("podgo-usb-reader".to_string())
            .spawn(move || {
                read_loop(handle, endpoints, reader_queue, messages);
            })
            .map_err(|error| format!("could not start the USB reader: {error}"))?;

        *slot = Some(Session {
            info: info.clone(),
            queue,
            writer,
            reader,
        });
        Ok(info)
    }

    fn queue(&self) -> Result<Arc<Queue>, String> {
        let slot = self
            .session
            .lock()
            .map_err(|_| "the USB state is poisoned".to_string())?;
        match slot.as_ref() {
            Some(session) if session.queue.is_running() => Ok(Arc::clone(&session.queue)),
            _ => Err("the USB link is closed".to_string()),
        }
    }

    fn writer(&self) -> Result<Sender<Writer>, String> {
        let slot = self
            .session
            .lock()
            .map_err(|_| "the USB state is poisoned".to_string())?;
        match slot.as_ref() {
            Some(session) if session.queue.is_running() => Ok(session.writer.clone()),
            _ => Err("the USB link is closed".to_string()),
        }
    }

    fn close(&self) {
        let session = self.session.lock().ok().and_then(|mut slot| slot.take());
        if let Some(session) = session {
            session.shutdown();
        }
    }
}

/// Open the first POD Go on the bus and claim its vendor interface.
fn open_pedal() -> Result<(DeviceHandle<Context>, Endpoints, DeviceInfo), String> {
    let context = Context::new().map_err(|error| {
        format!("libusb is unavailable ({error}). Install libusb and run with USB access.")
    })?;
    let devices = context
        .devices()
        .map_err(|error| format!("could not enumerate USB devices: {error}"))?;

    for device in devices.iter() {
        let Ok(descriptor) = device.device_descriptor() else {
            continue;
        };
        if descriptor.vendor_id() != LINE6_VENDOR_ID
            || !PODGO_PRODUCT_IDS.contains(&descriptor.product_id())
        {
            continue;
        }
        let product_id = descriptor.product_id();
        let endpoints = vendor_interface(&device)?;
        let handle = device.open().map_err(|error| {
            format!(
                "could not open the POD Go ({error}). On Linux check the udev rule; \
                 on Windows bind the pedal to WinUSB."
            )
        })?;
        // The kernel audio/USB driver may already own the interface. libusb
        // detaches it on Linux and macOS; the call is a no-op elsewhere.
        let _ = handle.set_auto_detach_kernel_driver(true);
        if endpoints.setting != 0 {
            handle
                .set_alternate_setting(endpoints.interface, endpoints.setting)
                .map_err(|error| {
                    format!("could not select the POD Go vendor interface setting: {error}")
                })?;
        }
        handle
            .claim_interface(endpoints.interface)
            .map_err(|error| {
                format!(
                    "could not claim the POD Go vendor interface ({error}). Another program \
                 may already be using the pedal."
                )
            })?;
        let product_name = handle
            .read_product_string_ascii(&descriptor)
            .unwrap_or_else(|_| "POD Go".to_string());
        let info = DeviceInfo {
            product_id,
            product_name,
            interface_number: endpoints.interface,
            endpoint_out: endpoints.out,
            endpoint_in: endpoints.input,
        };
        return Ok((handle, endpoints, info));
    }

    Err("No POD Go found on the USB bus. Plug the pedal in with a data cable.".to_string())
}

/// First interface with a bulk pair, preferring the vendor-specific one.
fn vendor_interface(device: &rusb::Device<Context>) -> Result<Endpoints, String> {
    let config = device
        .active_config_descriptor()
        .map_err(|error| format!("could not read the POD Go configuration: {error}"))?;
    let mut fallback: Option<Endpoints> = None;
    for interface in config.interfaces() {
        for descriptor in interface.descriptors() {
            let mut out = None;
            let mut input = None;
            for endpoint in descriptor.endpoint_descriptors() {
                if endpoint.transfer_type() != TransferType::Bulk {
                    continue;
                }
                match endpoint.direction() {
                    Direction::Out => {
                        if out.is_none() {
                            out = Some(endpoint.address());
                        }
                    }
                    Direction::In => {
                        if input.is_none() {
                            input = Some(endpoint.address());
                        }
                    }
                }
            }
            let (Some(out), Some(input)) = (out, input) else {
                continue;
            };
            let found = Endpoints {
                interface: interface.number(),
                setting: descriptor.setting_number(),
                out,
                input,
            };
            if descriptor.class_code() == 0xff {
                return Ok(found);
            }
            fallback.get_or_insert(found);
        }
    }
    fallback
        .ok_or_else(|| "The POD Go exposes no vendor interface with bulk endpoints.".to_string())
}

/// Reader thread: owns the handle, serves writes, queues IN packets.
fn read_loop(
    mut handle: DeviceHandle<Context>,
    endpoints: Endpoints,
    queue: Arc<Queue>,
    messages: Receiver<Writer>,
) {
    let mut buffer = [0u8; BULK_IN_BUFFER];
    while queue.is_running() {
        loop {
            match messages.try_recv() {
                Ok(Writer::Write(bytes, ack)) => {
                    // A rejected write is reported to the caller; the reader
                    // keeps the link open, like the Android bridge.
                    let result = write_all(&mut handle, endpoints.out, &bytes);
                    let _ = ack.send(result);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        if !queue.is_running() {
            break;
        }
        match handle.read_bulk(
            endpoints.input,
            &mut buffer,
            Duration::from_millis(READ_POLL_MS),
        ) {
            Ok(count) if count > 0 => {
                let packet = &buffer[..count];
                // Event frames (`0x03F0 → 0x1002`) are notifications, never a
                // reply; the page must not receive one in place of a response.
                if !is_event(packet) {
                    queue.push(packet.to_vec());
                }
            }
            Ok(_) => {}
            Err(rusb::Error::Timeout) => {}
            Err(error) => {
                queue.fail(format!("USB read failed: {error}"));
                break;
            }
        }
    }
    let _ = handle.release_interface(endpoints.interface);
    queue.running.store(false, Ordering::SeqCst);
    queue.ready.notify_all();
}

fn is_event(packet: &[u8]) -> bool {
    packet.len() >= 8
        && packet[4] == 0xf0
        && packet[5] == 0x03
        && packet[6] == 0x02
        && packet[7] == 0x10
}

fn write_all(handle: &mut DeviceHandle<Context>, endpoint: u8, bytes: &[u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        match handle.write_bulk(
            endpoint,
            &bytes[offset..],
            Duration::from_millis(WRITE_TIMEOUT_MS),
        ) {
            Ok(0) => return Err("USB write failed: the pedal accepted no data".to_string()),
            Ok(sent) => offset += sent,
            Err(error) => return Err(format!("USB write failed: {error}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn usb_open(state: tauri::State<'_, UsbState>) -> Result<DeviceInfo, String> {
    state.open()
}

#[tauri::command]
pub fn usb_close(state: tauri::State<'_, UsbState>) -> Result<(), String> {
    state.close();
    Ok(())
}

#[tauri::command]
pub fn usb_discard(state: tauri::State<'_, UsbState>) -> Result<(), String> {
    state.queue()?.discard();
    Ok(())
}

#[tauri::command]
pub async fn usb_read(
    timeout_ms: u64,
    state: tauri::State<'_, UsbState>,
) -> Result<Option<String>, String> {
    let queue = state.queue()?;
    tauri::async_runtime::spawn_blocking(move || queue.read(timeout_ms))
        .await
        .map_err(|error| format!("the USB read task failed: {error}"))?
}

#[tauri::command]
pub async fn usb_write(data: String, state: tauri::State<'_, UsbState>) -> Result<(), String> {
    let bytes = BASE64
        .decode(data.as_bytes())
        .map_err(|error| format!("invalid base64 payload: {error}"))?;
    let writer = state.writer()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (ack, result) = mpsc::channel();
        writer
            .send(Writer::Write(bytes, ack))
            .map_err(|_| "the USB link is closed".to_string())?;
        result
            .recv_timeout(Duration::from_millis(WRITE_TIMEOUT_MS + 1_000))
            .map_err(|_| "the USB write was not delivered in time".to_string())?
    })
    .await
    .map_err(|error| format!("the USB write task failed: {error}"))?
}
