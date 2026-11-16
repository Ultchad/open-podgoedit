// Smoke-test the generated WASM module outside a browser.
// This does not replace a real browser test, but catches broken bindings and
// regressions in the core reports before opening the page.
import { readFile } from 'node:fs/promises';

import init, {
  PresetFlow,
  core_version,
  inspect_preset,
  inspect_setlist,
} from '../src/wasm/podgo_wasm.js';

const here = new URL('.', import.meta.url);
const wasm = await readFile(new URL('../src/wasm/podgo_wasm_bg.wasm', here));
await init({ module_or_path: wasm });

const preset = await readFile(
  new URL('../../../fixtures/spec02_obj22_blob.bin', here),
);
const presetReport = inspect_preset(preset);
for (const expected of [
  'container: l6-helix',
  'product:   P34',
  'round-trip: byte-identical',
]) {
  if (!presetReport.includes(expected)) {
    throw new Error(`preset report is missing ${JSON.stringify(expected)}`);
  }
}

const setlist = await readFile(
  new URL('../../../fixtures/user_setlist.bin', here),
);
const setlistReport = inspect_setlist(setlist);
for (const expected of ['setlist:   128 entries', 'slot 127']) {
  if (!setlistReport.includes(expected)) {
    throw new Error(`setlist report is missing ${JSON.stringify(expected)}`);
  }
}

let rejected = false;
try {
  inspect_preset(new TextEncoder().encode('not a preset'));
} catch (error) {
  rejected = typeof error === 'string' && error.includes('invalid container');
}
if (!rejected) {
  throw new Error('malformed preset did not produce a string error');
}

// Drive the active-preset flow against a synthetic object-22 message.
const presetBlob = new Uint8Array(preset);
const message = new Uint8Array(14 + 3 + presetBlob.length);
message.set([
  0x83, 0xcd, 0x00, 0x66, 0xcd, 0x03, 0xea, 0xcd, 0x00, 0x67, 0x00, 0xcd,
  0x00, 0x68, 0xc5,
]);
message[15] = (presetBlob.length >> 8) & 0xff;
message[16] = presetBlob.length & 0xff;
message.set(presetBlob, 17);

const flow = new PresetFlow();
// Object 23 (active state) and object 22 (preset) share the same chunk flow;
// track which one the last open request asked for.
const stateName = new TextEncoder().encode('US Deluxe Nrm\0');
const stateMessage = (() => {
  const head = Uint8Array.from([
    0x83, 0xcd, 0x00, 0x66, 0xcd, 0x03, 0xea, 0xcd, 0x00, 0x67, 0x00, 0xcd,
    0x00, 0x68, 0x83, 0xcd, 0x00, 0x6b, 0x00, 0xcd, 0x00, 0x6c, 0x02, 0xcd,
    0x00, 0x6d, 0xd9, stateName.length,
  ]);
  const out = new Uint8Array(head.length + stateName.length);
  out.set(head);
  out.set(stateName, head.length);
  return out;
})();
const objectOperation = (request) =>
  request.length > 30 && request[11] === 0x04 ? request[30] : null;
let currentObject = 22;
let guard = 0;
while (!flow.is_finished()) {
  const request = flow.next_request();
  if (!request) {
    throw new Error(`preset flow stuck in ${flow.phase()}`);
  }
  const operation = objectOperation(request);
  if (operation === 22 || operation === 23) {
    currentObject = operation;
  }
  let payload = new Uint8Array(0);
  if (request.length === 16 && request[9] >= 0x08) {
    const cursor =
      (request[12] |
        (request[13] << 8) |
        (request[14] << 16) |
        (request[15] << 24)) >>>
      0;
    const relative = cursor - 0x1000;
    const stream = currentObject === 23 ? stateMessage : message;
    if (relative < stream.length) {
      payload = stream.slice(relative, relative + 496);
    }
  }
  const response = new Uint8Array(16 + payload.length);
  response[3] = 0x18;
  response[4] = request[6];
  response[5] = request[7];
  response[6] = request[4];
  response[7] = request[5];
  response[9] = request[9];
  response[11] = 0x04;
  response.set(payload, 16);
  flow.accept_response(response);
  guard += 1;
  if (guard > 400) {
    throw new Error('preset flow did not terminate');
  }
}
const activeReport = flow.report();
for (const expected of ['container: l6-helix', 'round-trip: byte-identical']) {
  if (!activeReport.includes(expected)) {
    throw new Error(`active preset report is missing ${JSON.stringify(expected)}`);
  }
}
if (flow.blob().length !== presetBlob.length) {
  throw new Error('active preset blob length mismatch');
}
const structure = JSON.parse(flow.structure_json());
if (structure.preset.name !== 'US Deluxe Nrm' || structure.preset.slot !== 2) {
  throw new Error('active state was not decoded');
}
if (structure.chain.length !== 12) {
  throw new Error('structured chain has the wrong length');
}
if (structure.footswitches[0]?.switch !== 'FS1') {
  throw new Error('footswitch assignments were not decoded');
}
flow.free();

console.log(`wasm smoke ok (core v${core_version()})`);
