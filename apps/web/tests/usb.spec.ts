import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Pedal reads, backups and raw reports live in the collapsed Developer tools
 * section, so a test has to open it before clicking those controls.
 */
async function openDevTools(page: Page): Promise<void> {
  const details = page.locator('#developer-tools');
  const open = await details.evaluate(
    (element) => (element as HTMLDetailsElement).open,
  );
  if (!open) {
    await details.locator('> summary').click();
  }
}

/**
 * Build a small streamed setlist (`[{109: {109: name, 123, 124, 125}}]`) so a
 * backup/restore test does not need 256 real slots.
 */
function smallSetlist(names: string[]): string {
  const out: number[] = [0xdc, 0x00, names.length];
  names.forEach((name, index) => {
    const raw = new TextEncoder().encode(`${name}\0`);
    out.push(
      0x81,
      0xcd,
      (index >> 8) & 0xff,
      index & 0xff,
      0x84,
      0xcd,
      0x00,
      0x6d,
      0xa0 | raw.length,
      ...raw,
      0x7b,
      0xc2,
      0x7c,
      0xc2,
      0x7d,
      0x00,
    );
  });
  return Buffer.from(Uint8Array.from(out)).toString('base64');
}

interface PgbakEntry {
  setlist: number;
  slot: number;
  name: string;
  blob: Buffer;
}

/** Minimal reader for the `.pgbak` header/entries (the writer is in Rust). */
function readPgbak(buffer: Buffer): {
  product: string;
  firmware: string;
  entries: PgbakEntry[];
} {
  expect(buffer.toString('latin1', 0, 8)).toBe('PODGOBK\0');
  expect(buffer.readUInt16LE(8)).toBe(1);
  const count = buffer.readUInt32LE(12);
  const productLength = buffer.readUInt16LE(16);
  const firmwareLength = buffer.readUInt16LE(18);
  let pos = 64;
  const product = buffer.toString('utf8', pos, pos + productLength);
  pos += productLength;
  const firmware = buffer.toString('utf8', pos, pos + firmwareLength);
  pos += firmwareLength;
  const entries: PgbakEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const setlist = buffer[pos];
    const slot = buffer[pos + 1];
    const nameLength = buffer[pos + 2];
    pos += 4;
    const blobLength = buffer.readUInt32LE(pos);
    pos += 4;
    const name = buffer.toString('utf8', pos, pos + nameLength);
    pos += nameLength;
    const blob = buffer.subarray(pos, pos + blobLength);
    pos += blobLength + 32; // per-entry SHA-256
    entries.push({ setlist, slot, name, blob });
  }
  return { product, firmware, entries };
}

/**
 * In-page fake WebUSB device.
 *
 * It answers the exact five-packet handshake, OPEN_PRESETS, OPEN_STREAM and
 * chunk requests, and slices the real User-setlist fixture into 496-byte
 * payloads at 256-byte offsets. The application still uses the real WASM
 * `ReadFlow`, so this test covers request building, response parsing,
 * absolute-offset reassembly and the UI wiring.
 *
 * Two switches reproduce the hardware symptoms reported on 2026-11-12:
 * `ignoreObject23` makes the device silent for object 23, and `eventFlood`
 * keeps event-channel frames arriving on the IN endpoint.
 */
function fakeWebUsb({
  fixture,
  factoryFixture,
  preset,
  ignoreObject23 = false,
  eventFlood = false,
  padObject = false,
  dropHandshakeAfterObject = false,
  dropFirstWriteHandshake = false,
}: {
  fixture: string;
  factoryFixture?: string;
  preset?: string;
  ignoreObject23?: boolean;
  eventFlood?: boolean;
  padObject?: boolean;
  dropHandshakeAfterObject?: boolean;
  dropFirstWriteHandshake?: boolean;
}): void {
  const bytes = Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0));
  const factoryBytes = factoryFixture
    ? Uint8Array.from(atob(factoryFixture), (char) => char.charCodeAt(0))
    : null;
  const presetBlob = preset
    ? Uint8Array.from(atob(preset), (char) => char.charCodeAt(0))
    : null;

  // The setlist fixture is real, but a save must be visible on the next read.
  // Extract the 128 names once and rebuild the stream when op 71 changes one.
  function scanSetlistNames(buffer: Uint8Array): string[] {
    const names: string[] = [];
    for (let i = 0; i + 4 < buffer.length && names.length < 128; i += 1) {
      if (buffer[i] !== 0xcd || buffer[i + 1] !== 0x00 || buffer[i + 2] !== 0x6d) {
        continue;
      }
      const tag = buffer[i + 3];
      if (tag < 0xa0 || tag > 0xbf) {
        continue;
      }
      const length = tag & 0x1f;
      const text = new TextDecoder().decode(
        buffer.slice(i + 4, i + 4 + length),
      );
      names.push(text.replace(/\0+$/, ''));
      i += 3 + length;
    }
    return names;
  }

  function buildSetlist(names: string[]): Uint8Array {
    const out: number[] = [0xdc, 0x00, 0x80];
    names.forEach((name, index) => {
      const raw = new TextEncoder().encode(`${name}\0`);
      out.push(
        0x81,
        0xcd,
        (index >> 8) & 0xff,
        index & 0xff,
        0x84,
        0xcd,
        0x00,
        0x6d,
        0xa0 | raw.length,
        ...raw,
        0x7b,
        0xc2,
        0x7c,
        0xc2,
        0x7d,
        0x00,
      );
    });
    return Uint8Array.from(out);
  }

  const setlistNames = scanSetlistNames(bytes);
  let setlistBytes =
    setlistNames.length === 128 ? buildSetlist(setlistNames) : bytes;
  // The active preset arrives as a complete {102, 103, 104} message whose key
  // 104 is a bin8 blob: `83 cd 00 66 <txn> cd 00 67 00 cd 00 68 c4 <len>`.
  let objectMessage = (() => {
    if (!presetBlob) {
      return new Uint8Array(0);
    }
    const message = new Uint8Array(14 + presetBlob.length);
    message.set([
      0x83, 0xcd, 0x00, 0x66, 0xcd, 0x03, 0xea, 0xcd, 0x00, 0x67, 0x00, 0xcd,
      0x00, 0x68,
    ]);
    // bin8 for blobs under 256 bytes, bin16 otherwise.
    if (presetBlob.length < 256) {
      const out = new Uint8Array(14 + 2 + presetBlob.length);
      out.set(message.slice(0, 14));
      out[14] = 0xc4;
      out[15] = presetBlob.length;
      out.set(presetBlob, 16);
      return out;
    }
    const out = new Uint8Array(14 + 3 + presetBlob.length);
    out.set(message.slice(0, 14));
    out[14] = 0xc5;
    out[15] = (presetBlob.length >> 8) & 0xff;
    out[16] = presetBlob.length & 0xff;
    out.set(presetBlob, 17);
    return out;
  })();
  if (padObject && objectMessage.length > 0) {
    // Hardware symptom: the last chunk is sent at full size, so zero padding
    // follows the MessagePack map. The blob's own length is authoritative.
    const padded = new Uint8Array(objectMessage.length + 9);
    padded.set(objectMessage);
    objectMessage = padded;
  }
  // Object 23 (active state): {102: 1002, 103: 0, 104: {107: 0, 108: 2,
  // 109: "US Deluxe Nrm\0"}}. Keys are encoded as uint16, like the device.
  const stateMessage = (() => {
    const name = new TextEncoder().encode('US Deluxe Nrm\0');
    const head = Uint8Array.from([
      0x83, 0xcd, 0x00, 0x66, 0xcd, 0x03, 0xea, 0xcd, 0x00, 0x67, 0x00, 0xcd,
      0x00, 0x68, 0x83, 0xcd, 0x00, 0x6b, 0x01, 0xcd, 0x00, 0x6c, 0x02, 0xcd,
      0x00, 0x6d, 0xd9, name.length,
    ]);
    const out = new Uint8Array(head.length + name.length);
    out.set(head);
    out.set(name, head.length);
    return out;
  })();
  // The operation byte of an open request is at index 30 (the MessagePack body
  // starts at 24: `83 66 cd <txn> 64 <op> …`).
  const objectOperation = (request: Uint8Array) =>
    request.length > 30 && request[11] === 0x04 ? request[30] : null;
  // `null` until an object-22/23 open: setlist reads reuse the chunk shape
  // without opening a preset object, so they must keep serving the setlist.
  let currentObject: number | null = null;
  // `0` after an open stream that selected Factory, `1` for User.
  let currentSetlist = 1;
  let dropNextRequest = false;
  let droppedHandshake = false;
  const queued: Uint8Array[] = [];
  let pendingIn: ((result: USBInTransferResult) => void) | null = null;
  let droppedWriteHandshake = false;

  const outEndpoint: USBEndpoint = {
    endpointNumber: 0x01,
    direction: 'out',
    type: 'bulk',
    packetSize: 512,
  };
  // WebUSB reports the endpoint number without the direction bit: the bulk IN
  // endpoint is address 0x81, so `endpointNumber` is 1, like the OUT endpoint.
  const inEndpoint: USBEndpoint = {
    endpointNumber: 0x01,
    direction: 'in',
    type: 'bulk',
    packetSize: 512,
  };
  const alternate: USBAlternateInterface = {
    alternateSetting: 0,
    interfaceClass: 0xff,
    interfaceSubclass: 0,
    interfaceProtocol: 0,
    endpoints: [outEndpoint, inEndpoint],
  };
  const iface: USBInterface = {
    interfaceNumber: 0,
    alternate,
    alternates: [alternate],
    claimed: false,
  };
  const configuration: USBConfiguration = {
    configurationValue: 1,
    configurationName: 'fake POD Go',
    interfaces: [iface],
  };

  function view(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  // --- Write channel (0x1080 -> 0x03ED) ----------------------------------
  //
  // The fake pedal answers the four handshake packets, then the `set_param`
  // command with one framed status echo. Every request is recorded on
  // `window.__podgoWrites` so the test can check the frame the app built.

  function writeHeader(
    request: Uint8Array,
    total: number,
    framed: boolean,
  ): Uint8Array {
    const response = new Uint8Array(total);
    response[0] = framed ? 0x19 : 0x0c;
    response[3] = 0x18;
    // Mirror source/destination: 0x03ED -> 0x1080 for write responses.
    response[4] = request[6];
    response[5] = request[7];
    response[6] = request[4];
    response[7] = request[5];
    response[9] = request[9];
    response[11] = 0x04;
    return response;
  }

  function bareWriteAck(request: Uint8Array): Uint8Array {
    return writeHeader(request, 16, false);
  }

  function framedWriteAck(request: Uint8Array, body: Uint8Array): Uint8Array {
    const response = writeHeader(request, 16 + 8 + body.length, true);
    response[16] = 0x00;
    response[17] = 0x00;
    response[18] = 0x06;
    response[19] = 0x00;
    response[20] = body.length & 0xff;
    response[21] = (body.length >> 8) & 0xff;
    response.set(body, 24);
    return response;
  }

  /** `{102: transaction, 103: status, 104: nil}`, 9 bytes. */
  function statusBody(transaction: number, status = 0): Uint8Array {
    return Uint8Array.from([
      0x83,
      0x66,
      0xcd,
      (transaction >> 8) & 0xff,
      transaction & 0xff,
      0x67,
      status,
      0x68,
      0xc0,
    ]);
  }

  /**
   * Minimal reader for a write command body: the outer map is
   * `{102: tx, 100: op, 101: {…}}`. Only `op`, `108` and `109` are needed.
   * Fixed keys and canonical widths keep this small; the unit tests cover the
   * full encoder.
   */
  function readCommandBody(
    data: Uint8Array,
    start: number,
  ): { op: number; slot: number; name: string } {
    let op = 0;
    let slot = -1;
    let name = '';
    let pos = start;
    const outer = data[pos++] & 0x0f;
    for (let i = 0; i < outer; i += 1) {
      const key = data[pos++];
      if (key === 0x66) {
        // 102: transaction, uint8/16/32/64 or fixint.
        const tag = data[pos++];
        pos +=
          tag === 0xcc
            ? 1
            : tag === 0xcd
              ? 2
              : tag === 0xce
                ? 4
                : tag === 0xcf
                  ? 8
                  : 0;
      } else if (key === 0x64) {
        op = data[pos++];
      } else if (key === 0x65) {
        const inner = data[pos++] & 0x0f;
        for (let j = 0; j < inner; j += 1) {
          const innerKey = data[pos++];
          if (innerKey === 0x6b || innerKey === 0x6c) {
            const tag = data[pos++];
            const value =
              tag === 0xcc
                ? data[pos++]
                : tag === 0xcd
                  ? (data[pos++] << 8) | data[pos++]
                  : tag;
            if (innerKey === 0x6c) {
              slot = value;
            }
          } else if (innerKey === 0x6d) {
            const tag = data[pos++];
            const length = tag & 0x1f;
            name = new TextDecoder()
              .decode(data.slice(pos, pos + length))
              .replace(/\0+$/, '');
            pos += length;
          } else {
            // Any other parameter value is irrelevant here.
            const tag = data[pos++];
            pos +=
              tag === 0xca
                ? 4
                : tag === 0xcb
                  ? 8
                  : tag === 0xcc
                    ? 1
                    : tag === 0xcd
                      ? 2
                      : tag === 0xce
                        ? 4
                        : tag === 0xcf
                          ? 8
                          : 0;
          }
        }
      }
    }
    return { op, slot, name };
  }

  function writeResponseFor(request: Uint8Array): Uint8Array | null {
    const seq = request[9];
    if (seq < 0x05) {
      // Hardware symptom (2026-11-13): the first write handshake after a read
      // session is ignored. One silent packet per session; the driver must
      // replay the sequence in place.
      if (dropFirstWriteHandshake && !droppedWriteHandshake) {
        droppedWriteHandshake = true;
        return null;
      }
      // Handshake packets 1-3 get a bare ack; packet 4 opens object 76 and
      // carries a framed status, which advances the write cursor.
      return seq === 0x04
        ? framedWriteAck(request, statusBody(1000))
        : bareWriteAck(request);
    }

    // `set_param` / `save_preset` command body: {102: tx, 100: op, 101: {…}}.
    const store = window as unknown as { __podgoWrites?: number[][] };
    store.__podgoWrites = store.__podgoWrites ?? [];
    store.__podgoWrites.push(Array.from(request));
    const decoded = readCommandBody(request, 24);
    if (decoded.op === 71) {
      const slot = decoded.slot;
      const savedName = decoded.name;
      if (
        Number.isInteger(slot) &&
        slot >= 0 &&
        slot < setlistNames.length
      ) {
        setlistNames[slot] = savedName;
        setlistBytes = buildSetlist(setlistNames);
      }
    }
    const transaction =
      request.length > 28 ? (request[27] << 8) | request[28] : 0;
    return framedWriteAck(request, statusBody(transaction));
  }

  // --- Restore stream (op 5 on the read channel) ---------------------------
  //
  // The app streams one op-5 message per preset. The fake acknowledges every
  // frame with a framed status 1, as the pedal does in
  // `podgo-backup-restore.pcapng`. Completed messages are recorded on
  // `window.__podgoRestore` for the test.

  interface RestoreState {
    declared: number;
    received: number;
    setlist: number;
    slot: number;
  }
  let restore: RestoreState | null = null;

  function skipValue(data: Uint8Array, start: number): number {
    const tag = data[start];
    if (tag <= 0x7f || tag >= 0xe0) {
      return start + 1;
    }
    switch (tag) {
      case 0xc0:
      case 0xc2:
      case 0xc3:
      case 0xc4:
      case 0xd9:
        return start + 2 + (tag === 0xd9 || tag === 0xc4 ? data[start + 1] : 0);
      case 0xcc:
        return start + 2;
      case 0xcd:
        return start + 3;
      case 0xce:
        return start + 5;
      case 0xcf:
        return start + 9;
      case 0xca:
        return start + 5;
      case 0xcb:
        return start + 9;
      case 0xc5:
        return start + 3 + ((data[start + 1] << 8) | data[start + 2]);
      case 0xda:
        return start + 3 + ((data[start + 1] << 8) | data[start + 2]);
      case 0xdb:
        return (
          start +
          5 +
          ((data[start + 1] << 24) |
            (data[start + 2] << 16) |
            (data[start + 3] << 8) |
            data[start + 4])
        );
      default:
        return start + 1;
    }
  }

  function readSmallUint(data: Uint8Array, start: number): [number, number] {
    const tag = data[start];
    if (tag === 0xcc) {
      return [data[start + 1], start + 2];
    }
    if (tag === 0xcd) {
      return [(data[start + 1] << 8) | data[start + 2], start + 3];
    }
    if (tag === 0xce) {
      return [
        (data[start + 1] << 24) |
          (data[start + 2] << 16) |
          (data[start + 3] << 8) |
          data[start + 4],
        start + 5,
      ];
    }
    return [tag & 0x7f, start + 1];
  }

  /** Parse an op-5 first frame, or `null` for any other read frame. */
  function restoreStart(
    request: Uint8Array,
  ): { setlist: number; slot: number; declared: number } | null {
    if (
      request.length < 32 ||
      request[4] !== 0x01 ||
      request[5] !== 0x10 ||
      request[16] !== 0x01 ||
      request[17] !== 0x00 ||
      request[18] !== 0x02 ||
      request[19] !== 0x00 ||
      request[24] !== 0x83
    ) {
      return null;
    }
    // Outer map {102: tx, 100: op, 101: {…}}.
    let pos = 25;
    if (request[pos] !== 0x66) {
      return null;
    }
    pos += 1;
    pos = skipValue(request, pos); // 102: transaction
    if (request[pos] !== 0x64 || request[pos + 1] !== 0x05) {
      return null;
    }
    pos += 2;
    if (request[pos] !== 0x65) {
      return null;
    }
    pos += 1;
    const count = request[pos] & 0x0f;
    pos += 1;
    let setlist = -1;
    let slot = -1;
    for (let index = 0; index < count; index += 1) {
      const key = request[pos];
      pos += 1;
      if (key === 0x6b) {
        const [value, next] = readSmallUint(request, pos);
        setlist = value;
        pos = next;
      } else if (key === 0x6c) {
        const [value, next] = readSmallUint(request, pos);
        slot = value;
        pos = next;
      } else {
        pos = skipValue(request, pos);
      }
    }
    const declared =
      (request[20] |
        (request[21] << 8) |
        (request[22] << 16) |
        (request[23] << 24)) >>>
      0;
    return { setlist, slot, declared };
  }

  function restoreStatusFrame(
    request: Uint8Array,
    status: number,
  ): Uint8Array {
    const body = statusBody(0, status);
    const total = 16 + 8 + body.length;
    const padded = (total + 3) & ~3;
    const response = new Uint8Array(padded);
    // Capture shape: header `u16` = 16 + body length, then `00 00 02 00`.
    response[0] = (16 + body.length) & 0xff;
    response[1] = (16 + body.length) >> 8;
    response[3] = 0x18;
    response[4] = request[6];
    response[5] = request[7];
    response[6] = request[4];
    response[7] = request[5];
    response[9] = (request[9] + 1) & 0xff;
    response[11] = 0x04;
    response[12] = request[12];
    response[13] = request[13];
    response[14] = request[14];
    response[15] = request[15];
    response[16] = 0x00;
    response[17] = 0x00;
    response[18] = 0x02;
    response[19] = 0x00;
    response[20] = body.length & 0xff;
    response[21] = (body.length >> 8) & 0xff;
    response.set(body, 24);
    return response;
  }

  /**
   * Accumulate stream bytes and acknowledge every frame.
   *
   * The pedal answers each USB packet with `{102, 103: 1, 104: nil}`
   * (`podgo-backup-restore.pcapng`), not a fixed 1536-byte window.
   */
  function restoreResponse(
    request: Uint8Array,
    data: number,
  ): Uint8Array | null {
    if (!restore) {
      return null;
    }
    const real = Math.min(data, restore.declared - restore.received);
    restore.received += real;
    const state = restore;
    const done = state.received >= state.declared;

    if (done) {
      recordRestore(state);
      restore = null;
    }
    return restoreStatusFrame(request, 1);
  }

  function recordRestore(state: RestoreState): void {
    const store = window as unknown as {
      __podgoRestore?: Array<{ setlist: number; slot: number; bytes: number }>;
    };
    store.__podgoRestore = store.__podgoRestore ?? [];
    store.__podgoRestore.push({
      setlist: state.setlist,
      slot: state.slot,
      bytes: state.received,
    });
  }

  function responseFor(request: Uint8Array): Uint8Array | null {
    if (request[4] === 0x80 && request[5] === 0x10) {
      return writeResponseFor(request);
    }
    if (request[4] === 0x01 && request[5] === 0x10) {
      const start = restoreStart(request);
      if (start) {
        restore = { ...start, received: 0 };
        const response = restoreResponse(request, request.length - 24);
        if (response) {
          return response;
        }
      } else if (restore && request.length > 16) {
        const response = restoreResponse(request, request.length - 16);
        if (response) {
          return response;
        }
      }
    }
    // A new read session starts with its 20-byte handshake packet: drop the
    // object opened by a previous session so a later setlist read is served.
    if (
      request.length === 20 &&
      request[4] === 0x01 &&
      request[5] === 0x10
    ) {
      currentObject = null;
    }
    // `OPEN_STREAM` selects the setlist at byte 34.
    if (request.length === 40 && request[11] === 0x0c) {
      currentSetlist = request[34] === 0 ? 0 : 1;
    }
    const seq = request[9];
    const cursor =
      (request[12] |
        (request[13] << 8) |
        (request[14] << 16) |
        (request[15] << 24)) >>>
      0;
    let payload = new Uint8Array(0);

    const operation = objectOperation(request);
    if (operation === 23 && ignoreObject23) {
      // Hardware symptom: the device stays silent for object 23.
      return null;
    }
    if (operation === 22 || operation === 23) {
      // Streamed object: the open acknowledgement carries no data.
      currentObject = operation;
      payload = new Uint8Array(0);
    } else if (
      request.length === 16 &&
      seq >= 0x08 &&
      cursor >= 0x1000
    ) {
      const stream =
        currentObject === 23
          ? stateMessage
          : currentObject === 22 && objectMessage.length > 0
            ? objectMessage
            : currentSetlist === 0 && factoryBytes
              ? factoryBytes
              : setlistBytes;
      const relative = cursor - 0x1000;
      if (relative < stream.length) {
        const end = Math.min(relative + 496, stream.length);
        payload = stream.slice(relative, end);
      } else if (dropHandshakeAfterObject && !droppedHandshake) {
        // The pedal goes silent on the first handshake after an object.
        droppedHandshake = true;
        dropNextRequest = true;
      }
    }

    const response = new Uint8Array(16 + payload.length);
    response[0] = 0x08;
    response[3] = 0x18;
    // Mirror source/destination so the transport accepts this as the reply.
    response[4] = request[6];
    response[5] = request[7];
    response[6] = request[4];
    response[7] = request[5];
    response[9] = request[9];
    response[11] = 0x04;
    response.set(payload, 16);
    return response;
  }

  function deliver(packet: Uint8Array): void {
    if (pendingIn) {
      const resolve = pendingIn;
      pendingIn = null;
      resolve({ status: 'ok', data: view(packet) });
    } else {
      queued.push(packet);
    }
  }

  // A busy pedal also pushes event-channel frames (`0x03F0 → 0x1002`). They
  // are queued by the transport and must not starve the read channel. The
  // timer keeps the flood asynchronous: returning frames in a synchronous
  // loop would starve the page's timers (and hide the real timeout).
  function scheduleEventFrame(): void {
    const resolve = pendingIn;
    if (!resolve) {
      return;
    }
    setTimeout(() => {
      if (pendingIn === resolve) {
        pendingIn = null;
        resolve({ status: 'ok', data: view(eventFrame()) });
      }
    }, 20);
  }

  // A busy pedal also pushes event-channel frames (`0x03F0 → 0x1002`). They
  // are queued by the transport and must not starve the read channel.
  function eventFrame(): Uint8Array {
    const frame = new Uint8Array(32);
    frame[0] = 0x10;
    frame[3] = 0x18;
    frame[4] = 0xf0;
    frame[5] = 0x03;
    frame[6] = 0x02;
    frame[7] = 0x10;
    frame[11] = 0x04;
    return frame;
  }

  function isEventFrame(packet: Uint8Array): boolean {
    return packet.length >= 8 && packet[4] === 0xf0 && packet[5] === 0x03;
  }

  const device = {
    opened: false,
    vendorId: 0x0e41,
    productId: 0x4247,
    productName: 'POD Go (fake)',
    configuration: null as USBConfiguration | null,
    configurations: [configuration],
    async open() {
      this.opened = true;
    },
    async close() {
      this.opened = false;
    },
    async selectConfiguration(value: number) {
      if (value !== 1) {
        throw new Error(`unexpected configuration ${value}`);
      }
      this.configuration = configuration;
    },
    async claimInterface(number: number) {
      if (number !== 0) {
        throw new Error(`unexpected interface ${number}`);
      }
      iface.claimed = true;
    },
    async releaseInterface() {
      iface.claimed = false;
    },
    async selectAlternateInterface() {
      // no-op
    },
    async clearHalt() {
      // no-op
    },
    async reset() {
      // no-op
    },
    async transferIn(endpointNumber: number): Promise<USBInTransferResult> {
      if (endpointNumber !== 0x01) {
        throw new Error(`unexpected IN endpoint ${endpointNumber}`);
      }
      const next = queued.shift();
      if (next) {
        return { status: 'ok', data: view(next) };
      }
      return new Promise((resolve) => {
        pendingIn = resolve;
        if (eventFlood) {
          scheduleEventFrame();
        }
      });
    },
    async transferOut(
      endpointNumber: number,
      data: BufferSource,
    ): Promise<USBOutTransferResult> {
      if (endpointNumber !== 0x01) {
        throw new Error(`unexpected OUT endpoint ${endpointNumber}`);
      }
      const request = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      if (dropNextRequest) {
        dropNextRequest = false;
        return { status: 'ok', bytesWritten: request.length };
      }
      const response = responseFor(request);
      if (response) {
        // With `eventFlood`, an event frame lands ahead of the reply so the
        // transport has to skip it to reach the mirrored channel.
        if (eventFlood && !isEventFrame(response)) {
          deliver(eventFrame());
        }
        deliver(response);
      }
      return { status: 'ok', bytesWritten: request.length };
    },
  };

  const fakeUsb = {
    async requestDevice() {
      return device;
    },
    async getDevices() {
      return [device];
    },
    addEventListener() {
      // no-op
    },
    removeEventListener() {
      // no-op
    },
  };

  Object.defineProperty(navigator, 'usb', {
    value: fakeUsb,
    configurable: true,
  });
}

/**
 * Minimal MessagePack reader for the write-frame assertions: maps (numeric
 * keys), fixints, uint/int, float32/64, bool and nil are enough for the
 * `set_param` body.
 */
type MsgValue =
  | number
  | boolean
  | null
  | string
  | MsgValue[]
  | { [key: number]: MsgValue };

function readMsgpack(
  data: Uint8Array,
  start: number,
): { value: MsgValue; next: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = data[start];
  if (tag <= 0x7f) {
    return { value: tag, next: start + 1 };
  }
  if (tag >= 0xe0) {
    return { value: tag - 0x100, next: start + 1 };
  }
  if ((tag & 0xf0) === 0x80) {
    const entries: { [key: number]: MsgValue } = {};
    let pos = start + 1;
    for (let index = 0; index < (tag & 0x0f); index += 1) {
      const key = readMsgpack(data, pos);
      const value = readMsgpack(data, key.next);
      entries[Number(key.value)] = value.value;
      pos = value.next;
    }
    return { value: entries, next: pos };
  }
  if ((tag & 0xf0) === 0x90) {
    const items: MsgValue[] = [];
    let pos = start + 1;
    for (let index = 0; index < (tag & 0x0f); index += 1) {
      const item = readMsgpack(data, pos);
      items.push(item.value);
      pos = item.next;
    }
    return { value: items, next: pos };
  }
  if ((tag & 0xe0) === 0xa0) {
    const length = tag & 0x1f;
    const text = new TextDecoder().decode(
      data.slice(start + 1, start + 1 + length),
    );
    return { value: text, next: start + 1 + length };
  }
  switch (tag) {
    case 0xc0:
      return { value: null, next: start + 1 };
    case 0xc2:
      return { value: false, next: start + 1 };
    case 0xc3:
      return { value: true, next: start + 1 };
    case 0xca:
      return { value: view.getFloat32(start + 1), next: start + 5 };
    case 0xcb:
      return { value: view.getFloat64(start + 1), next: start + 9 };
    case 0xcc:
      return { value: data[start + 1], next: start + 2 };
    case 0xcd:
      return { value: view.getUint16(start + 1), next: start + 3 };
    case 0xce:
      return { value: view.getUint32(start + 1), next: start + 5 };
    case 0xcf:
      return { value: Number(view.getBigUint64(start + 1)), next: start + 9 };
    case 0xd0:
      return { value: view.getInt8(start + 1), next: start + 2 };
    case 0xd1:
      return { value: view.getInt16(start + 1), next: start + 3 };
    case 0xd2:
      return { value: view.getInt32(start + 1), next: start + 5 };
    case 0xd9: {
      const length = data[start + 1];
      const text = new TextDecoder().decode(
        data.slice(start + 2, start + 2 + length),
      );
      return { value: text, next: start + 2 + length };
    }
    default:
      throw new Error(`unsupported MessagePack tag 0x${tag.toString(16)}`);
  }
}

test('reads the User setlist over a fake WebUSB device', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);

  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );
  await expect(page.locator('.device-info')).toContainText('read-only');
  // Displayed addresses keep the USB direction bit: OUT 0x01 / IN 0x81.
  await expect(page.locator('.device-info')).toContainText('OUT 0x01 / IN 0x81');

  await page.locator('#read-user').click();
  const report = page.locator('.device-report .report');
  await expect(report).toContainText('setlist:   128 entries');
  await expect(report).toContainText('slot 127');
  await expect(report).toContainText('Preset 037');
  await expect(page.locator('.device-report .source')).toContainText(
    '13 chunk',
  );

  // One button handles both directions: it reads Disconnect while connected
  // and returns to Connect after closing the session.
  await expect(page.locator('#connect')).toHaveText('Disconnect');
  await page.locator('#connect').click();
  await expect(page.locator('#connect')).toHaveText('Connect');
  await expect(page.locator('.device-card .badge')).toHaveText('No device');

  expect(errors).toEqual([]);
});

test('reads the active preset over a fake WebUSB device', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, {
    fixture,
    preset,
    padObject: true,
    dropHandshakeAfterObject: true,
  });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);

  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  await page.locator('#read-preset').click();
  const report = page.locator('.device-report .report');
  await expect(report).toContainText('container: l6-helix');
  await expect(report).toContainText('round-trip: byte-identical');
  await expect(page.locator('.device-report h2')).toHaveText('Active preset');
  await expect(page.locator('.device-report .source')).toContainText(
    /\d+ chunk\(s\)/,
  );

  // The editor pane is driven by the structured object-23/22 read.
  await expect(page.locator('.preset-title')).toContainText('01C');
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');
  await expect(page.locator('.preset-item.is-loaded')).toHaveCount(1);
  await expect(page.locator('.preset-item.is-loaded')).toContainText(
    'US Deluxe Nrm',
  );

  const blocks = page.locator('.block-tile');
  await expect(blocks).toHaveCount(10);
  await expect(blocks.nth(0)).toContainText('Volume');
  await expect(blocks.nth(1)).toContainText('Conductor');
  await expect(blocks.nth(7)).toContainText('Parametric');
  await expect(blocks.nth(0).locator('.block-assign')).toHaveText('EXP Toe');
  await expect(blocks.nth(7).locator('.block-assign')).toHaveText('FS1');
  await expect(page.locator('.chain-end')).toHaveCount(2);

  await expect(page.locator('.inspector-model')).toHaveText('Volume');
  await expect(page.locator('.param-row').first()).toContainText('Pedal');

  // The diagnostics log keeps a copyable trace of the session.
  await expect(page.locator('.diagnostics summary')).toContainText(
    'Diagnostics log',
  );
  await expect(page.locator('.report.log')).toContainText('Read active preset:');
  await page.locator('.diagnostics summary').click();
  await expect(page.locator('#copy-log')).toBeVisible();

  expect(errors).toEqual([]);
});

test('opens a preset slot from the librarian over a fake WebUSB device', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);

  await page.locator('#connect').click();
  await page.locator('#read-user').click();
  await expect(page.locator('.preset-item')).toHaveCount(128);
  await expect(page.locator('.device-report .report')).toContainText(
    'setlist:   128 entries',
  );
  await expect(page.locator('.report.error')).toHaveCount(0);

  // Operation 4 with {107: 1, 108: 5}: reads the slot body without recalling
  // it on the pedal, then names it from the setlist entry.
  const item = page
    .locator('.preset-item')
    .filter({ hasText: 'Preset 005' })
    .first();
  await item.click();

  await expect(page.locator('.preset-title')).toContainText('02B');
  await expect(page.locator('.preset-title-name')).toHaveText(/Preset 005/);
  await expect(page.locator('.device-report h2')).toHaveText('User 02B');
  const report = page.locator('.device-report .report');
  await expect(report).toContainText('container: l6-helix');
  await expect(report).toContainText('round-trip: byte-identical');
  await expect(page.locator('.preset-item.is-loaded')).toContainText(
    'Preset 005',
  );
  await expect(page.locator('.block-tile')).toHaveCount(10);

  expect(errors).toEqual([]);
});

/**
 * Regression for the hardware report of 2026-11-12: with the pedal also
 * pushing event-channel frames, "Read active preset" timed out after five
 * handshake attempts, and a librarian click failed with
 * "MessagePack string is not valid UTF-8".
 *
 * The fake device reproduces both symptoms:
 * - object 23 never answers (the read must fall back to object 22 alone);
 * - event frames keep arriving on the IN endpoint (the transport must not let
 *   them starve the read channel).
 */
test('falls back to an object-22 read when object 23 does not answer', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, {
    fixture,
    preset,
    ignoreObject23: true,
    eventFlood: true,
  });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  // The fake device stays silent for object 23, so the click cannot settle
  // until the fallback read finishes: do not wait for the click itself.
  await page
    .locator('#read-preset')
    .click({ noWaitAfter: true, timeout: 2_000 })
    .catch(() => undefined);

  // The fallback reads object 22 only, so the slot is unknown and the body
  // still parses into the editor.
  await expect(page.locator('.preset-title-name')).toHaveText('Active preset', {
    timeout: 15_000,
  });
  await expect(page.locator('.preset-title .preset-slot')).toHaveText('——');
  await expect(page.locator('.device-report .report')).toContainText(
    'round-trip: byte-identical',
  );
  await expect(page.locator('.block-tile')).toHaveCount(10);
  await expect(page.locator('.report.error')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('batch-saves parameter drafts with Ctrl+S after arming', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, {
    fixture,
    preset,
    dropFirstWriteHandshake: true,
  });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  // Connecting reads both setlists and the active preset automatically, so the
  // editor is editable right away. The write guard still starts unchecked.
  await expect(page.locator('#arm-writes')).toBeVisible();
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');
  await expect(page.locator('.readonly-chip')).toHaveText('draft');

  // Writing is the only gate: Save stays disabled until it is enabled.
  await expect(page.locator('#save-preset')).toBeDisabled();
  await page.locator('#arm-writes').check();
  await expect(page.locator('#save-preset')).toBeEnabled();

  // Processing tile 2 is Tube Drive, stored in raw chain slot 3 (input = 0).
  await page.locator('.block-tile').nth(2).click();
  await expect(page.locator('.inspector-model')).toHaveText('Tube Drive');
  await expect(page.locator('#param-value-0')).toHaveText('4.2');
  await page.locator('#param-value-0').click();
  const input = page.locator('#param-input-0');
  await expect(input).toHaveValue('4.2');
  await input.fill('5');
  await input.press('Enter');

  // The draft is visible but not written yet.
  await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');
  const writesBefore = await page.evaluate(
    () =>
      (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ?? [],
  );
  expect(writesBefore).toHaveLength(0);

  // Ctrl+S is the same as the Save button: one confirmation, one batch.
  let dialogMessage = '';
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    void dialog.accept();
  });
  await page.keyboard.press('Control+s');

  await expect(page.locator('.report.log')).toContainText(
    'Save: 0 model(s) and 1 parameter(s) applied in RAM',
  );
  // The pedal ignored the first write handshake; the driver replayed it.
  await expect(page.locator('.report.log')).toContainText(
    'handshake muet (1/5)',
  );
  expect(dialogMessage).toContain('Tube Drive');
  await expect(page.locator('#save-notice')).toContainText(
    '0 model(s) and 1 parameter(s) saved',
  );

  // The accepted value is reflected immediately without re-reading the pedal.
  const row = page.locator('.inspector .param-row').first();
  await expect(row.locator('.param-name')).toHaveText('Drive');
  await expect(row.locator('.param-value')).toHaveText('5.0');
  await expect(page.locator('.report.error')).toHaveCount(0);

  // Two commands: the parameter (op 30) then the store (op 71), so the change
  // survives a preset switch or a reboot.
  const writes = await page.evaluate(
    () =>
      (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ?? [],
  );
  expect(writes).toHaveLength(2);
  const decoded = readMsgpack(new Uint8Array(writes[0]), 24).value;
  const body = decoded as { [key: number]: MsgValue };
  expect(body[100]).toBe(30);
  const inner = body[101] as { [key: number]: MsgValue };
  expect(inner[98]).toBe(3);
  expect(inner[26]).toBe(0);
  expect(inner[28]).toBe(0);
  expect(inner[29]).toBe(true);
  expect(inner[119]).toBeCloseTo(0.5, 6);

  const stored = readMsgpack(new Uint8Array(writes[1]), 24).value as {
    [key: number]: MsgValue;
  };
  expect(stored[100]).toBe(71);
  const destination = stored[101] as { [key: number]: MsgValue };
  expect(destination[107]).toBe(1);
  expect(destination[109]).toBe('US Deluxe Nrm\0');

  expect(errors).toEqual([]);
});

test('saves the active preset after backing up the destination slot', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  // A save needs the active preset and an enabled editing session.
  await page.locator('#read-preset').click();
  await expect(page.locator('.block-tile')).toHaveCount(10);
  await page.locator('#arm-writes').check();

  await page.locator('#save-to-slot').click();
  await expect(page.locator('#save-dialog-title')).toBeVisible();

  await page.locator('#save-slot').fill('36');
  await page.locator('#save-name').fill('Saved Lead');

  // Saving stays disabled until the destination has been read and kept.
  await expect(page.locator('#save-confirm')).toBeDisabled();
  await page.locator('#save-backup').click();
  await expect(page.locator('.save-backup code')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.locator('#save-ack')).toBeEnabled();
  await page.locator('#save-ack').check();
  await expect(page.locator('#save-confirm')).toBeEnabled();
  await page.locator('#save-confirm').click();

  await expect(page.locator('.save-dialog')).toHaveCount(0);
  await expect(page.locator('.report.log')).toContainText('Save accepted');
  await expect(page.locator('.report.log')).toContainText('Save verified');
  await expect(page.locator('.preset-title-name')).toHaveText('Saved Lead');
  await expect(page.locator('.preset-list')).toContainText('Saved Lead');

  const writes = await page.evaluate(
    () =>
      (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ?? [],
  );
  expect(writes).toHaveLength(1);
  const decoded = readMsgpack(new Uint8Array(writes[0]), 24).value;
  const body = decoded as { [key: number]: MsgValue };
  expect(body[100]).toBe(71);
  const inner = body[101] as { [key: number]: MsgValue };
  expect(inner[107]).toBe(1);
  expect(inner[108]).toBe(36);
  expect(inner[109]).toBe('Saved Lead\0');

  expect(errors).toEqual([]);
});

test('backs up every slot and restores the streamed file', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const factoryFixture = smallSetlist(['Factory A']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, factoryFixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  // Restore needs editing enabled, and that needs a loaded preset.
  await page.locator('#read-preset').click();
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');
  await page.locator('#arm-writes').check();

  await page.locator('#backup-restore').click();
  await expect(page.locator('#backup-dialog-title')).toBeVisible();
  await expect(page.locator('#restore-confirm')).toBeDisabled();
  // The disabled button says what is missing, in one line.
  await expect(page.locator('#restore-blockers')).toContainText(
    'open a .pgbak file',
  );

  // Download a full backup; it doubles as the optional safety copy and as the
  // file to restore. It is not a precondition.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#backup-create').click(),
  ]);
  await expect(page.locator('#backup-fresh-digest')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.locator('.backup-dialog .save-backup-info').first()).toContainText(
    '3',
  );

  // Re-open the downloaded file: Rust verifies it and the diff lists both
  // setlists. The write button is the only gate, so it turns on immediately.
  const path = await download.path();
  expect(path).not.toBeNull();
  await page.locator('#restore-file').setInputFiles(path ?? '');
  await expect(page.locator('#restore-diff')).toContainText('Factory');
  await expect(page.locator('#restore-diff')).toContainText('User');
  await expect(page.locator('#restore-confirm-word')).toHaveCount(0);
  await expect(page.locator('#restore-ack')).toHaveCount(0);
  await expect(page.locator('#restore-blockers')).toHaveCount(0);
  await expect(page.locator('#restore-confirm')).toBeEnabled();

  // One confirmation, then the stream.
  let restoreDialog = '';
  page.once('dialog', (dialog) => {
    restoreDialog = dialog.message();
    void dialog.accept();
  });
  await page.locator('#restore-confirm').click();
  expect(restoreDialog).toContain('Restore 3 preset(s)');
  await expect(page.locator('.backup-dialog')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('.report.log')).toContainText(
    'Restore verified: 3 name(s) match the backup.',
  );

  // The fake records one completed op-5 message per preset, in file order
  // (Factory first, then User).
  const messages = await page.evaluate(
    () =>
      (
        window as unknown as {
          __podgoRestore?: Array<{
            setlist: number;
            slot: number;
            bytes: number;
          }>;
        }
      ).__podgoRestore ?? [],
  );
  expect(messages).toHaveLength(3);
  expect(messages.map((message) => `${message.setlist}:${message.slot}`)).toEqual(
    ['0:0', '1:0', '1:1'],
  );
  expect(messages.every((message) => message.bytes > 0)).toBe(true);

  expect(errors).toEqual([]);
});

test('backs up only the selected setlist or slots', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const factoryFixture = smallSetlist(['Factory A']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, factoryFixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  await page.locator('#backup-restore').click();
  await expect(page.locator('#backup-dialog-title')).toBeVisible();

  // User setlist scope: two entries, no Factory slot in the file.
  await page.locator('#backup-scope-user').check();
  await expect(page.locator('#backup-create')).toHaveText(
    'Download 2 preset(s)',
  );
  const [userDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#backup-create').click(),
  ]);
  const userBackup = readPgbak(
    readFileSync((await userDownload.path()) ?? ''),
  );
  expect(userBackup.entries.map((entry) => `${entry.setlist}:${entry.slot}`)).toEqual([
    '1:0',
    '1:1',
  ]);
  expect(userBackup.entries.map((entry) => entry.name)).toEqual([
    'Lead A',
    'Lead B',
  ]);
  expect(userBackup.entries.every((entry) => entry.blob.length > 0)).toBe(
    true,
  );

  // Custom scope: one Factory slot only.
  await page.locator('#backup-scope-custom').check();
  await page.locator('.backup-picker-tabs button').first().click();
  await page.locator('[data-backup-slot="0:0"]').check();
  await expect(page.locator('#backup-picked-count')).toHaveText(
    '1 slot(s) selected.',
  );
  const [factoryDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#backup-create').click(),
  ]);
  const factoryBackup = readPgbak(
    readFileSync((await factoryDownload.path()) ?? ''),
  );
  expect(
    factoryBackup.entries.map((entry) => `${entry.setlist}:${entry.slot}`),
  ).toEqual(['0:0']);
  expect(factoryBackup.entries[0]?.name).toBe('Factory A');

  expect(errors).toEqual([]);
});

test('restores only the checked presets from a .pgbak', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const factoryFixture = smallSetlist(['Factory A']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, factoryFixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await page.locator('#read-preset').click();
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');
  await page.locator('#arm-writes').check();

  await page.locator('#backup-restore').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#backup-create').click(),
  ]);
  await page.locator('#restore-file').setInputFiles((await download.path()) ?? '');
  await expect(page.locator('#restore-selection')).toBeVisible();
  await expect(page.locator('[data-restore-entry]')).toHaveCount(3);
  await expect(page.locator('#restore-confirm')).toHaveText(
    'Restore 3 preset(s)',
  );

  // Nothing selected: restore is refused with a specific reason.
  await page.locator('#restore-select-none').click();
  await expect(page.locator('#restore-confirm')).toBeDisabled();
  await expect(page.locator('#restore-blockers')).toContainText(
    'select at least one preset',
  );
  await page.locator('#restore-select-all').click();

  // Keep only User 01A; Factory and User 01B stay checked off.
  await page.locator('[data-restore-entry="0:0"]').uncheck();
  await page.locator('[data-restore-entry="1:1"]').uncheck();
  await expect(page.locator('#restore-confirm')).toHaveText(
    'Restore 1 preset(s)',
  );

  let message = '';
  page.once('dialog', (dialog) => {
    message = dialog.message();
    void dialog.accept();
  });
  await page.locator('#restore-confirm').click();
  expect(message).toContain('Restore 1 preset(s)');
  await expect(page.locator('.backup-dialog')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.locator('.report.log')).toContainText(
    'Restore verified: 1 name(s) match the backup.',
  );

  const messages = await page.evaluate(
    () =>
      (
        window as unknown as {
          __podgoRestore?: Array<{
            setlist: number;
            slot: number;
            bytes: number;
          }>;
        }
      ).__podgoRestore ?? [],
  );
  expect(messages.map((entry) => `${entry.setlist}:${entry.slot}`)).toEqual([
    '1:0',
  ]);
  expect(errors).toEqual([]);
});

test('copies, pastes, moves and renames presets in the local library', async ({
  page,
}) => {
  const fixture = readFileSync(
    new URL('../public/fixtures/user_setlist.bin', import.meta.url),
  ).toString('base64');
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  await page.locator('#read-user').click();
  await expect(page.locator('.librarian-count')).toHaveText('128/128');

  await page.locator('#read-preset').click();
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');

  await page.locator('#preset-actions').click();
  await expect(page.locator('#preset-actions-title')).toBeVisible();

  // Copy puts the loaded body in the in-page clipboard.
  await page.locator('#copy-preset').click();
  await expect(page.locator('#clipboard-info')).toContainText('US Deluxe Nrm');

  // Paste into User slot 5: local model + pending marker only.
  await page.locator('#paste-slot').selectOption('5');
  await page.locator('#paste-name').fill('Copied Lead');
  await page.locator('#paste-local').click();
  await expect(page.locator('#pending-edits')).toContainText(
    'paste → Copied Lead',
  );

  // Rename the loaded preset locally.
  await page.locator('#rename-name').fill('My Lead');
  await page.locator('#rename-local').click();
  await expect(page.locator('#pending-edits')).toContainText(
    'rename → My Lead',
  );

  // Move the clipboard to User slot 6: the destination gets the body and the
  // local source is marked as cleared, but nothing is written to the pedal.
  await page.locator('#paste-slot').selectOption('6');
  await page.locator('#paste-name').fill('Moved Lead');
  await page.locator('#move-local').click();
  await expect(page.locator('#pending-edits')).toContainText(
    'move → Moved Lead',
  );
  await expect(page.locator('#pending-edits')).toContainText(
    'cleared locally (not written)',
  );

  // No write was attempted: the fake records no restore stream.
  const messages = await page.evaluate(
    () =>
      (
        window as unknown as {
          __podgoRestore?: unknown[];
        }
      ).__podgoRestore ?? [],
  );
  expect(messages).toHaveLength(0);

  await page.locator('.preset-actions .modal-close').click();

  // The librarian reflects the local paste/move names on the User tab.
  await page.getByRole('tab', { name: /User/ }).click();
  await expect(
    page.locator('.preset-item').nth(5).locator('.preset-name'),
  ).toHaveText('Copied Lead');
  await expect(
    page.locator('.preset-item').nth(6).locator('.preset-name'),
  ).toHaveText('Moved Lead');
});

test('writes a paste and a rename with one confirmation each', async ({
  page,
}) => {
  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await page.locator('#read-user').click();
  await page.locator('#read-preset').click();
  await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');

  // Arming is the only switch; no full backup is required.
  await page.locator('#arm-writes').check();
  await page.locator('#preset-actions').click();
  await expect(page.locator('#preset-actions-title')).toBeVisible();
  await expect(page.locator('#actions-blockers')).toHaveCount(0);

  await page.locator('#copy-preset').click();
  await page.locator('#paste-slot').selectOption('7');
  await page.locator('#paste-name').fill('Pasted Lead');
  await expect(page.locator('#paste-write')).toBeEnabled();

  let pasteMessage = '';
  page.once('dialog', (dialog) => {
    pasteMessage = dialog.message();
    void dialog.accept();
  });
  await page.locator('#paste-write').click();
  expect(pasteMessage).toContain('User 02D');
  await expect(page.locator('.report.log')).toContainText('Preset write:');

  // The paste wrote a one-entry op-5 stream.
  const messages = await page.evaluate(
    () =>
      (
        window as unknown as {
          __podgoRestore?: Array<{ setlist: number; slot: number }>;
        }
      ).__podgoRestore ?? [],
  );
  expect(messages).toHaveLength(1);
  expect(`${messages[0].setlist}:${messages[0].slot}`).toBe('1:7');

  // Rename the active User preset: still one confirmation, no backup.
  await page.locator('#rename-name').fill('Renamed Lead');
  await expect(page.locator('#rename-write')).toBeEnabled();
  let renameMessage = '';
  page.once('dialog', (dialog) => {
    renameMessage = dialog.message();
    void dialog.accept();
  });
  await page.locator('#rename-write').click();
  expect(renameMessage).toContain('Renamed Lead');
  await expect(page.locator('.report.log')).toContainText('Rename accepted');
  // The fake setlist is static, so the verification re-read warns; what this
  // test proves is that one confirmation was enough to send the write.
  await expect(page.locator('.report.log')).toContainText(
    'rename verification',
  );
});

test('shows an offline message when WebUSB is missing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'usb', {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await expect(page.locator('#connect')).toBeDisabled();
  await expect(page.locator('#offline-notice')).toBeVisible();
  await openDevTools(page);
  await expect(page.locator('.device-card .badge')).toHaveText(
    /WebUSB unavailable/,
  );
  await expect(page.locator('.inline-error')).toContainText(
    "WebUSB is not available",
  );
});


test('keeps the write arm when switching presets', async ({ page }) => {
  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  await page.locator('#arm-writes').check();
  await expect(page.locator('#arm-writes')).toBeChecked();

  // Opening another slot from the librarian must not disarm the session.
  await page.getByRole('tab', { name: /User/ }).click();
  await page.locator('.preset-item').nth(1).click();
  await expect(page.locator('.preset-title')).toContainText('Lead Bread-only');
  await expect(page.locator('#arm-writes')).toBeChecked();

  // Re-reading the active preset keeps it too.
  await page.locator('#read-preset').click();
  await expect(page.locator('#arm-writes')).toBeChecked();
});

test('copies a pedal slot from the right-click menu without opening it', async ({
  page,
}) => {
  const fixture = smallSetlist(['Lead A', 'Lead B']);
  const preset = readFileSync(
    new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
  ).toString('base64');
  await page.addInitScript(fakeWebUsb, { fixture, preset });

  await page.goto('/');
  await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
  await openDevTools(page);
  await page.locator('#connect').click();
  await expect(page.locator('.device-card .badge')).toHaveText(
    /POD Go \(fake\)/,
  );

  await page.getByRole('tab', { name: /User/ }).click();
  // Slot 2 is not open: the body has to come from a pedal read.
  await page.locator('.preset-item').nth(1).click({ button: 'right' });
  await expect(page.locator('#menu-copy')).toBeEnabled();
  await page.locator('#menu-copy').click();

  await expect(page.locator('.report.log')).toContainText(
    'Copy: reading User',
  );
  await expect(page.locator('#save-notice')).toHaveCount(0);
  await expect(page.locator('.report.log')).toContainText('Clipboard:');
  await expect(page.locator('.report.error')).toHaveCount(0);
});

test.describe('editing a connected preset on a phone viewport', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
  });

  test('drafts a model change and saves it with op 40', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    let dialogSeen = false;
    const dialogMessages: string[] = [];
    page.on('dialog', (dialog) => {
      dialogSeen = true;
      dialogMessages.push(dialog.message());
      void dialog.accept();
    });

    const fixture = readFileSync(
      new URL('../public/fixtures/user_setlist.bin', import.meta.url),
    ).toString('base64');
    const preset = readFileSync(
      new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
    ).toString('base64');
    await page.addInitScript(fakeWebUsb, { fixture, preset });

    await page.goto('/');
    await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
    await openDevTools(page);
    await page.locator('#connect').click();
    await expect(page.locator('.device-card .badge')).toHaveText(
      /POD Go \(fake\)/,
    );
    await expect(page.locator('.preset-title')).toContainText('US Deluxe Nrm');
    await page.locator('#arm-writes').check();

    // Select the Amp block and note its processing index (raw chain = +1).
    const ampIndex = await page.locator('.block-tile').evaluateAll((nodes) =>
      nodes.findIndex((node) =>
        node.querySelector('.block-foot')?.textContent?.includes('Amp'),
      ),
    );
    expect(ampIndex).toBeGreaterThanOrEqual(0);
    await page.locator('.block-tile').nth(ampIndex).tap();
    await expect(
      page.locator('.block-tile').nth(ampIndex),
    ).toHaveClass(/is-selected/);

    await page.getByRole('tab', { name: 'Models' }).tap();
    const current = await page.locator('.inspector-model').textContent();
    const tiles = page.locator('.model-tile.is-selectable:not(.is-blocked)');
    await expect(tiles.first()).toBeVisible();
    let target = tiles.first();
    for (let index = 0; index < (await tiles.count()); index += 1) {
      const tile = tiles.nth(index);
      const name = await tile.locator('.model-name').textContent();
      if (name !== current) {
        target = tile;
        break;
      }
    }
    const chosen = (await target.locator('.model-name').textContent()) ?? '';
    const catalog = JSON.parse(
      readFileSync(
        new URL('../src/catalog/catalog.json', import.meta.url),
        'utf8',
      ),
    ) as {
      models: Record<string, { short: string; category: string | null }>;
    };
    let expectedWireId: number | null = null;
    for (const [id, model] of Object.entries(catalog.models)) {
      if (model.short === chosen && model.category === 'Amp') {
        expectedWireId = Number(id);
        break;
      }
    }
    expect(expectedWireId).not.toBeNull();

    // No confirmation and no offline copy: the change is a pedal draft.
    await target.tap();
    expect(dialogSeen).toBe(false);
    await expect(page.locator('.editor-source')).not.toContainText(
      'editable copy',
    );
    await expect(page.locator('.inspector-model')).toHaveText(chosen);
    await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');
    await expect(page.locator('#export-pgp')).toBeDisabled();

    const writesBefore = await page.evaluate(
      () =>
        (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ??
        [],
    );
    expect(writesBefore).toHaveLength(0);

    await page.locator('#save-preset').tap();
    await expect(page.locator('.report.log')).toContainText(
      'Save: 1 model(s) and 0 parameter(s) applied in RAM',
    );
    expect(dialogMessages.at(-1)).toContain('model');
    await expect(page.locator('#save-notice')).toContainText(
      '1 model(s) and 0 parameter(s) saved',
    );

    // Operation 40 carries the raw block and the nested model node; operation
    // 71 then stores the preset. The layout follows the MIT reference capture.
    const writes = await page.evaluate(
      () =>
        (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ??
        [],
    );
    expect(writes).toHaveLength(2);
    const modelBody = readMsgpack(new Uint8Array(writes[0]), 24).value as {
      [key: number]: MsgValue;
    };
    expect(modelBody[100]).toBe(40);
    const modelInner = modelBody[101] as { [key: number]: MsgValue };
    expect(modelInner[98]).toBe(ampIndex + 1);
    const node = modelInner[100] as { [key: number]: MsgValue };
    expect(typeof node[23]).toBe('boolean');
    expect(node[25]).toBe(expectedWireId);
    expect(node[26]).toBe(-1);

    const stored = readMsgpack(new Uint8Array(writes[1]), 24).value as {
      [key: number]: MsgValue;
    };
    expect(stored[100]).toBe(71);
    expect(errors).toEqual([]);
  });

  test('creates an editable copy with the toolbar button', async ({ page }) => {
    const fixture = readFileSync(
      new URL('../public/fixtures/user_setlist.bin', import.meta.url),
    ).toString('base64');
    const preset = readFileSync(
      new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
    ).toString('base64');
    await page.addInitScript(fakeWebUsb, { fixture, preset });

    await page.goto('/');
    await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
    await openDevTools(page);
    await page.locator('#connect').click();
    await expect(page.locator('.device-card .badge')).toHaveText(
      /POD Go \(fake\)/,
    );

    // The pedal preset is read-only until the user asks for a copy.
    await expect(page.locator('#export-pgp')).toBeDisabled();
    await page.locator('#edit-copy').tap();
    await expect(page.locator('.editor-source')).toContainText('editable copy');
    await expect(page.locator('#export-pgp')).toBeEnabled();
    await expect(page.locator('#save-notice')).toContainText(
      'Editable offline copy created',
    );
    await expect(page.locator('.report.log')).toContainText(
      'Created an editable copy',
    );
  });

  test('adds an effect to an empty slot and sends op 40 there', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));

    const fixture = readFileSync(
      new URL('../public/fixtures/user_setlist.bin', import.meta.url),
    ).toString('base64');
    const preset = readFileSync(
      new URL('../public/fixtures/spec02_obj22_blob.bin', import.meta.url),
    ).toString('base64');
    await page.addInitScript(fakeWebUsb, { fixture, preset });

    await page.goto('/');
    await expect(page.locator('header .badge')).toHaveText(/WASM ready/);
    await openDevTools(page);
    await page.locator('#connect').click();
    await expect(page.locator('.device-card .badge')).toHaveText(
      /POD Go \(fake\)/,
    );
    await page.locator('#arm-writes').check();

    // Pick an empty slot: the raw chain index is its processing index + 1.
    const emptyIndex = await page.locator('.block-tile').evaluateAll((nodes) =>
      nodes.findIndex((node) => node.classList.contains('is-empty')),
    );
    expect(emptyIndex).toBeGreaterThanOrEqual(0);
    await page.locator('.block-tile').nth(emptyIndex).tap();
    await expect(
      page.locator('.block-tile').nth(emptyIndex),
    ).toHaveClass(/is-selected/);

    await page.getByRole('tab', { name: 'Models' }).tap();
    const tile = page
      .locator('.model-tile.is-selectable:not(.is-blocked)')
      .first();
    await expect(tile).toBeVisible();
    await tile.tap();
    await expect(page.locator('.readonly-chip')).toHaveText('unsaved changes');
    // The slot shows the new model, not the empty-slot placeholder.
    await expect(page.locator('.block-tile').nth(emptyIndex)).not.toHaveClass(
      /is-empty/,
    );

    page.once('dialog', (dialog) => void dialog.accept());
    await page.locator('#save-preset').tap();
    await expect(page.locator('#save-notice')).toContainText(
      '1 model(s) and 0 parameter(s) saved',
    );
    const writes = await page.evaluate(
      () =>
        (window as unknown as { __podgoWrites?: number[][] }).__podgoWrites ??
        [],
    );
    expect(writes).toHaveLength(2);
    const modelBody = readMsgpack(new Uint8Array(writes[0]), 24).value as {
      [key: number]: MsgValue;
    };
    expect(modelBody[100]).toBe(40);
    const inner = modelBody[101] as { [key: number]: MsgValue };
    expect(inner[98]).toBe(emptyIndex + 1);
    expect(errors).toEqual([]);
  });
});
