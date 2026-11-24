// Event-channel session for live pedal-to-page synchronisation.
//
// The POD Go pushes notifications (knob turns, snapshot and preset changes)
// on a dedicated event channel. Opening it takes the three-packet handshake
// captured in `reverse/exports/podgo-events.pcapng`; every poll carries the
// host cursor, and every delivered frame advances it by `8 + body length`.
// See `docs/protocol/notifications.md`.

import {
  decodeEvent,
  eventAckFrame,
  eventFrameAdvance,
  eventPollFrame,
  type PedalEvent,
} from '../wasmClient';
import { PodgoUsbError, type PodgoConnection } from './podgoUsb';

/**
 * Event-channel handshake, from `crates/podgo-protocol/src/handshake.rs`.
 *
 * The capture shows these exact 20-, 28- and 16-byte packets; each is
 * answered on the mirrored channel before the next one is sent.
 */
const EVENT_SEQUENCE: Uint8Array[] = [
  Uint8Array.from([
    0x0c, 0x00, 0x00, 0x28, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x00, 0x00, 0x02,
    0x00, 0x01, 0x00, 0x21, 0x00, 0x10, 0x00, 0x00,
  ]),
  Uint8Array.from([
    0x11, 0x00, 0x00, 0x18, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x02, 0x00, 0x04,
    0x00, 0x10, 0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x04, 0x00, 0x00, 0x00,
  ]),
  Uint8Array.from([
    0x08, 0x00, 0x00, 0x18, 0x02, 0x10, 0xf0, 0x03, 0x00, 0x03, 0x00, 0x08,
    0x09, 0x10, 0x00, 0x00,
  ]),
];

/** First poll sequence number after the handshake. */
const FIRST_SEQ = 0x04;
/** Cursor the device rests on after the handshake. */
const REST_CURSOR = 0x1009;
/** The pedal answers a poll immediately; 200 ms is the captured timeout. */
export const POLL_TIMEOUT_MS = 200;

/**
 * One event-channel session bound to an open connection.
 *
 * `open()` must succeed before `poll()`; the cursor and sequence live here so
 * acknowledgements stay in step across polls.
 */
export class PedalEvents {
  private seq = FIRST_SEQ;
  private cursor = REST_CURSOR;
  private opened = false;

  constructor(private readonly connection: PodgoConnection) {}

  /** Run the three-packet handshake. */
  async open(): Promise<void> {
    for (const packet of EVENT_SEQUENCE) {
      await this.connection.request(packet, 1_000);
    }
    this.seq = FIRST_SEQ;
    this.cursor = REST_CURSOR;
    this.opened = true;
  }

  /**
   * Poll once and return the decoded notification burst.
   *
   * Every data frame is acknowledged immediately, exactly like the captured
   * editor, so a long burst cannot overflow the device buffer.
   */
  async poll(): Promise<PedalEvent[]> {
    if (!this.opened) {
      throw new PodgoUsbError('event channel is not open');
    }
    const events: PedalEvent[] = [];
    const poll = eventPollFrame(this.seq, this.cursor);
    this.seq = (this.seq + 1) & 0xff;
    await this.connection.pollEvents(poll, POLL_TIMEOUT_MS, (frame) => {
      const ack = this.advance(frame);
      const event = decodeEvent(frame);
      if (event) {
        events.push(event);
      }
      return ack;
    });
    return events;
  }

  /**
   * Send the next poll once and report whether the pedal answered within
   * `timeoutMs`.
   *
   * Polls and acknowledgements are accounted exactly like `poll()` so the
   * cursor stays correct when the probe starts the live loop. The device's
   * own `cmd=0x10` echo also counts as an answer.
   */
  async probe(timeoutMs: number): Promise<boolean> {
    if (!this.opened) {
      throw new PodgoUsbError('event channel is not open');
    }
    const poll = eventPollFrame(this.seq, this.cursor);
    this.seq = (this.seq + 1) & 0xff;
    return this.connection.probeEvents(poll, timeoutMs, (frame) =>
      this.advance(frame),
    );
  }

  /** Advance the host cursor and return the acknowledgement for a frame. */
  private advance(frame: Uint8Array): Uint8Array {
    this.cursor = (this.cursor + eventFrameAdvance(frame)) >>> 0;
    const ack = eventAckFrame(this.seq, this.cursor);
    this.seq = (this.seq + 1) & 0xff;
    return ack;
  }
}
