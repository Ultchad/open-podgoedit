# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
semantic versioning once it reaches 1.0.

## [Unreleased]

- **Assign two new kinds of controller offline.** A parameter's controller
  menu (the former Snapshots-only camera toggle) now also offers **EXP 1**,
  **EXP 2** and **FS 1–FS 6**, so you can author an assignment into an
  offline/imported preset and export it as `.pgp` — no pedal write is made.
  Only **Snapshots** stays assignable on a live preset, through the existing
  op-37 path; EXP/FS appear disabled there because no capture yet shows the
  pedal write (`docs/development/manual-testing-todo.md` §2.6). Assigning or
  removing a controller edits `tone.controller.dsp0` only, preserving the
  `tone.footswitch` bypass map and per-snapshot values byte-for-byte; the FS
  numbers (3–8) follow the Line 6 convention but are **unverified** — the
  exported `.pgp` is the only artifact (see `docs/protocol/presets.md`).
- **Move the "no model" choice into the category row.** Selecting a model now
  starts with a **None** tab as the first category, showing the single
  **None · clear** tile (keeping the safe second-click) and hiding the search
  and sub-tabs. The standalone tile above the grid is gone; right-click
  **Remove** and **Delete/Backspace** still work.
- **Assign an effect to a footswitch offline.** A new **FS** chip in the block
  inspector opens **None · FS1–FS8 · EXP Toe** and writes the block's
  `tone.footswitch` bypass entry in an offline/imported preset (export as
  `.pgp`). Several blocks may share one switch (the manual's "Merge"), and
  reassigning preserves `@fs_label` and unknown fields (`@fs_ledcolor`,
  `@fs_momentary`, `@fs_primary`). This is separate from a parameter's
  controller and is offline-only: no captured op-31/33 write is sent yet.
  FS7/FS8 need the pedal's EXP 2 FS7/8 global setting; see the manual test
  §2.8 and `docs/protocol/presets.md`.

## [0.4.0] - 2026-11-27

### Added
- **One UI, thin shells — explicit contract and startup handshake.** The web
  bundle is documented as the only UI for the browser, Android and desktop
  shells ([shell contract](docs/architecture/shell-contract.md)). Each native
  shell now reports a shell adapter version; when an app package predates the
  bundled UI the header shows **App update needed** instead of failing later.
  CI verifies the three versions agree and that every shell still consumes
  `apps/web/dist`.
- **PWA install documented.** The README now explains how to install the
  editor as an app (Chromium-only install + WebUSB; Safari/Firefox/iOS can
  open the offline page but not install or reach the pedal).
- **Contributing branch policy.** CONTRIBUTING now makes explicit that pushes
  go to `dev` only, never directly to `main`, and explains that a `main`
  branch-protection rule (require PR + CI) is the real enforcement.
- **Tick individual presets in the Import/Export dialog.** For a `.pgb` you
  can now tick the exact preset slots to import or export: leave them all
  ticked for a whole setlist, tick a subset for only those presets (unticked
  slots are emptied on export), and tick exactly one User preset to download
  it as a single `.pgp` too. The group checkboxes (Factory / User / IRs /
  Globals) still control which members are kept.
- **Delete an effect three ways.** A selected effect can be removed from the
  right-click **Remove** item, the **Delete**/**Backspace** key, or the
  **None** tile at the top of the Models pane. All three edit an
  offline/imported preset as a JSON draft, or remove it live on a connected
  pedal (operations 28 then 78); with no editable copy the page builds one
  first so the change is saved or exported. Removing a block also clears its
  footswitch, controller and snapshot overrides so no dangling assignments
  remain.
- **"New preset here" warns before overwriting a draft.** Starting a fresh
  preset in a User slot that already holds an offline copy or an unsaved draft
  now asks for confirmation before replacing it, instead of throwing the work
  away silently. Empty slots still start immediately without a prompt.
- **Selective `.pgb` import/export from the header.** The old **Import** button
  is now **Import/Export** and its dialog can bring in or write back only the
  parts you pick from a full backup: the Factory setlist (`SL00`), the User
  setlist (`SL01`), impulse responses (`I000`…, RIFF/WAVE) and globals
  (`GLOB`). Import can open one preset or add every non-empty preset of the
  checked setlists to the offline library; export rebuilds the container with
  only the checked parts, keeps selected members byte for byte, and always
  keeps the `SLNM` name table and unknown members so the file stays readable.
  The button stays in the header's three-column grid, so it keeps the same
  size as the other actions on phones.
- **Installable PWA with a complete offline precache.** A Vite build plugin
  (`apps/web/vite.config.ts`) generates `dist/sw.js` with a versioned, full
  precache list (JS, WASM, CSS, icons and fixtures), so one online visit is
  enough to open the editor with no network. The worker caches the shell and
  serves assets cache-first (`ignoreVary`), so a reload while offline works.
  A header **Install** button appears when Chromium offers the prompt
  (`useInstallPrompt.ts`), and `postbuild` runs `scripts/check-pwa.mjs` to
  fail the build if the manifest, icons or a referenced asset is missing from
  `dist`. Covered by `tests/pwa.spec.ts` (`npm run test:pwa`), which loads the
  built bundle, drops the network and asserts the editor still runs offline.
- **Live sync from the pedal (`0x03F0 → 0x1002`).** The editor opens the
  captured event channel after connecting and polls it in the background, so
  knob turns, bypass changes, snapshot switches, preset changes and snapshot
  renames made **on the pedal** appear in the page without pressing
  **Read active preset**. Parameter and bypass events update the inspector
  directly; snapshot and preset events schedule one debounced re-read of the
  active preset (the device structure has no per-snapshot values). A pedal
  that refuses the handshake logs a warning and falls back to manual reads.
  Not validated on hardware yet.
- **Direct preset rename on the pedal.** The header ⋯ menu and the librarian's
  **Rename…** now store the name with operation 71 instead of leaving a
  page-only marker. A non-active User slot is recalled, renamed and the
  previous preset is recalled back; this is the only rename that moves the
  pedal's active preset and it asks the usual `save`/`no`/`Cancel` question
  first. See `docs/protocol/writes.md` §2.8.
- **Android app with a USB host transport.** The Android build wraps the same
  editor in a WebView that serves the bundle from the APK, so it works with no
  network, and connects the pedal through Android's USB host instead of WebUSB.
  Exports are written into the app's Downloads folder. The transport is covered
  by browser tests against a fake bridge but is **not validated on Android
  hardware**; reads and writes keep the same gates as the web build.
- **Tauri 2 desktop shell with a native libusb transport.** `apps/desktop`
  wraps the same web bundle and adds `usb_open`/`usb_read`/`usb_write` over
  `rusb`, mirroring the Android reader-thread design, plus a native save dialog
  for exports. CI compile-checks the shell on Linux; it has **not** been run
  against a real POD Go yet, so reads and writes are unvalidated on hardware.
  See `docs/development/desktop.md`.
- **Automated releases.** Pushing a `v*` tag builds the signed APK and the
  static web bundle and publishes both on a GitHub Release, with the changelog
  as release notes. See `docs/development/android.md`.
- **Touch, keyboard and responsive editor shell.** Amp/effect blocks and
  preset rows open their actions menu with a right-click or a long-press; the
  inspector adds a ⋯ button with the same copy, paste, move and bypass
  actions. On phones the librarian becomes an off-canvas drawer opened from
  the header, the editor stays first, the toolbar wraps, and controls grow to
  44 px with 16 px inputs to avoid mobile zoom. Dialogs now close on Escape or
  a backdrop click and trap focus; menus support Arrow/Home/End keys. The
  production build ships a web manifest, icons, an offline service worker,
  safe-area theming and a warning before leaving with unsaved edits. Model
  and preset writes are unchanged and remain unvalidated on hardware.
- **Undo/redo and effect copy/paste shortcuts.** `Ctrl/Cmd+Z` undoes and
  `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redoes edits to the loaded preset; the
  history is capped at 50 steps, lives only in the tab, and is cleared when
  another preset opens or after a successful Save/Export. Two arrow buttons
  next to the tempo expose the same actions. `Ctrl/Cmd+C` copies the selected
  amp/effect block and `Ctrl/Cmd+V` pastes it into the selected slot of another
  preset: the model and its parameter values follow, while bypass state and
  snapshot assignments stay with the destination block. On the active pedal
  preset, Save sends operation 40 and the copied parameter drafts (op 30); on
  an offline copy only the JSON document changes. Text fields keep their native
  shortcuts.
- **Model changes on a connected pedal (operation 40, unvalidated).** On the
  active preset read from the pedal, tapping a model now drafts the change on
  the pedal instead of building an offline copy: the block shows the new model
  and its catalog defaults, and **Save** sends operation 40 (load the model),
  then the queued parameter drafts (op 30), then operation 71 to store the
  preset. Renaming the model in a slot that already holds one and adding one to
  an empty slot both use the same path. The request layout comes from the MIT
  reference's annotated capture; there is no op-40 capture in this repository
  and nothing has been validated on hardware, so a rejection is reported in the
  log and leaves the draft queued. **Edit copy** still builds an editable
  offline copy on demand.
- **Edit a pedal preset's amp or effect as an offline copy.** Model tiles are
  now tappable on a preset read from the pedal. The first change asks to build
  an editable copy from the decoded structure (the toolbar **Edit copy** button
  does the same explicitly); the copy keeps the current chain and parameter
  values, exports as `.pgp`, and is clearly marked as not writable back to the
  pedal. This also fixes model taps doing nothing on touch browsers such as
  Brave on Android.
- **Selective backup and restore.** A `.pgbak` can now cover both setlists, one
  setlist, or an arbitrary set of slots (chosen in the backup dialog). On
  restore, the dialog lists every preset in the file with a checkbox; only the
  checked entries are encoded into a subset `.pgbak` in Rust and streamed, so
  unselected slots are never touched. The destination diff, confirmation count
  and post-restore name check all follow the selection. Restore remains
  destructive and has not been validated on hardware.
- **Rebuild a `.pgb` backup offline.** After opening a preset from a `.pgb`
  backup, **Export .pgb** writes a new `AF6L` container with that preset in its
  original slot. The header, `IDGP` directory body, trailer and every untouched
  member keep their exact bytes (impulse responses and `UMDS` included); only
  the edited setlist is re-serialized and recompressed with
  `CompressionStream('deflate')`, and the directory offsets are patched. The
  offer disappears when another preset becomes the working copy, so the wrong
  slot is never written. The writer layout is `ITM` until POD Go Edit opens an
  exported backup.
- **Preset ⋯ menu and “Copy to…”.** A ⋯ button next to the preset name opens the
  same actions menu as a librarian right-click, so a phone no longer needs a
  long-press. The menu adds **Copy to…**, which prompts for a POD Go slot label
  (`13A`, `01A`…`32D`): an offline document is cloned locally, while a pedal
  body is read and written with operation 5 after the usual write-arm and
  confirmation.

### Fixed
- **The op-21 chain upload now matches the official editor.** Decoding
  `podgo-move-effect.pcapng` showed that the captured offset table ends at the
  start of the synthetic 128-NUL `body[12]` scratch list, not at the physical
  end of the body. The encoder now reproduces both captured uploads byte for
  byte, and replaying the captured move (raw slot 4 → 10) on the first body
  produces the second exactly. The stream also keeps sending when a single
  frame goes unanswered instead of aborting into a fresh handshake while the
  pedal is still receiving; only the final status is required. **Move left /
  Move right stay disabled** until a hardware test on a User slot backed up as
  `.pgb`; see `docs/development/manual-testing-todo.md` §3.14.
- **Android Save, paste and rename no longer look like no-ops.** The Android
  shell now installs a `WebChromeClient` that turns `window.alert`,
  `window.confirm` and `window.prompt` into native dialogs, and implements the
  file chooser used by **Import…**. Before this the WebView silently dropped
  every confirmation, so a confirmed write never ran. Save is also clickable
  when it cannot write and explains why (no pedal, writing not enabled, or no
  active preset) instead of being an inert, tooltip-only button on touch
  screens.
- **Pasting a copied pedal preset works while connected.** A slot copied from
  the librarian holds the pedal's raw body, not an offline document; Paste now
  writes it with operation 5 instead of refusing and pointing at Developer
  tools. The write keeps the usual arm and one confirmation.
- **Bypassing an effect on a connected preset works.** The inspector toggle was
  hidden unless an offline copy was open, and accepting the editable-copy
  prompt left the bypass unapplied. The toggle now stays visible on a
  pedal-read preset, and the first tap creates the editable offline copy (with
  a clear confirmation) and applies the bypass there in the same step; it
  never invents an unvalidated pedal bypass write.
- **Mobile header rearranges cleanly when a pedal is connected.** Save occupies
  the third header cell, and the full-width **Enable writing** row follows it
  instead of pushing Save onto an unexpected row.
- **Save now stores the preset on the pedal.** The Save button (and Ctrl+S)
  applies the draft parameters with op 30 and then sends op 71 for the active
  preset's own User slot, so a change survives a preset switch or a reboot
  instead of reverting to the value stored on the pedal. The confirmation and
  the notice say so; a Factory preset points at **Save to slot…** instead.
- **Restore no longer fails with "the pedal did not acknowledge the restore
  stream window".** The pedal acknowledges every USB packet, not a fixed
  1536-byte window; the encoder now waits for a status after each frame and
  advances the cursor by 17 per status, as `podgo-backup-restore.pcapng` shows.
- **"Enable writing" stays checked when switching presets.** The session arm
  switch is cleared only on disconnect or when a file/fixture is loaded; a
  slot read still blocks writes until the active preset is read again.
- **Right-click Copy works on a slot that is not open.** When nothing is in
  memory and the pedal is connected, Copy reads the slot first; offline it now
  says the pedal is needed instead of "open the slot first".
- **Connecting loads the pedal.** Both setlists and the active preset are read
  automatically, so the editor is usable without pressing Read first.

### Security
- **Release signing secrets no longer leak into public workflow logs.** The
  v0.2.0 and v0.3.0 release runs exported `PODGO_SIGNING_STORE_PASSWORD` and
  `PODGO_SIGNING_KEY_PASSWORD` through `GITHUB_ENV`, so GitHub printed them in
  each later step's environment. The keystore password is now masked and passed
  to Gradle through a properties file read via `PODGO_SIGNING_PROPERTIES`.
  Rotate the keystore password (and update the repository secret) because the
  old value is public. The key itself was never exposed: the keystore file only
  exists inside the runner.

### Changed
- **Platform support is tiered, not forked.** One version, changelog and tag
  cover every target. The README and roadmap now label Web/PWA as **Supported**,
  the Android APK as **Beta**, the Tauri desktop shell as **Experimental**,
  Safari/Firefox/iOS browsers as **Untested** (offline only) and native iOS as
  **Not planned** (no public vendor-USB path). The
  [support matrix](docs/architecture/platform-support-matrix.md) reflects the
  same evidence.
- **Export lives in the preset menu only.** The toolbar **Export** button is
  removed on every screen size; **Export .pgp** stays in each preset's
  right-click menu and in the **⋯** menu next to the name (same code path, so
  unsaved edits are still included). The backup-specific **Export .pgb** button
  remains in the toolbar because the menu has no equivalent. The menu item is
  disabled for a pedal-only preset until an editable copy exists.
- **Icon-only Save.** The toolbar **Save** button is now a floppy-disk icon
  (with `aria-label="Save"` and the same tooltip), so it takes less room and
  leaves more of the preset name visible, especially on phones.
- **Phone toolbar shares the preset-title row.** On screens 700 px and narrower
  the action toolbar now sits to the right of the preset name instead of on its
  own third row; the snapshot chips keep their full-width row below. The tempo
  and status chip are hidden in that row so the name stays readable.
- **Android application ID now matches GitHub.** The installed package is
  `io.github.ultchad.openpodgoedit` (hyphens are not valid in an Android
  application ID; the Kotlin namespace stays `dev.openpodgo.edit`). The
  signing keystore is unchanged, but Android treats this as a new app: uninstall
  the old `dev.openpodgo.edit` build once before installing. See
  `docs/development/android.md`.
- **One connection button.** The header now shows a single **Connect** button
  that becomes **Disconnect** while a pedal is open, instead of two buttons
  that were alternately disabled.
- **Unofficial-project disclaimer.** The README opens with a plain-language
  disclaimer (not affiliated with Line 6 / Yamaha, not linked to POD Go Edit,
  use at your own risk, keep a backup) and the web UI shows the same notice
  under the editor plus a one-line "unofficial" subtitle in the header.
- **CI quality gates.** `.github/workflows/ci.yml` now runs on every pull
  request and every push to `dev`/`main`: Rust formatting, Clippy and offline
  workspace tests, the WASM host tests, `tsc` and the production build, then
  the Playwright suite (28 tests). Failed browser runs upload their traces.
  GitHub Pages deployment remains a separate `main`-only workflow.
- **Offline-first editor, draft edits and a compact UI.** The page now loads
  without a pedal: Factory names come from the bundled
  `factory_setlist_fw250.bin`, and User `01A` is seeded with a neutral
  `New Preset`. A `No POD Go connected` banner explains the state. Parameter
  fields commit to a working copy; **Save** / **Ctrl+S** is the only action
  that reaches the pedal (one confirmation, op-30 batch on the active preset),
  and offline it reports that saving needs the pedal while **Export .pgp**
  still works. The only write guard is **Enable writing**, a checkbox shown
  (unchecked by default) only while a pedal is connected; Save, Ctrl+S and the
  context menu's **Save to Pedal** stay disabled without it, while Export
  `.pgp` never needs it. Continuous parameters are edited in place: drag the
  bar under the name, or click the value at its right end to type one; the
  value box below the slider is gone. The header keeps just
  Connect/Disconnect, Enable writing, Save, New and Import; reads, backups,
  diagnostics, raw `.bin` download and the pedal-only op 5/71 actions moved
  into a collapsed **Developer tools** section. Right-clicking a preset opens
  a menu (open/new, save, rename, copy, paste, move, export `.pgp`, import)
  and User presets can be dragged between slots to swap them locally. The
  preset toolbar keeps only Rename and Export. A `.pgb` entry imported from
  the main Import button lands in its original User slot. Offline drafts are
  kept per slot: switching to another preset no longer discards the edits, so
  going back shows them again with an `unsaved changes` chip until Export;
  only unsaved pedal RAM drafts prompt before being dropped on a new read.
  New `PresetMenu`, `defaultPreset.ts`, `modelByName`, `presetFromDocument`
  and `clonePreset`; 23 Playwright tests cover the offline library, the
  disabled save paths, draft retention across preset switches, model loading,
  chain reordering, snapshot selection/renaming, per-snapshot values, bypass
  and LED colours, the snapshot and preset context menus, drag-and-drop,
  in-place parameter editing and the batch save. A small GitHub logo next to
  the `WASM ready` badge links to the source repository.

### Added
- **Per-snapshot values, bypass and LED colours in offline presets.** The
  inspector's camera toggle assigns the Snapshots controller (`@controller:
  10`, **ITM** for POD Go) to a continuous parameter and stores its current
  value in all four snapshots. A parameter that already follows an EXP pedal
  cannot be converted, so its toggle is disabled instead of deleting that
  assignment. Editing an assigned parameter updates the loaded snapshot, and
  the header's active/bypassed chip toggles the block in that snapshot only.
  A palette picker on the snapshot row sets `@ledcolor` (Auto, White, Red,
  Dark Orange, Light Orange, Yellow, Green, Turquoise, Blue, Violet, Pink,
  Off). All changes stay in the working copy and export through `.pgp`;
  nothing is written to the pedal.
- **Snapshot selection and renaming in offline presets.** Clicking a snapshot
  chip makes it the active snapshot saved with the preset
  (`@current_snapshot`), and double-clicking its label opens an inline field:
  **Enter** accepts, **Esc** or blur cancels. Right-clicking a chip opens the
  same actions as a menu: rename, use as the active snapshot, clear the custom
  name and pick any footswitch LED colour. Labels are limited to the 10
  printable ASCII characters the POD Go Owner's Manual documents for the
  Rename Snapshot screen; clearing the name falls back to `SNAPSHOT n`. Both
  changes follow the normal draft contract (browser/local copy, Save for the
  pedal, Export `.pgp` for a file) and never write to the pedal; choosing a
  snapshot on the hardware still uses the pedal's own controls.
- **Model swapping and chain editing in offline presets.** The Models tab now
  loads a model into the selected block (or an empty slot) when an offline
  document is open: clicking a tile writes the model and its vendor defaults,
  keeps `@position`/`@enabled`, flags the slot as an unsaved draft and exports
  in `.pgp`. Amp, Cab, Vol, Wah, Send/Return and Looper are single-role blocks:
  each can sit in any slot but only one may exist, so an empty slot can become
  a Wah, a Volume pedal, an FX Loop or the Looper; the Preset EQ only swaps for
  another Preset EQ, and incompatible tiles are disabled. Blocks can be dragged
  onto another position in the signal chain; the move rewrites `@position` and
  carries footswitch, controller and snapshot entries with the block. The model
  selector is disabled for the Input and Output stages. Browser-only copies and
  unsaved drafts are italic in the preset title and the librarian, so it is
  clear they are not on the pedal yet. Pedal presets stay read-only because the
  chain-body write (op 40) is still unimplemented. The catalog now carries
  each model's `type` (`@type`) and vendor `defaults` (including
  `@mic`/`@trails`).
- **Container image and GitHub Pages deployment.** A root `Dockerfile` builds
  the page in three stages (Rust/WASM, Node/Vite, nginx) and
  `docker-compose.yml` publishes it on `127.0.0.1:8080`; no backend or pedal is
  needed to serve private, static files. `deploy/nginx.conf` adds long-lived
  caching for hashed assets and revalidation for `index.html`.
  `.github/workflows/pages.yml` builds the same site with `VITE_BASE=./` and
  deploys it with GitHub Pages on pushes to `main`; `vite.config.ts` now reads
  that variable. One-time setup: set Pages source to **GitHub Actions**.
- **Offline preset editing and `.pgp` export.** A preset opened from POD Go
  Edit can now be used without a pedal: **Rename…** changes its display name,
  the inspector's **Apply** button edits continuous block parameters in the
  page, and **Export .pgp** downloads the result. The adapter keeps the parsed
  `L6Preset` document, so an edit touches one key and the export preserves
  every other field, including unknown ones. A preset taken from a `.pgb`
  only carries its `data` body; its `.pgp` envelope (`schema`, `version`,
  top-level `meta`) is rebuilt from the observed official shape and is `ITM`.
  Exporting an untouched real `.pgp` produced **0 semantic differences** (only
  whitespace). The badge shows `offline copy` / `offline copy · edited`;
  device writes, save, copy and `.bin` download stay disabled. New
  `setImportedName`, `setImportedParam`, `buildPgpDocument`, `serializePgp` and
  `presetFileName` in `podgoEdit.ts`, and a Playwright round-trip test.
- **POD Go Edit `.pgp` / `.pgb` import.** A new **Import .pgp /
  .pgb…** dialog opens POD Go Edit's single-preset export and its full `AF6L`
  backup, lists the Factory/User setlists and renders any selected preset in
  the editor. `.pgb` is parsed through its `IDGP` directory, with each zlib
  member inflated by the platform `DecompressionStream`; `.pgp` is parsed as
  `L6Preset` v6 JSON. The adapter converts parameter names and real-unit values
  into the existing `PresetStructure`, so the signal chain, inspector,
  snapshots and footswitch badges all work. Imported presets have no
  `l6-helix` body: writes, save, copy and `.bin` download stay disabled. Files
  are read in the tab and never uploaded, written back or persisted. New
  `podgoEdit.ts`, `PodgoEditImportDialog` and a Playwright test that builds
  synthetic files with invented names.
- **Preset copy/paste/move/rename.** The editor toolbar gains **Actions…**.
  Local operations (copy the loaded body to an in-page clipboard, paste or move
  it into any slot, rename) update the setlist model immediately and are listed
  as pending changes; they are never persisted and a setlist read replaces
  them. Two operations can also be written to the pedal behind the write gates:
  a pasted/moved body through a one-entry `.pgbak` replayed with operation 5,
  and a rename of the **active User preset** through operation 71. There is no
  evidenced way to clear a slot, so a move writes the destination and leaves the
  source on the pedal; the dialog says so. Renaming another slot on the pedal is
  not offered. New `PresetActionsDialog`, shared name validation and a
  Playwright test for the local flow.
- **Full backup and restore (`.pgbak`, op 5, gated).** A new dialog reads both
  setlists and every non-empty slot and downloads a single self-checking
  `podgo-full-backup-<timestamp>.pgbak` file. Each entry stores the raw
  `l6-helix` body verbatim with its setlist, slot, name and SHA-256; a
  whole-file SHA-256 footer detects truncation and tampering. The format is
  documented in `crates/podgo-domain/src/backup.rs` and
  [docs/protocol/writes.md](docs/protocol/writes.md) §2.6. Restore streams the
  bodies back with operation 5 only, using the framing recovered from
  `reverse/exports/podgo-backup-restore.pcapng` (157 messages): `01 00 02 00`
  subheader, `u32` length at offset 20, 488/496-byte payloads, a 1536-byte
  stream window answered with status 1 and a 17-byte cursor advance. Gate: a
  file verified in Rust, the per-setlist destination diff on screen, then one
  **Restore N preset(s)** click and one `window.confirm`. After the stream the
  page re-reads both setlists and compares every name. **Restore has not been
  applied to hardware yet**; op-9/86/113 and the final op-254 are not replayed.
  New `BackupBuilder`/`RestoreFlow`/`verify_backup` WASM exports,
  `createFullBackup` and `restoreFullBackup` drivers, `BackupRestoreDialog`,
  and a Playwright test over the fake device.
- **Preset save (op 71, gated).** The active preset can be stored under a User
  slot and a new name. The command is metadata-only (setlist, slot and the
  NUL-terminated name), captured byte for byte from POD Go Edit in
  `reverse/exports/podgo-preset-save.pcapng`; it neither uploads the preset
  body nor touches the object-14 seal. Before writing, the page reads the
  destination slot, downloads it as `podgo-user-<slot>-backup.bin`, shows its
  SHA-256 and requires an explicit acknowledgement. After status `0` it
  re-reads the User setlist and checks the new name. New
  `encode_save_preset`, WASM `SavePresetFlow`, shared `savePreset` driver and
  `SavePresetDialog`; Playwright covers the dialog, the backup gate and the
  op-71 frame. See [docs/protocol/writes.md](docs/protocol/writes.md).
- **Parameter writes (op 30, gated).** With writes armed, the inspector gains a
  value field and a **Set** button for every continuous effect parameter of
  the active preset. The change goes over the write channel
  (`0x1080 → 0x03ED`) as `set_param` and edits the preset in RAM only; nothing
  is saved. Gates: `device-write` Cargo feature, a session checkbox, the active
  preset read from the pedal in the same session (file, fixture and librarian
  reads disarm writes), and a `window.confirm` per change. The byte-exact copy
  read from the pedal stays in memory as the **Download .bin** backup. New
  `crates/podgo-protocol/src/write.rs`, WASM `ParamWriteFlow`, `writeParam`
  driver and a Playwright test over a fake device. See
  [docs/protocol/writes.md](docs/protocol/writes.md).
- **First hardware write (2026-11-13).** POD Go Wireless, fw 2.50: US Double
  Nrm Drive set to `9.0` from the web UI, applied and read back on the pedal
  and with *Read active preset*. The log showed the first write handshake being
  ignored after a read session, so `writeParam` now replays the four handshake
  packets in place (`ParamWriteFlow.restart_handshake`) instead of restarting
  the whole flow. `set_param` is now `ITH` on Web Chromium.
- Web UI diagnostics log: every WebUSB connection, handshake phase, read and
  error is recorded with a timestamp in a collapsed panel, with a **Copy log**
  button for pasting the full trace into a report. USB failures are also sent
  to the browser console.
- Librarian slot reads: clicking a Factory/User preset now opens its
  `l6-helix` body over WebUSB (operation 4 with `{107: setlist, 108: slot,
  101: 2}`), without recalling it on the pedal. The setlist supplies the name;
  the editor shows the chain, parameters and assignments exactly like the
  active-preset read. New `PresetFlow::for_slot` and `readPresetSlot`.
- POD Go Edit–style web UI: librarian sidebar (Factory/User setlists, `01A`
  slot labels, amber loaded preset), signal chain with category-coloured
  blocks, footswitch/`EXP Toe` labels, read-only parameter inspector, and a
  read-only Model Select grid (category row, sub-tabs, search).
- Model catalog (`apps/web/src/catalog/catalog.json`, 571 models, 4978
  parameters) generated by `tools/export_catalog.py` from the MIT
  `openpodgo` data; on-wire ids, display names, categories, ranges and enum
  labels are resolved in TypeScript, so the Rust core stays dependency-free.
  See [docs/protocol/model-catalog.md](docs/protocol/model-catalog.md).
- `tools/validate_catalog.py`: reassembles streamed objects from a USBPcap
  capture and validates every preset body against the catalog. It now
  understands both the official-editor framing (u32 length at offset 20, body
  at 24, 272-byte frames) and this project's own WebUSB framing. On
  `podgo-full-backup.pcapng` it decodes 125 presets / 1199 blocks with
  1199/1199 model ids resolved.
- `PresetFlow` in the WASM binding now reads object 23 (active state) then
  object 22 (preset), and exposes `structure_json()` for the editor:
  chain entries, bypass state, parameters, snapshots, tempo, footswitch and
  controller assignments.
- `ReadFlow.entries_json()` / `preset_structure()` helpers for the page.
- Analysis log entries for `podgo-catalog.pcapng` (preset switch, drive sweep,
  Script Phase bypass, switch/controller assignments) and
  `podgo-full-backup.pcapng` (official framing, catalog validation).
- Phase 1 reverse-engineering and architecture documentation:
  repository inventory, openpodgo analysis, Windows and macOS binary analysis,
  protocol specification, unknowns/hypotheses, analysis log, legal notes.
- Architecture requirements, technology evaluation, ADRs, system design,
  platform support matrix, security model and testing strategy.
- Project [roadmap](docs/roadmap.md) with phases, exit criteria and decision
  points.
- Development and user documentation.
- Rust workspace with `podgo-domain`, `podgo-protocol`, `podgo-session`,
  `podgo-transport` and `podgo-test-support`.
- Dependency-free MessagePack subset codec that preserves integer widths,
  string/binary markers and map order.
- `l6-helix` preset container parser with a typed preset view, offset-table and
  trailing-byte preservation, and fixture round-trip tests.
- Frame accessors, handshake builders, open request/response encoding and
  notification decoding with golden vectors.
- Session state machine with retry policy, mock transport, object reads,
  event-channel open and burst polling with cursor acknowledgements, a
  streamed setlist reader with freshness and size guards, and a clean shutdown
  path.
- Streamed setlist scanner/parser (`podgo-domain::preset_list`): key-109
  pattern scan, NUL-trimmed names, slot = stream position, validated against the
  128-entry real User-setlist fixture.
- Deterministic property/fuzz-style tests for the MessagePack codec and the
  `l6-helix` container: generated-value byte identity, exhaustive truncation,
  bit-flip and corruption sweeps, and trailing-byte preservation.
- `podgo-probe` (`apps/podgo-cli`): offline, read-only blob inspector with a
  byte-identity check, plus a `--setlist` mode that prints streamed setlist
  entries in slot order.
- `fixtures/` with provenance notes.
- [Manual testing checklist](docs/development/manual-testing-todo.md) covering
  local commands, Docker, WASM compile check, browser prerequisites and USB
  capture procedure.
- `apps/web/`: local React + TypeScript + Vite test harness running the read-only
  core as WebAssembly on `127.0.0.1:5173`; parses the bundled preset and setlist
  fixtures or user-selected files.
- `apps/web/wasm`: `wasm-bindgen` binding crate kept outside the root workspace so
  the core zero-dependency offline build is unchanged, with host tests and a
  Node smoke test of the generated module.
- Playwright browser test for the local page: both reports render, no external
  request, malformed input is rejected.
- `apps/web` read-only WebUSB transport: vendor-interface discovery, mirrored
  channel filtering, handshake retry, setlist read through a Rust `ReadFlow`
  state machine, connection UI and raw `.bin` download.
- Playwright fake-WebUSB test covering a complete User-setlist read (13 chunks,
  128 entries) plus the unsupported-browser path.
- Manual hardware checklist updated with WebUSB evidence requirements.
- Web: new **Lire le preset actif** button. A Rust `PresetFlow` (WASM) drives
  the object-22 read (handshake, `OPEN_PRESETS`, open `{102: 1002, 100: 22,
  101: {107: 0, 101: 2}}` at seq `0x07` / cursor `0x1038`, chunk reads), then
  extracts the `l6-helix` blob from key 104 and renders the `podgo-probe`
  report. Covered by 5 WASM unit tests, a Node smoke test and a Playwright
  fake-WebUSB test. Read-only: no write channel is used.
- New fixtures from the fw 2.50 session: `factory_setlist_fw250.bin` (real
  Factory stream, incl. the 8-byte data header) and `events_fw250.bin`
  (14 notification frames extracted from `podgo-connect.pcapng`).
- Event framing resolved from that capture: notifications carry
  `00 00 04 00` + u32 body length and MessagePack at offset 24, with 0–3 bytes
  of padding; the offset-16 shape does not occur for events on fw 2.50. A
  session test now checks the captured cursor arithmetic (`0x1009 → 0x1037`).
- New fixture `events_actions_fw250.bin`: 18 frames covering every opcode of
  the guided action capture (1, 4, 8, 20, 21, 22, 30, 31, 33, 34, 39, 40, 41,
  42, 46, 49). Opcode 6 is excluded because its only frame carries a personal
  preset name.
- `tools/podgo-capture.py` gains a `map` command: per-burst opcode histogram
  and distinct payload shapes, which is how the opcode table was derived.

### Changed
- **One confirmation per write.** Restore and the library writes no longer
  stack preconditions. Restore keeps a Rust-verified file and shows the
  destination diff, then asks one **Restore N preset(s)** click and one
  `window.confirm`; the typed `RESTORE` word and the acknowledgement checkbox
  are gone. **Write rename to pedal** and **Write paste to pedal** no longer
  require a full backup first — one button, one `window.confirm`. A full backup
  is still one click away in the same dialog and is recommended, but it is a
  safety net, not a gate. The session arm switch and the `device-write` Cargo
  feature are unchanged. ADR-0007 has a 2026-11-15 amendment.
- Web UI language is English, matching POD Go Edit; the page is now an editor
  (librarian + signal chain + inspector) with the connection card and offline
  reports condensed, instead of a report-only harness.
- Corrected the documented chain shape of the fixture: input, nine processing
  blocks, one empty slot and output (twelve entries), not ten blocks.
- Clarified event-channel direction: host polls `0x1002 → 0x03F0`; device
  notifications arrive on the reverse `0x03F0 → 0x1002`.

### Fixed
- Parameter values for continuous 0..1 knobs are displayed on the pedal's
  0–10 scale (`×10`) instead of `×100`. Classic Distortion's Drive stores
  `0.76` and the pedal shows `7.6`; the Web UI showed `76.0`. This includes
  catalog parameters with `display_type: percent`, which POD Go Edit renders
  as `0–100 %` but the hardware displays `0–10`. Slider end labels now read
  `0` and `10` for those knobs.
- The active-preset flow now retries the five-packet handshake **in place**
  when the pedal ignores it after finishing an object. Previously the whole
  flow restarted from object 23 on every attempt, so the second object's
  handshake failed forever and the fallback lost the object-23 name. The
  replay keeps the objects already read (`PresetFlow::restart_handshake`).
- The preset envelope is decoded as the first MessagePack value only. The
  pedal sends the last object chunk at full size, so zero padding can follow
  the `{102, 103, 104}` map; rejecting it caused "invalid container: trailing
  bytes after MessagePack value" on **Read active preset**. Key 104 carries its
  own length, so the extracted `l6-helix` blob stays exact. Object 23 decoding
  is tolerant for the same reason.
- MessagePack `str` payloads are now kept as raw bytes instead of being decoded
  eagerly as UTF-8. The pedal stores the `l6-helix` blob and other binary data
  in `str16` (`0xda`), so opening a librarian slot could fail with
  "MessagePack string is not valid UTF-8". `Value::as_str()` still returns text
  for valid UTF-8; `Value::as_str_bytes()` exposes the bytes. Two new codec
  tests cover binary and textual `str` payloads.
- "Read active preset" falls back to an object-22 read when the pedal does not
  answer object 23. `PresetFlow::for_active_body` sends the same
  `{107: 0, 101: 2}` open as the two-object flow and leaves the setlist/slot
  unknown; the UI shows `Active preset` unless the page supplies a name.
- WebUSB transport ignores event-channel frames (`0x03F0 → 0x1002`) instead of
  ever treating them as a response. If the 64-packet queue overflows, the
  oldest event frame is dropped before any response, so an event burst cannot
  starve or corrupt a read.
- `&mut T` now implements `Transport`, so a caller can retain a mock for
  inspection.
- Session exposes `Debug` without requiring the transport to be `Debug`.
- Malformed fixture expectations replaced with evidence-based assertions.

### Security
- All parsed input is bounds-checked; malformed data returns typed errors.
- Depth, container-size and length limits are enforced before allocation.

### Notes
- `.pgp`, `.hlx` and `.pgb` import/export are **not implemented yet**. The
  current milestone reads the binary `l6-helix` container and streamed setlists
  only; Phase 3 is blocked on a JSON dependency decision (see the roadmap).
- The web harness is a local test page, not the final UI: WebUSB is read-only,
  and editing/persistence are not implemented. WebUSB is covered by fake-device
  tests (`ITM`) plus recorded Factory (3668 B) and User (3416 B) setlist reads
  on a POD Go Wireless (firmware 2.50), which upgrade the Web Chromium read
  paths to `ITH`.
- Only the Web Chromium read path is hardware-tested (`ITH`); no native Rust
  transport implementation exists outside the mock, and no write path is
  validated.

## [0.0.0] - 2026-11-10
- Initial analysis snapshot. No released binaries.
