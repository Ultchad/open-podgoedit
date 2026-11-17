import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  BackupBuilder,
  coreVersion,
  initWasm,
  inspectPreset,
  inspectSetlist,
  presetStructure,
  setlistEntries,
} from './wasmClient';
import {
  PodgoUsbConnection,
  describeDevice,
  isUserCancellation,
  type PodgoDeviceInfo,
} from './usb/podgoUsb';
import { readActivePreset, readPresetSlot } from './usb/preset';
import { readSetlist, type SetlistKind } from './usb/setlist';
import { createFullBackup } from './usb/backup';
import { restoreFullBackup } from './usb/restore';
import { savePreset, writeParam } from './usb/write';
import type {
  BackupVerify,
  CatalogModel,
  PresetStructure,
  SetlistEntry,
} from './types';
import {
  canSwapModel,
  modelById,
  paramAt,
  slotLabel,
} from './catalog';
import PresetList from './components/PresetList';
import PresetView from './components/PresetView';
import BackupRestoreDialog from './components/BackupRestoreDialog';
import PodgoEditImportDialog from './components/PodgoEditImportDialog';
import PresetActionsDialog, {
  type ClipboardEntry,
  type PendingEdit,
  type PasteMode,
} from './components/PresetActionsDialog';
import PresetMenu, {
  type PresetMenuEntry,
} from './components/PresetMenu';
import { validatePresetName, validateSnapshotName } from './presetName';
import {
  applyBackupEdits,
  backupFileName,
  clonePreset,
  hasImportedSnapshotParam,
  presetFileName,
  serializePgb,
  serializePgp,
  moveImportedBlock,
  setImportedBlockEnabled,
  setImportedModel,
  setImportedName,
  setImportedParam,
  setImportedSnapshot,
  setImportedSnapshotAssignment,
  setImportedSnapshotLedColor,
  setImportedSnapshotName,
  setImportedSnapshotParam,
  SNAPSHOT_CONTROLLER,
  toneToStructure,
  type EditBackup,
  type EditPreset,
} from './podgoEdit';
import { createDefaultPreset } from './defaultPreset';
import SavePresetDialog, {
  type SaveBackup,
} from './components/SavePresetDialog';

type Kind = 'preset' | 'setlist';

type ModuleState =
  | { status: 'loading' }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

interface PanelState {
  source: string;
  text: string;
  error: string | null;
}

type DeviceReport =
  | {
      kind: 'setlist';
      setlist: SetlistKind;
      report: string;
      chunks: number;
      truncated: boolean;
    }
  | {
      kind: 'preset';
      label: string;
      report: string;
      chunks: number;
      truncated: boolean;
    };

const EMPTY_PANEL: PanelState = {
  source: '',
  text: '',
  error: null,
};

const FIXTURES: Record<Kind, string> = {
  preset: `${import.meta.env.BASE_URL}fixtures/spec02_obj22_blob.bin`,
  setlist: `${import.meta.env.BASE_URL}fixtures/user_setlist.bin`,
};
const FACTORY_FIXTURE = `${import.meta.env.BASE_URL}fixtures/factory_setlist_fw250.bin`;
const USER_SLOT_COUNT = 128;
const DEFAULT_PRESET_NAME = 'New Preset';

const LABELS: Record<Kind, string> = {
  preset: 'Preset l6-helix',
  setlist: 'Streamed setlist',
};

const SETLIST_LABELS: Record<SetlistKind, string> = {
  0: 'Factory',
  1: 'User',
};

interface WorkingSlot {
  setlist: 1;
  slot: number;
}

interface PendingParam {
  block: number;
  param: number;
  value: number;
  label: string;
}

interface Notice {
  kind: 'error' | 'info';
  text: string;
}

/** 128 User entries with one seeded preset and empty names elsewhere. */
function emptyUserSetlist(name: string, slot = 0): SetlistEntry[] {
  return Array.from({ length: USER_SLOT_COUNT }, (_, index) => ({
    slot: index,
    name: index === slot ? name : '',
  }));
}

/** Shown if the bundled factory fixture cannot be read. */
function placeholderFactorySetlist(): SetlistEntry[] {
  return Array.from({ length: USER_SLOT_COUNT }, (_, index) => ({
    slot: index,
    name: `Factory ${slotLabel(index)}`,
  }));
}

function localKey(setlist: number, slot: number): string {
  return `${setlist}:${slot}`;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Lowercase space-separated hex, for the diagnostics log. */
function frameHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ' ',
  );
}

/** Trigger a browser download for a byte buffer. */
function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = 'application/octet-stream',
): void {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** Lower-case SHA-256 hex digest of a buffer. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export default function App() {
  const [module, setModule] = useState<ModuleState>({ status: 'loading' });
  const [panels, setPanels] = useState<Record<Kind, PanelState>>({
    preset: EMPTY_PANEL,
    setlist: EMPTY_PANEL,
  });

  const [usbSupported] = useState(() => PodgoUsbConnection.isSupported());
  const [deviceInfo, setDeviceInfo] = useState<PodgoDeviceInfo | null>(null);
  const [usbBusy, setUsbBusy] = useState<string | null>(null);
  const [usbError, setUsbError] = useState<string | null>(null);
  const [deviceReport, setDeviceReport] = useState<DeviceReport | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [logCopied, setLogCopied] = useState(false);

  const appendLog = useCallback((message: string) => {
    const stamp = new Date().toISOString().slice(11, 23);
    setLog((current) => {
      const next = [...current, `[${stamp}] ${message}`];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  /** Show USB progress and keep the same text for the diagnostics log. */
  const reportProgress = useCallback(
    (message: string) => {
      setUsbBusy(message);
      appendLog(message);
    },
    [appendLog],
  );

  const [structure, setStructure] = useState<PresetStructure | null>(null);
  const [presetBlob, setPresetBlob] = useState<Uint8Array | null>(null);
  const [presetSource, setPresetSource] = useState('—');
  const [setlists, setSetlists] = useState<
    Record<SetlistKind, SetlistEntry[] | null>
  >({ 0: null, 1: null });
  const [activeSetlist, setActiveSetlist] = useState<SetlistKind>(1);
  const [loaded, setLoaded] = useState<{
    setlist: SetlistKind;
    slot: number;
  } | null>(null);
  /**
   * The single guard for the pedal: drafts can always be edited in the page,
   * but nothing is written until the user enables writing for this session.
   * The checkbox is only shown while a pedal is connected.
   */
  const [writeEnabled, setWriteEnabled] = useState(false);
  /** True only when the editor shows the preset the pedal has active. */
  const [activePresetLoaded, setActivePresetLoaded] = useState(false);
  const [writing, setWriting] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveBackup, setSaveBackup] = useState<SaveBackup | null>(null);
  const [saveBackupBusy, setSaveBackupBusy] = useState(false);
  const [saveBackupError, setSaveBackupError] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [freshBackup, setFreshBackup] = useState<BackupVerify | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  /**
   * Preset opened from an offline document (bundled default, local slot or a
   * POD Go Edit import). Edits update this working copy only; nothing is sent
   * to the pedal until the user saves, and `Export .pgp` always works.
   */
  const [workingDoc, setWorkingDoc] = useState<EditPreset | null>(null);
  const [workingSlot, setWorkingSlot] = useState<WorkingSlot | null>(null);
  /** Committed offline documents, keyed `setlist:slot` (User only). */
  const [localDocs, setLocalDocs] = useState<Record<string, EditPreset>>({});
  /** The working copy changed since it was opened, saved or exported. */
  const [dirty, setDirty] = useState(false);
  /** Offline drafts that were edited but not exported, keyed `setlist:slot`. */
  const [dirtySlots, setDirtySlots] = useState<Record<string, boolean>>({});
  /** Parameter drafts for the active pedal preset, applied by Save. */
  const [pendingParams, setPendingParams] = useState<
    Record<string, PendingParam>
  >({});
  /** Sticky message under the header (no pedal, save unavailable, …). */
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    kind: SetlistKind;
    slot: number;
    x: number;
    y: number;
  } | null>(null);
  /** Slot chosen by the right-click "Import .pgp…" action. */
  const [importTarget, setImportTarget] = useState<WorkingSlot | null>(null);
  /**
   * The `.pgb` backup the working copy came from, when it came from one.
   *
   * Kept so **Export .pgb** can rebuild the container: unchanged members are
   * copied verbatim and only the edited setlist slot is rewritten.
   */
  const [importedBackup, setImportedBackup] = useState<EditBackup | null>(null);
  /** User slot the imported backup's preset was opened into. */
  const [backupExportKey, setBackupExportKey] = useState<string | null>(null);
  const [backupExportBusy, setBackupExportBusy] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  /** Raw body of the clipboard preset; the entry keeps only the metadata. */
  const [clipboardBlob, setClipboardBlob] = useState<Uint8Array | null>(null);
  /** Offline document of the clipboard preset, when it has one. */
  const [clipboardDoc, setClipboardDoc] = useState<EditPreset | null>(null);
  const [pending, setPending] = useState<PendingEdit[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const connectionRef = useRef<PodgoUsbConnection | null>(null);

  const run = useCallback(
    (kind: Kind, bytes: Uint8Array, source: string, setlist: SetlistKind = 1) => {
      try {
        const text =
          kind === 'preset' ? inspectPreset(bytes) : inspectSetlist(bytes);
        setPanels((current) => ({
          ...current,
          [kind]: { source, text, error: null },
        }));
      } catch (error) {
        setPanels((current) => ({
          ...current,
          [kind]: { source, text: '', error: errorMessage(error) },
        }));
        if (kind === 'preset') {
          setStructure(null);
          setPresetBlob(null);
        }
        return;
      }

      if (kind === 'preset') {
        try {
          setStructure(presetStructure(bytes) as PresetStructure);
          setPresetBlob(bytes);
          setPresetSource(source);
          setWorkingDoc(null);
          setWorkingSlot(null);
          setDirty(false);
          setPendingParams({});
          setLoaded(null);
          // A file or fixture is not the pedal's active preset: writes would
          // target a different sound, so disarm until the device is re-read.
          setActivePresetLoaded(false);
          setWriteEnabled(false);
        } catch {
          // The text report already carries the diagnostic.
        }
      } else {
        try {
          const entries = setlistEntries(bytes) as SetlistEntry[];
          setSetlists((current) => ({ ...current, [setlist]: entries }));
          clearPendingForSetlist(setlist);
          setActiveSetlist(setlist);
        } catch {
          // The text report already carries the diagnostic.
        }
      }
    },
    [],
  );

  const loadFixture = useCallback(
    async (kind: Kind) => {
      try {
        const response = await fetch(FIXTURES[kind]);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${FIXTURES[kind]}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        run(
          kind,
          bytes,
          `fixture ${FIXTURES[kind].split('/').pop()}`,
          kind === 'setlist' ? 1 : undefined,
        );
      } catch (error) {
        setPanels((current) => ({
          ...current,
          [kind]: { source: '', text: '', error: errorMessage(error) },
        }));
      }
    },
    [run],
  );

  /**
   * Fill the librarian without a pedal: factory names from the bundled
   * capture, and one neutral User preset ready to edit and export.
   */
  async function seedOfflineLibrary() {
    let factory = placeholderFactorySetlist();
    try {
      const response = await fetch(FACTORY_FIXTURE);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${FACTORY_FIXTURE}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      factory = setlistEntries(bytes) as SetlistEntry[];
      try {
        setPanels((current) => ({
          ...current,
          setlist: {
            source: 'factory_setlist_fw250.bin',
            text: inspectSetlist(bytes),
            error: null,
          },
        }));
      } catch {
        // The names are usable even if the report fails.
      }
    } catch (error) {
      setPanels((current) => ({
        ...current,
        setlist: {
          source: '',
          text: '',
          error: `Factory list unavailable (${errorMessage(error)}); using placeholders.`,
        },
      }));
    }

    const preset = createDefaultPreset(DEFAULT_PRESET_NAME);
    preset.setlist = 1;
    preset.slot = 0;
    setSetlists({ 0: factory, 1: emptyUserSetlist(DEFAULT_PRESET_NAME) });
    setLocalDocs({ [localKey(1, 0)]: preset });
    setActiveSetlist(1);
    openLocalPreset(1, 0, preset);
    appendLog('Offline workspace ready: factory names + a default User preset.');
  }

  useEffect(() => {
    let cancelled = false;
    initWasm()
      .then(() => {
        if (cancelled) {
          return;
        }
        setModule({ status: 'ready', version: coreVersion() });
        void seedOfflineLibrary();
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setModule({ status: 'error', message: errorMessage(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      void connectionRef.current?.close();
      connectionRef.current = null;
    },
    [],
  );

  async function onFile(kind: Kind, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    run(kind, bytes, file.name);
  }

  async function connect() {
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Selecting the device…');
    appendLog('Opening the WebUSB device picker…');
    try {
      const device = await PodgoUsbConnection.requestDevice();
      setUsbBusy('Opening the vendor interface…');
      appendLog('Device selected; claiming the vendor interface…');
      const connection = await PodgoUsbConnection.open(device);
      connectionRef.current = connection;
      setDeviceInfo(connection.info);
      setSaveNotice(null);
      appendLog(`Connected: ${describeDevice(connection.info)}`);
      // Fill the page from the pedal right away: both setlists and the active
      // preset, so the editor is usable without pressing Read first.
      await loadFromPedalOnConnect(connection);
    } catch (error) {
      if (isUserCancellation(error)) {
        setUsbError(null);
        appendLog('Device selection cancelled.');
      } else {
        const message = errorMessage(error);
        setUsbError(message);
        appendLog(`ERROR connect: ${message}`);
        console.error('[POD Go] connect failed', error);
      }
    } finally {
      setUsbBusy(null);
    }
  }

  /**
   * Read both setlists and the active preset after connecting.
   *
   * This is the same work as the three Read buttons, run once on connect so
   * the page is usable immediately. Each step is independent: a setlist that
   * fails to read leaves the offline seed in place, and an active-preset read
   * that fails only logs. Unsaved pedal drafts are never discarded.
   */
  async function loadFromPedalOnConnect(connection: PodgoUsbConnection) {
    for (const setlist of [0, 1] as const) {
      const label = SETLIST_LABELS[setlist];
      try {
        setUsbBusy(`Reading the ${label} setlist…`);
        appendLog(`Connect: reading the ${label} setlist…`);
        const result = await readSetlist(connection, setlist, reportProgress);
        setSetlists((current) => ({ ...current, [setlist]: result.entries }));
        clearPendingForSetlist(setlist);
        setActiveSetlist(setlist);
        setDeviceReport({ kind: 'setlist', setlist, ...result });
        if (setlist === 1) {
          // Keep unexported offline drafts, drop clean local copies so a click
          // reads the pedal instead of a stale document.
          setLocalDocs((current) => {
            const kept: Record<string, EditPreset> = {};
            for (const [key, doc] of Object.entries(current)) {
              if (dirtySlots[key]) {
                kept[key] = doc;
              }
            }
            return kept;
          });
        }
        appendLog(
          `Connect: ${label} setlist read, ${result.entries.length} entries.`,
        );
      } catch (error) {
        const message = errorMessage(error);
        appendLog(`WARNING connect (${label} setlist): ${message}`);
        console.warn(`[POD Go] connect ${label} setlist read failed`, error);
      }
    }

    try {
      setUsbBusy('Reading the active preset…');
      appendLog('Connect: reading the active preset…');
      const result = await readActivePreset(connection, reportProgress);
      const slot = result.structure.preset.slot;
      const setlist: SetlistKind =
        result.structure.preset.setlist === 0 ? 0 : 1;
      showPreset(
        result,
        'active preset from pedal',
        'Active preset',
        setlist,
        slot,
      );
      setActivePresetLoaded(true);
      appendLog(
        `Connect: active preset "${result.structure.preset.name || 'unnamed'}" ` +
          `(${SETLIST_LABELS[setlist]} ${
            slot === null ? 'slot unknown' : slotLabel(slot)
          }).`,
      );
    } catch (error) {
      const message = errorMessage(error);
      appendLog(`WARNING connect (active preset): ${message}`);
      console.warn('[POD Go] connect active preset read failed', error);
    } finally {
      setUsbBusy(null);
    }
  }

  async function disconnect() {
    setUsbBusy('Disconnecting…');
    appendLog('Disconnecting…');
    try {
      await connectionRef.current?.close();
      appendLog('Disconnected.');
    } catch (error) {
      const message = errorMessage(error);
      setUsbError(message);
      appendLog(`ERROR disconnect: ${message}`);
      console.error('[POD Go] disconnect failed', error);
    } finally {
      connectionRef.current = null;
      setDeviceInfo(null);
      setDeviceReport(null);
      setWriteEnabled(false);
      setActivePresetLoaded(false);
      setSaveOpen(false);
      setSaveBackup(null);
      setSaveBackupError(null);
      setBackupOpen(false);
      setFreshBackup(null);
      setRestoreError(null);
      setActionsOpen(false);
      setPending([]);
      setUsbBusy(null);
      setSaveNotice(null);
    }
  }

  async function readFromDevice(setlist: SetlistKind) {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    if (!confirmDiscardPedalDrafts()) {
      return;
    }
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Handshake…');
    appendLog(`Reading the ${SETLIST_LABELS[setlist]} setlist…`);
    try {
      const result = await readSetlist(connection, setlist, reportProgress);
      setSetlists((current) => ({ ...current, [setlist]: result.entries }));
      clearPendingForSetlist(setlist);
      setActiveSetlist(setlist);
      setDeviceReport({ kind: 'setlist', setlist, ...result });
      if (setlist === 1) {
        // The pedal is the source of truth again, but unexported offline
        // drafts belong to the user: keep those, drop the clean copies so a
        // click reads the pedal instead of a stale local document.
        setLocalDocs((current) => {
          const kept: Record<string, EditPreset> = {};
          for (const [key, doc] of Object.entries(current)) {
            if (dirtySlots[key]) {
              kept[key] = doc;
            }
          }
          return kept;
        });
        setWorkingDoc(null);
        setWorkingSlot(null);
        setDirty(false);
        setPendingParams({});
        setSaveNotice(null);
      }
      setUsbBusy(null);
      appendLog(
        `Read ${SETLIST_LABELS[setlist]} setlist: ${result.entries.length} entries, ${result.chunks} chunk(s)${
          result.truncated ? ', truncated' : ''
        }.`,
      );
    } catch (error) {
      setUsbBusy(null);
      const message = errorMessage(error);
      setUsbError(message);
      appendLog(`ERROR setlist read: ${message}`);
      console.error('[POD Go] setlist read failed', error);
    }
  }

  function showPreset(
    result: Awaited<ReturnType<typeof readActivePreset>>,
    source: string,
    label: string,
    setlist: SetlistKind,
    slot: number | null,
  ) {
    setStructure(result.structure);
    setPresetBlob(result.blob);
    setPresetSource(source);
    setWorkingDoc(null);
    setWorkingSlot(null);
    setDirty(false);
    setPendingParams({});
    setSaveNotice(null);
    setPanels((current) => ({
      ...current,
      preset: { source, text: result.report, error: null },
    }));
    setActiveSetlist(setlist);
    if (slot !== null) {
      setLoaded({ setlist, slot });
      // Keep the librarian row in step with the name the pedal reports.
      const name = result.structure.preset.name;
      if (name) {
        updateSetlistName(setlist, slot, name);
      }
    }
    setDeviceReport({ kind: 'preset', label, ...result });
  }

  async function readPresetFromDevice() {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    if (!confirmDiscardPedalDrafts()) {
      return;
    }
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Handshake…');
    appendLog('Reading the active preset…');
    try {
      // The fallback read (object 22 only) cannot tell the slot, so only reuse
      // a name when the editor already shows the pedal's active preset.
      const result = await readActivePreset(
        connection,
        reportProgress,
        activePresetLoaded && loaded
          ? (setlists[loaded.setlist]?.[loaded.slot]?.name ?? '')
          : '',
      );
      const slot = result.structure.preset.slot;
      const setlist: SetlistKind =
        result.structure.preset.setlist === 0 ? 0 : 1;
      showPreset(result, 'active preset from pedal', 'Active preset', setlist, slot);
      setActivePresetLoaded(true);
      setUsbBusy(null);
      appendLog(
        `Read active preset: ${result.chunks} chunk(s)${
          result.truncated ? ', truncated' : ''
        }, ${result.structure.preset.name || 'unnamed'}.`,
      );
    } catch (error) {
      setUsbBusy(null);
      const message = errorMessage(error);
      setUsbError(message);
      appendLog(`ERROR active preset: ${message}`);
      console.error('[POD Go] active preset read failed', error);
    }
  }

  async function openSlotFromDevice(
    setlist: SetlistKind,
    entry: SetlistEntry,
  ) {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    if (!confirmDiscardPedalDrafts()) {
      return;
    }
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Handshake…');
    const label = `${SETLIST_LABELS[setlist]} ${slotLabel(entry.slot)}`;
    appendLog(`Reading ${label} (${entry.name})…`);
    try {
      const result = await readPresetSlot(
        connection,
        setlist,
        entry.slot,
        entry.name,
        reportProgress,
      );
      showPreset(result, `${label} from pedal`, label, setlist, entry.slot);
      // A slot read fetches a preset without recalling it, so the pedal still
      // runs another sound: writes stay blocked by `activePresetLoaded` until
      // the active preset is read again. The session arm switch is kept.
      setActivePresetLoaded(false);
      setUsbBusy(null);
      appendLog(
        `Read ${label}: ${result.chunks} chunk(s)${
          result.truncated ? ', truncated' : ''
        }.`,
      );
    } catch (error) {
      setUsbBusy(null);
      const message = errorMessage(error);
      setUsbError(message);
      appendLog(`ERROR slot read (${label}): ${message}`);
      console.error('[POD Go] slot read failed', error);
    }
  }

  /**
   * Save the working copy to the pedal.
   *
   * Offline this is deliberately an error: the export path is the supported
   * way to keep a preset without a pedal. On the pedal, drafts are applied as
   * one batch with operation 30, then operation 71 stores the active preset
   * (parameters included) in its User slot, so the change survives a preset
   * switch or a reboot. One confirmation covers the whole save.
   */
  async function saveWorkingPreset() {
    const connection = connectionRef.current;
    if (!connected || !connection) {
      setSaveNotice({
        kind: 'error',
        text:
          'No POD Go connected. Saving to the pedal is unavailable, but ' +
          'Export .pgp still works offline and keeps everything you changed.',
      });
      appendLog(
        'ERROR save: no POD Go connected; Export .pgp remains available.',
      );
      return;
    }
    if (!writeEnabled) {
      setSaveNotice({
        kind: 'error',
        text: 'Check “Enable writing” before saving to the pedal.',
      });
      return;
    }
    if (workingDoc) {
      setSaveNotice({
        kind: 'error',
        text:
          'This is an offline preset. This build has no validated path to ' +
          'write a preset body to the pedal; use Export .pgp and open the ' +
          'file in POD Go Edit instead.',
      });
      appendLog(
        'Save: offline preset cannot be written to the pedal; use Export .pgp.',
      );
      return;
    }
    if (!activePresetLoaded) {
      setSaveNotice({
        kind: 'error',
        text: 'Read the active preset from the pedal before saving changes.',
      });
      return;
    }
    const entries = Object.entries(pendingParams);
    if (writing || busy) {
      return;
    }

    // Operation 71 stores the active preset in a User slot, so the destination
    // must be known. Factory presets cannot be overwritten in place.
    const slot = structure?.preset.slot ?? null;
    const setlist = structure?.preset.setlist ?? null;
    const name = (structure?.preset.name ?? '').trim();
    if (setlist !== 1 || slot === null) {
      setSaveNotice({
        kind: 'error',
        text:
          'The active preset is not in the User setlist, so it cannot be ' +
          'stored in place. Use “Save to slot…” to store it in a User slot.',
      });
      return;
    }
    if (name.length === 0) {
      setSaveNotice({
        kind: 'error',
        text: 'The active preset has no name; rename it before saving.',
      });
      return;
    }
    if (entries.length === 0) {
      setSaveNotice({ kind: 'info', text: 'No changes to save.' });
      return;
    }

    const lines = entries
      .slice(0, 8)
      .map(([, edit]) => `• ${edit.label}`)
      .join('\n');
    const more =
      entries.length > 8 ? `\n… and ${entries.length - 8} more` : '';
    const confirmed = window.confirm(
      `Save ${entries.length} change(s) to the pedal?\n\n` +
        `${lines}${more}\n\n` +
        `Destination: User ${slotLabel(slot)} "${name}"\n\n` +
        'The parameters are applied first, then the preset is stored in its ' +
        'slot so the change survives a preset switch or a reboot.',
    );
    if (!confirmed) {
      appendLog('Save cancelled by the user.');
      return;
    }

    setUsbError(null);
    setSaveNotice(null);
    setWriting(true);
    let applied = 0;
    try {
      for (const [, edit] of entries) {
        reportProgress(
          `Saving ${applied + 1}/${entries.length}: ${edit.label}…`,
        );
        await writeParam(
          connection,
          {
            block: edit.block,
            param: edit.param,
            value: edit.value,
          },
          reportProgress,
        );
        applied += 1;
      }
      appendLog(
        `Save: ${applied} change(s) applied in RAM; storing User ${slotLabel(
          slot,
        )}…`,
      );
      reportProgress(`Storing User ${slotLabel(slot)} "${name}"…`);
      const stored = await savePreset(
        connection,
        { slot, name },
        reportProgress,
      );
      appendLog(
        `Save: stored after ${stored.attempts} attempt(s); frame ` +
          `${frameHex(stored.frame)}.`,
      );
      setPendingParams({});
      setDirty(false);
      setFreshBackup(null);
      setSaveNotice({
        kind: 'info',
        text:
          `${applied} change(s) saved to User ${slotLabel(slot)} "${name}". ` +
          'The preset is stored on the pedal.',
      });
      appendLog(
        `Save: ${applied} change(s) applied and stored at User ${slotLabel(
          slot,
        )}.`,
      );

      // Confirm the pedal's setlist still reports the stored slot.
      try {
        const list = await readSetlist(connection, 1, reportProgress);
        setSetlists((current) => ({ ...current, 1: list.entries }));
        clearPendingForSetlist(1);
        const entry = list.entries[slot];
        if (entry && entry.name === name) {
          appendLog(
            `Save verified: User ${slotLabel(slot)} reads "${entry.name}".`,
          );
        } else {
          appendLog(
            `WARNING save verification: User ${slotLabel(slot)} reads "${
              entry?.name ?? '—'
            }", expected "${name}".`,
          );
        }
      } catch (error) {
        appendLog(
          `WARNING save verification failed: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      setUsbError(message);
      setSaveNotice({ kind: 'error', text: `Save failed: ${message}` });
      appendLog(`ERROR save: ${message}`);
      console.error('[POD Go] batched parameter save failed', error);
    } finally {
      setWriting(false);
      setUsbBusy(null);
    }
  }

  /** Reflect an accepted write in the in-memory structure only. */
  function applyLocalParam(block: number, param: number, value: number) {
    setStructure((current) => {
      if (!current) {
        return current;
      }
      const chain = current.chain.map((entry) => {
        if (entry.slot !== block || !('params' in entry)) {
          return entry;
        }
        return {
          ...entry,
          params: entry.params.map((item, index) =>
            index === param ? value : item,
          ),
        };
      });
      return { ...current, chain };
    });
  }

  /** Open the save dialog, reusing the active preset's slot and name. */
  function openSaveDialog() {
    if (!connected || !writeEnabled || !activePresetLoaded || busy) {
      return;
    }
    setSaveBackup(null);
    setSaveBackupError(null);
    setSaveOpen(true);
    appendLog('Save dialog opened.');
  }

  /**
   * Read the destination slot and keep a byte-exact, downloadable backup.
   *
   * A free slot has no preset body: the read reports `key 104 is not a blob`
   * and there is nothing to preserve, so the dialog records an empty backup
   * instead of blocking the save.
   */
  async function prepareSaveBackup(slot: number) {
    const connection = connectionRef.current;
    if (!connection || saveBackupBusy || saveBusy) {
      return;
    }
    setSaveBackup(null);
    setSaveBackupError(null);
    setUsbError(null);
    setSaveBackupBusy(true);
    const existing = setlists[1]?.[slot]?.name ?? '';
    appendLog(
      `Save backup: reading User ${slotLabel(slot)} (${
        existing || 'empty slot'
      }) before writing…`,
    );
    try {
      const result = await readPresetSlot(
        connection,
        1,
        slot,
        existing,
        reportProgress,
      );
      const digest = await sha256Hex(result.blob);
      setSaveBackup({
        slot,
        name: existing,
        size: result.blob.length,
        sha256: digest,
        empty: false,
      });
      downloadBytes(result.blob, `podgo-user-${slotLabel(slot)}-backup.bin`);
      appendLog(
        `Save backup: ${result.blob.length} B from User ${slotLabel(
          slot,
        )}, SHA-256 ${digest}. Download started.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('not a blob: nil')) {
        setSaveBackup({
          slot,
          name: '',
          size: 0,
          sha256: null,
          empty: true,
        });
        appendLog(
          `Save backup: User ${slotLabel(slot)} is empty; nothing to back up.`,
        );
      } else {
        setSaveBackupError(message);
        appendLog(`ERROR save backup: ${message}`);
        console.error('[POD Go] destination backup failed', error);
      }
    } finally {
      setSaveBackupBusy(false);
      setUsbBusy(null);
    }
  }

  /** Reflect an accepted save in the in-memory structure and librarian. */
  function applyLocalSave(slot: number, name: string) {
    setStructure((current) =>
      current
        ? { ...current, preset: { setlist: 1, slot, name } }
        : current,
    );
    setPresetSource(`User ${slotLabel(slot)} (saved)`);
    setLoaded({ setlist: 1, slot });
    setSetlists((current) => {
      const entries = current[1];
      if (!entries) {
        return current;
      }
      return {
        ...current,
        1: entries.map((entry) =>
          entry.slot === slot ? { ...entry, name } : entry,
        ),
      };
    });
  }

  /**
   * Rename one setlist entry in the in-memory model, plus the loaded preset
   * when it points at the same slot.
   */
  function setLocalName(
    setlist: SetlistKind,
    slot: number,
    name: string,
  ): void {
    setSetlists((current) => {
      const entries = current[setlist];
      if (!entries) {
        return current;
      }
      return {
        ...current,
        [setlist]: entries.map((entry) =>
          entry.slot === slot ? { ...entry, name } : entry,
        ),
      };
    });
    setStructure((current) => {
      if (
        !current ||
        current.preset.setlist === null ||
        current.preset.slot === null
      ) {
        return current;
      }
      const currentSetlist = current.preset.setlist === 0 ? 0 : 1;
      if (currentSetlist !== setlist || current.preset.slot !== slot) {
        return current;
      }
      return { ...current, preset: { ...current.preset, name } };
    });
  }

  function upsertPending(edit: PendingEdit): void {
    setPending((current) => [
      ...current.filter((item) => item.key !== edit.key),
      edit,
    ]);
  }

  function clearPending(setlist: number, slot: number): void {
    const key = `${setlist}:${slot}`;
    setPending((current) => current.filter((item) => item.key !== key));
  }

  /**
   * Offline drafts are kept in `localDocs`, so switching slots no longer
   * throws them away. Only the pedal's RAM drafts (`pendingParams`) vanish
   * when another preset is opened, so ask before dropping those.
   */
  function confirmDiscardPedalDrafts(): boolean {
    if (Object.keys(pendingParams).length === 0) {
      return true;
    }
    return window.confirm(
      'Discard the parameter changes that are not saved to the pedal?',
    );
  }

  /** Record an offline edit so the slot reopens with its draft and chip. */
  function markSlotDirty(key: string): void {
    setDirty(true);
    setDirtySlots((current) =>
      current[key] ? current : { ...current, [key]: true },
    );
  }

  function clearSlotDirty(key: string): void {
    setDirtySlots((current) => {
      if (!current[key]) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function slotName(setlist: SetlistKind, slot: number): string {
    return setlists[setlist]?.[slot]?.name ?? '';
  }

  function updateSetlistName(
    setlist: SetlistKind,
    slot: number,
    name: string,
  ): void {
    setSetlists((current) => {
      const entries = current[setlist];
      if (!entries) {
        return current;
      }
      return {
        ...current,
        [setlist]: entries.map((entry) =>
          entry.slot === slot ? { ...entry, name } : entry,
        ),
      };
    });
  }

  function firstEmptyUserSlot(): number {
    return setlists[1]?.find((entry) => !entry.name)?.slot ?? 0;
  }

  /**
   * Open one offline document as the working copy.
   *
   * The document is cloned, so parameter edits stay drafts until the user
   * exports (or saves, which is pedal-only and currently unsupported for
   * JSON bodies).
   */
  function openLocalPreset(
    setlist: SetlistKind,
    slot: number,
    source?: EditPreset,
    options?: {
      fresh?: boolean;
      draftsConfirmed?: boolean;
      /** The `.pgb` this copy came from, when **Export .pgb** is available. */
      backup?: EditBackup | null;
    },
  ): boolean {
    const preset = source ?? localDocs[localKey(setlist, slot)];
    if (!preset) {
      return false;
    }
    if (!options?.draftsConfirmed && !confirmDiscardPedalDrafts()) {
      return false;
    }
    const key = localKey(setlist, slot);
    const working = clonePreset(preset);
    working.setlist = setlist;
    working.slot = slot;
    // Only the preset that came from a backup can rebuild it; opening any
    // other slot drops the offer so the wrong preset is never exported.
    setImportedBackup(options?.backup ?? null);
    setBackupExportKey(options?.backup ? key : null);
    setWorkingDoc(working);
    setWorkingSlot({ setlist: 1, slot });
    setStructure(toneToStructure(working));
    setPresetBlob(null);
    setPresetSource(
      `${SETLIST_LABELS[setlist]} ${slotLabel(slot)} · offline copy`,
    );
    setActiveSetlist(setlist);
    setLoaded({ setlist, slot });
    setActivePresetLoaded(false);
    // A slot reopens with its draft still flagged; a fresh copy starts clean.
    if (options?.fresh) {
      clearSlotDirty(key);
      setDirty(false);
    } else {
      setDirty(Boolean(dirtySlots[key]));
    }
    setPendingParams({});
    setSaveNotice(null);
    setActionsOpen(false);
    setImportOpen(false);
    setActionError(null);
    appendLog(
      `Opened offline preset "${working.name || 'unnamed'}" at ${
        SETLIST_LABELS[setlist]
      } ${slotLabel(slot)}.`,
    );
    return true;
  }

  /** Start a neutral preset in a User slot (no pedal required). */
  function startNewPreset(slot?: number): void {
    const target = slot ?? firstEmptyUserSlot();
    if (!confirmDiscardPedalDrafts()) {
      return;
    }
    if (
      localDocs[localKey(1, target)] &&
      !window.confirm(
        `Replace the preset at User ${slotLabel(
          target,
        )}? Its offline copy and unsaved changes will be discarded.`,
      )
    ) {
      return;
    }
    const name = slotName(1, target) || DEFAULT_PRESET_NAME;
    const preset = createDefaultPreset(name);
    preset.setlist = 1;
    preset.slot = target;
    setLocalDocs((current) => ({
      ...current,
      [localKey(1, target)]: preset,
    }));
    updateSetlistName(1, target, name);
    openLocalPreset(1, target, preset, {
      fresh: true,
      draftsConfirmed: true,
    });
    appendLog(`New offline preset at User ${slotLabel(target)}.`);
  }

  /** Open a slot: local copy offline, pedal read when connected. */
  function openSlot(kind: SetlistKind, entry: SetlistEntry): void {
    if (kind === 1) {
      const preset = localDocs[localKey(1, entry.slot)];
      if (preset) {
        openLocalPreset(1, entry.slot, preset);
        return;
      }
      if (connected) {
        void openSlotFromDevice(1, entry);
        return;
      }
      startNewPreset(entry.slot);
      return;
    }
    if (connected) {
      void openSlotFromDevice(0, entry);
      return;
    }
    setSaveNotice({
      kind: 'info',
      text:
        'Factory preset bodies are not bundled. Connect the pedal to read ' +
        'this preset, or edit and export the User preset instead.',
    });
  }

  /**
   * Show a preset imported from POD Go Edit (`.pgp` / `.pgb`).
   *
   * The import lands in the User slot chosen by the right-click menu (or the
   * first empty slot). The JSON is editable and exportable offline; it has no
   * `l6-helix` body, so device writes stay impossible.
   */
  function openImportedPreset(
    preset: EditPreset,
    label: string,
    source: { setlist: number; slot: number } | null = null,
    backup: EditBackup | null = null,
  ) {
    // Explicit right-click target, then the slot the .pgb entry came from,
    // then the first empty User slot.
    const target: WorkingSlot =
      importTarget ??
      (source && source.setlist === 1
        ? { setlist: 1, slot: source.slot }
        : { setlist: 1, slot: firstEmptyUserSlot() });
    const stored = clonePreset(preset);
    stored.setlist = 1;
    stored.slot = target.slot;
    const name = stored.name || DEFAULT_PRESET_NAME;
    if (!stored.name) {
      setImportedName(stored, name);
    }
    setLocalDocs((current) => ({
      ...current,
      [localKey(1, target.slot)]: stored,
    }));
    updateSetlistName(1, target.slot, name);
    setImportTarget(null);
    setImportOpen(false);
    // Remember the backup and where this preset sits in it, so Export .pgb
    // can rebuild the container with this slot replaced. The preset itself
    // opens in a User slot; `source` stays the slot inside the backup.
    const fromBackup =
      backup && source && backup.container
        ? { ...backup, source: { setlist: source.setlist, slot: source.slot } }
        : null;
    openLocalPreset(1, target.slot, stored, {
      fresh: true,
      backup: fromBackup,
    });
    appendLog(
      `Imported "${name}" from ${label} into User ${slotLabel(
        target.slot,
      )} (offline copy, exports as .pgp${
        backup && source ? ' or .pgb' : ''
      }).`,
    );
  }

  /**
   * Apply one parameter edit to the working copy.
   *
   * `block` is the 1-based chain slot the inspector shows; the vendor JSON
   * stores it as `dsp0.block<block - 1>`. Only the changed key is written, so
   * unknown fields and untouched values survive the export.
   */
  function editWorkingParam(
    block: number,
    paramIndex: number,
    value: number,
  ): void {
    const entry = structure?.chain.find((item) => item.slot === block);
    const model =
      entry && (entry.kind === 'block' || entry.kind === 'looper')
        ? modelById(entry.modelId)
        : null;
    const param = paramAt(model, paramIndex);
    if (!param) {
      return;
    }
    if (workingDoc) {
      const snapshotIndex = structure?.currentSnapshot ?? 0;
      if (
        hasImportedSnapshotParam(
          workingDoc,
          snapshotIndex,
          block - 1,
          param.n,
        )
      ) {
        setImportedSnapshotParam(
          workingDoc,
          snapshotIndex,
          block - 1,
          param.n,
          value,
        );
      }
      setImportedParam(workingDoc, block - 1, param.n, value);
      setWorkingDoc({ ...workingDoc });
    } else if (activePresetLoaded && connected) {
      setPendingParams((current) => ({
        ...current,
        [`${block}:${paramIndex}`]: {
          block,
          param: paramIndex,
          value,
          label: `${model?.display ?? 'Block'} · ${param.n} = ${value}`,
        },
      }));
    } else {
      setSaveNotice({
        kind: 'error',
        text:
          'This preset is read-only. Open a User preset from the pedal, or ' +
          'import/create an offline preset, then enable editing.',
      });
      return;
    }
    applyLocalParam(block, paramIndex, value);
    if (workingDoc && workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      setLocalDocs((current) => ({
        ...current,
        [key]: clonePreset(workingDoc),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    appendLog(
      `Draft: ${model?.display ?? 'block'} · ${param.n} = ${value} (not written).`,
    );
  }

  /**
   * Load a catalog model into the selected block of an offline preset.
   *
   * This is a JSON edit: it replaces the block object with the model's vendor
   * defaults and rebuilds the view, so it shows up immediately and exports in
   * `.pgp`. Pedal presets stay read-only here: writing a model needs the
   * chain-body path (op 40), which this build does not ship.
   */
  /**
   * Categories already used by the other blocks. Amp, Cab, Vol, Wah,
   * Send/Return and Looper are single-role blocks, so a second one is
   * refused before anything is written.
   */
  function usedModelCategories(skipSlot: number | null): Set<string> {
    const used = new Set<string>();
    for (const item of structure?.chain ?? []) {
      if (item.kind !== 'block' && item.kind !== 'looper') {
        continue;
      }
      if (skipSlot !== null && item.slot === skipSlot) {
        continue;
      }
      const category = modelById(item.modelId)?.category;
      if (category) {
        used.add(category);
      }
    }
    return used;
  }

  function changeModel(index: number | null, model: CatalogModel): void {
    if (index === null) {
      return;
    }
    if (!workingDoc) {
      setSaveNotice({
        kind: 'error',
        text:
          'Changing a model writes the preset body. Open an offline preset ' +
          '(or import a .pgp) to change it here; writing a model to the pedal ' +
          'is not implemented.',
      });
      return;
    }
    const block = index;
    const entry = structure?.chain.find((item) => item.slot === block + 1);
    const current =
      entry && (entry.kind === 'block' || entry.kind === 'looper')
        ? modelById(entry.modelId)
        : null;
    if (!canSwapModel(current, model, usedModelCategories(block + 1))) {
      setSaveNotice({
        kind: 'error',
        text: `${model.display} (${model.category ?? 'model'}) cannot go in this slot.`,
      });
      return;
    }
    setImportedModel(workingDoc, block, model);
    const next = { ...workingDoc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    if (workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      setLocalDocs((currentDocs) => ({
        ...currentDocs,
        [key]: clonePreset(next),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    setSaveNotice(null);
    appendLog(
      `Draft: block ${block + 1} → ${model.display} (${model.name}), ` +
        'vendor defaults, not written to the pedal.',
    );
  }

  /** Reorder blocks in an offline preset (drag and drop on the chain). */
  function moveBlock(from: number, to: number): void {
    if (from === to) {
      return;
    }
    if (!workingDoc) {
      return;
    }
    moveImportedBlock(workingDoc, from, to);
    const next = { ...workingDoc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    if (workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      setLocalDocs((currentDocs) => ({
        ...currentDocs,
        [key]: clonePreset(next),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    setSaveNotice(null);
    appendLog(
      `Draft: moved block ${from + 1} to ${to + 1} (not written to the pedal).`,
    );
  }

  /**
   * Commit a snapshot-only change to the working copy.
   *
   * Snapshot selection and labels live in the same JSON document as the rest
   * of the preset, so they follow the normal draft contract: the working copy
   * and the local library are updated, Save writes them to the pedal and
   * Export writes them to a `.pgp`.
   */
  function commitSnapshotDraft(changed: () => void, message: string): void {
    if (!workingDoc) {
      return;
    }
    changed();
    const next = { ...workingDoc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    if (workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      setLocalDocs((currentDocs) => ({
        ...currentDocs,
        [key]: clonePreset(next),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    setSaveNotice(null);
    appendLog(message);
  }

  /** Load one snapshot in an offline draft. */
  function selectSnapshot(index: number): void {
    if (!workingDoc || structure?.currentSnapshot === index) {
      return;
    }
    commitSnapshotDraft(
      () => setImportedSnapshot(workingDoc, index),
      `Draft: active snapshot set to ${index + 1} (not written to the pedal).`,
    );
  }

  /** Rename one snapshot in an offline draft (10 printable ASCII chars). */
  function renameSnapshot(index: number, name: string): void {
    if (!workingDoc) {
      return;
    }
    const error = validateSnapshotName(name);
    if (error) {
      setSaveNotice({ kind: 'error', text: error });
      return;
    }
    commitSnapshotDraft(
      () => setImportedSnapshotName(workingDoc, index, name),
      name
        ? `Draft: snapshot ${index + 1} renamed to "${name}" (not written).`
        : `Draft: snapshot ${index + 1} name cleared (not written).`,
    );
  }

  /**
   * Assign or remove the Snapshots controller on one parameter.
   *
   * The value currently displayed becomes the starting value in all four
   * snapshots. A parameter already driven by an EXP pedal or footswitch cannot
   * be converted here: doing so would delete that assignment.
   */
  function toggleSnapshotParam(
    block: number,
    paramIndex: number,
    assigned: boolean,
  ): void {
    if (!workingDoc || !structure) {
      return;
    }
    const entry = structure.chain.find((item) => item.slot === block + 1);
    const model =
      entry && (entry.kind === 'block' || entry.kind === 'looper')
        ? modelById(entry.modelId)
        : null;
    const param = paramAt(model, paramIndex);
    if (!entry || !param || !('params' in entry)) {
      return;
    }
    const existing = structure.controllers.find(
      (controller) =>
        controller.block === block && controller.paramIndex === paramIndex,
    );
    if (
      assigned &&
      existing &&
      existing.controller !== SNAPSHOT_CONTROLLER
    ) {
      setSaveNotice({
        kind: 'error',
        text:
          `${param.n} already has a controller assignment. Choose None in ` +
          'POD Go Edit first; this editor will not overwrite it silently.',
      });
      return;
    }
    const current = entry.params[paramIndex];
    const value = typeof current === 'boolean' ? current : (current ?? 0);
    commitSnapshotDraft(
      () =>
        setImportedSnapshotAssignment(
          workingDoc,
          block,
          param.n,
          assigned,
          value,
        ),
      assigned
        ? `Draft: ${param.n} now stores a value per snapshot (starting at ${String(value)}).`
        : `Draft: ${param.n} no longer changes with snapshots.`,
    );
  }

  /** Bypass or enable one block in the active snapshot. */
  function setBlockEnabled(block: number, enabled: boolean): void {
    if (!workingDoc) {
      return;
    }
    const index = structure?.currentSnapshot ?? 0;
    commitSnapshotDraft(
      () => setImportedBlockEnabled(workingDoc, index, block, enabled),
      `Draft: block ${block + 1} ${
        enabled ? 'enabled' : 'bypassed'
      } in snapshot ${index + 1} (not written).`,
    );
  }

  /** Change the LED colour of one snapshot. */
  function setSnapshotLedColor(index: number, color: number): void {
    if (!workingDoc) {
      return;
    }
    commitSnapshotDraft(
      () => setImportedSnapshotLedColor(workingDoc, index, color),
      `Draft: snapshot ${index + 1} LED colour set to palette ${color} (not written).`,
    );
  }

  /** Rename the working preset (offline copies only). */
  function renameWorkingPreset(): void {
    const preset = workingDoc;
    if (!preset) {
      setSaveNotice({
        kind: 'error',
        text:
          'Rename is available for offline presets. For the active pedal ' +
          'preset, use Developer tools → Advanced preset actions.',
      });
      return;
    }
    const next = window.prompt(
      'Preset name (printable ASCII, 16 bytes max)',
      preset.name,
    );
    if (next === null) {
      return;
    }
    const error = validatePresetName(next);
    if (error) {
      window.alert(error);
      return;
    }
    setImportedName(preset, next);
    setWorkingDoc({ ...preset });
    setStructure((current) =>
      current
        ? { ...current, preset: { ...current.preset, name: next } }
        : current,
    );
    if (workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      updateSetlistName(workingSlot.setlist, workingSlot.slot, next);
      setLocalDocs((current) => ({
        ...current,
        [key]: clonePreset(preset),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    appendLog(`Draft rename: "${next}" (not written).`);
  }

  /** Download any editable preset as the JSON POD Go Edit opens (`.pgp`). */
  function downloadEditPreset(preset: EditPreset): void {
    const text = serializePgp(preset);
    const bytes = new TextEncoder().encode(text);
    const file = presetFileName(preset.name);
    downloadBytes(bytes, file, 'application/json');
    appendLog(
      `Export: ${file} (${bytes.length} B, ${text.length} code points). ` +
        'POD Go Edit keeps unknown fields; this build only changed what you edited.',
    );
  }

  /** Export the working copy and keep the offline library in sync. */
  function exportWorkingPreset(): void {
    const preset = workingDoc;
    if (!preset) {
      setSaveNotice({
        kind: 'error',
        text:
          'This preset was read from the pedal and has no offline document. ' +
          'Use Developer tools → Download .bin for the raw body, or import a ' +
          '.pgp/.pgb to export one.',
      });
      return;
    }
    downloadEditPreset(preset);
    if (workingSlot) {
      const key = localKey(workingSlot.setlist, workingSlot.slot);
      setLocalDocs((current) => ({
        ...current,
        [key]: clonePreset(preset),
      }));
      clearSlotDirty(key);
    }
    setDirty(false);
    setSaveNotice({ kind: 'info', text: 'Exported. The offline copy is up to date.' });
  }

  /**
   * Download the imported `.pgb` with the working draft in its original slot.
   *
   * Every other member keeps its stored bytes, so impulse responses, globals
   * and unknown members survive. Only the source setlist is re-serialized and
   * recompressed. The file is rebuilt in this tab; nothing is uploaded.
   */
  async function exportBackup(): Promise<void> {
    const preset = workingDoc;
    const backup = importedBackup;
    const key = workingSlot
      ? localKey(workingSlot.setlist, workingSlot.slot)
      : null;
    if (
      !preset ||
      !backup ||
      !backup.source ||
      key === null ||
      key !== backupExportKey
    ) {
      setSaveNotice({
        kind: 'error',
        text:
          'Export .pgb needs a backup imported from a .pgb file. Open one ' +
          'with Import… first.',
      });
      return;
    }
    if (backupExportBusy) {
      return;
    }
    setBackupExportBusy(true);
    try {
      const edits = new Map<number, Map<number, EditPreset | null>>([
        [backup.source.setlist, new Map([[backup.source.slot, preset]])],
      ]);
      const bytes = await serializePgb(applyBackupEdits(backup, edits));
      const file = backupFileName(`podgo-backup-${new Date()
        .toISOString()
        .slice(0, 10)}`);
      downloadBytes(bytes, file);
      appendLog(
        `Export: ${file} (${bytes.length} B). Setlist ${
          backup.source.setlist
        } slot ${slotLabel(backup.source.slot)} updated; other members copied ` +
          'unchanged.',
      );
      setSaveNotice({
        kind: 'info',
        text: `Exported ${file}. Only the edited slot changed; every other member is byte-identical.`,
      });
      setLocalDocs((current) => ({
        ...current,
        [key]: clonePreset(preset),
      }));
      clearSlotDirty(key);
      setDirty(false);
    } catch (error) {
      const message = errorMessage(error);
      setSaveNotice({ kind: 'error', text: `Export .pgb failed: ${message}` });
      appendLog(`ERROR export .pgb: ${message}`);
    } finally {
      setBackupExportBusy(false);
    }
  }

  /** Export one slot's offline document, when it has one. */
  function exportSlot(kind: SetlistKind, slot: number): void {
    if (workingSlot?.setlist === kind && workingSlot.slot === slot && workingDoc) {
      exportWorkingPreset();
      return;
    }
    const preset = localDocs[localKey(kind, slot)];
    if (!preset) {
      setSaveNotice({
        kind: 'error',
        text:
          'No offline document for this slot. Open it from the pedal and use ' +
          'Developer tools → Download .bin, or import a .pgp/.pgb first.',
      });
      return;
    }
    downloadEditPreset(preset);
  }

  /** Rename a slot in the local library (right-click or double-click). */
  function renameSlot(kind: SetlistKind, slot: number): void {
    if (kind === 0) {
      setSaveNotice({
        kind: 'info',
        text: 'Factory presets are read-only. Rename a User preset instead.',
      });
      return;
    }
    const current = slotName(kind, slot);
    const next = window.prompt(
      'Preset name (printable ASCII, 16 bytes max)',
      current || DEFAULT_PRESET_NAME,
    );
    if (next === null) {
      return;
    }
    const error = validatePresetName(next);
    if (error) {
      window.alert(error);
      return;
    }
    updateSetlistName(kind, slot, next);
    if (workingSlot?.setlist === kind && workingSlot.slot === slot && workingDoc) {
      setImportedName(workingDoc, next);
      setWorkingDoc({ ...workingDoc });
      setStructure((state) =>
        state ? { ...state, preset: { ...state.preset, name: next } } : state,
      );
      const key = localKey(kind, slot);
      setLocalDocs((docs) => ({ ...docs, [key]: clonePreset(workingDoc) }));
      markSlotDirty(key);
    } else {
      const preset = localDocs[localKey(kind, slot)];
      if (preset) {
        const renamed = clonePreset(preset);
        setImportedName(renamed, next);
        setLocalDocs((docs) => ({
          ...docs,
          [localKey(kind, slot)]: renamed,
        }));
      }
    }
    setPending((list) => [
      ...list.filter((item) => item.key !== localKey(kind, slot)),
      { key: localKey(kind, slot), setlist: kind, slot, name: next, kind: 'rename' },
    ]);
    appendLog(`Local rename: ${SETLIST_LABELS[kind]} ${slotLabel(slot)} → "${next}".`);
  }

  /**
   * Copy one slot into the in-page clipboard.
   *
   * The body is taken from the working copy, the offline document, or — when
   * the pedal is connected — a fresh slot read, so right-clicking any named
   * slot works without opening it first. Copying only reads.
   */
  async function copySlot(kind: SetlistKind, slot: number): Promise<void> {
    const name = slotName(kind, slot);
    const isWorking =
      workingSlot?.setlist === kind && workingSlot.slot === slot;
    const preset = (isWorking ? workingDoc : null) ?? localDocs[localKey(kind, slot)];
    const blob = isWorking ? presetBlob : null;
    if (preset || blob) {
      setClipboard({ name: name || preset?.name || 'Preset', setlist: kind, slot });
      setClipboardDoc(preset ? clonePreset(preset) : null);
      setClipboardBlob(blob);
      setSaveNotice(null);
      appendLog(
        `Clipboard: "${name || preset?.name || 'unnamed'}" (${SETLIST_LABELS[kind]} ${slotLabel(slot)}).`,
      );
      return;
    }

    // Nothing in memory: read the slot from the pedal (read-only).
    const connection = connectionRef.current;
    if (!connected || !connection) {
      setSaveNotice({
        kind: 'error',
        text:
          name
            ? 'Nothing to copy yet: connect the pedal to read this slot, or open it first.'
            : 'Nothing to copy: this slot is empty.',
      });
      return;
    }
    if (busy) {
      return;
    }
    setSaveNotice(null);
    setUsbBusy('Handshake…');
    appendLog(
      `Copy: reading ${SETLIST_LABELS[kind]} ${slotLabel(slot)} (${
        name || 'unnamed'
      }) from the pedal…`,
    );
    try {
      const result = await readPresetSlot(
        connection,
        kind,
        slot,
        name,
        reportProgress,
      );
      setClipboard({ name: name || result.structure.preset.name, setlist: kind, slot });
      setClipboardDoc(null);
      setClipboardBlob(result.blob);
      appendLog(
        `Clipboard: "${name || result.structure.preset.name || 'unnamed'}" ` +
          `(${SETLIST_LABELS[kind]} ${slotLabel(slot)}, ${result.blob.length} B).`,
      );
    } catch (error) {
      const message = errorMessage(error);
      setSaveNotice({ kind: 'error', text: `Copy failed: ${message}` });
      appendLog(`ERROR copy (${SETLIST_LABELS[kind]} ${slotLabel(slot)}): ${message}`);
      console.error('[POD Go] slot copy failed', error);
    } finally {
      setUsbBusy(null);
    }
  }

  /** Paste or move the clipboard into a User slot, locally. */
  function pasteSlot(
    kind: SetlistKind,
    slot: number,
    mode: PasteMode,
  ): void {
    if (kind === 0) {
      setSaveNotice({ kind: 'info', text: 'Factory slots are read-only.' });
      return;
    }
    if (!clipboard) {
      setSaveNotice({ kind: 'info', text: 'The clipboard is empty.' });
      return;
    }
    if (mode === 'move' && clipboard.setlist === kind && clipboard.slot === slot) {
      setSaveNotice({ kind: 'info', text: 'Choose a different destination for a move.' });
      return;
    }
    if (!clipboardDoc) {
      setSaveNotice({
        kind: 'error',
        text:
          'The clipboard holds a pedal body, not an offline document. Use ' +
          'Developer tools → Advanced preset actions to write it to the pedal.',
      });
      return;
    }
    const name = clipboard.name || clipboardDoc.name || DEFAULT_PRESET_NAME;
    const dest = clonePreset(clipboardDoc);
    dest.setlist = 1;
    dest.slot = slot;
    setImportedName(dest, name);
    setLocalDocs((current) => ({
      ...current,
      [localKey(1, slot)]: dest,
    }));
    updateSetlistName(1, slot, name);

    if (mode === 'move') {
      const sourceKey = localKey(clipboard.setlist, clipboard.slot);
      updateSetlistName(clipboard.setlist, clipboard.slot, '');
      setLocalDocs((current) => {
        const next = { ...current };
        delete next[sourceKey];
        return next;
      });
      if (
        workingSlot?.setlist === clipboard.setlist &&
        workingSlot.slot === clipboard.slot
      ) {
        setWorkingSlot({ setlist: 1, slot });
      }
    }

    setPending((list) => [
      ...list.filter(
        (item) =>
          item.key !== localKey(1, slot) &&
          !(mode === 'move' && item.key === localKey(clipboard.setlist, clipboard.slot)),
      ),
      { key: localKey(1, slot), setlist: 1, slot, name, kind: mode },
    ]);
    appendLog(
      `Local ${mode}: "${name}" → User ${slotLabel(slot)} (not written to the pedal).`,
    );

    if (
      workingSlot?.setlist === 1 &&
      (workingSlot.slot === slot ||
        (mode === 'move' && workingSlot.slot === clipboard.slot))
    ) {
      openLocalPreset(1, slot, dest, { fresh: true });
    }
  }

  /** Swap two User slots: drag-and-drop reordering in the local setlist. */
  function moveSlot(from: number, to: number): void {
    if (from === to) {
      return;
    }
    const fromName = slotName(1, from);
    const toName = slotName(1, to);
    updateSetlistName(1, from, toName);
    updateSetlistName(1, to, fromName);
    setLocalDocs((current) => {
      const next = { ...current };
      const fromDoc = next[localKey(1, from)];
      const toDoc = next[localKey(1, to)];
      if (toDoc) {
        next[localKey(1, from)] = toDoc;
      } else {
        delete next[localKey(1, from)];
      }
      if (fromDoc) {
        next[localKey(1, to)] = fromDoc;
      } else {
        delete next[localKey(1, to)];
      }
      return next;
    });
    setPending((list) => {
      const rest = list.filter(
        (item) =>
          item.key !== localKey(1, from) && item.key !== localKey(1, to),
      );
      return [
        ...rest,
        { key: localKey(1, from), setlist: 1, slot: from, name: toName, kind: 'move' },
        { key: localKey(1, to), setlist: 1, slot: to, name: fromName, kind: 'move' },
      ];
    });
    setDirtySlots((current) => {
      const next = { ...current };
      const fromKey = localKey(1, from);
      const toKey = localKey(1, to);
      const fromDirty = next[fromKey];
      const toDirty = next[toKey];
      delete next[fromKey];
      delete next[toKey];
      if (toDirty) {
        next[fromKey] = true;
      }
      if (fromDirty) {
        next[toKey] = true;
      }
      return next;
    });
    if (workingSlot?.setlist === 1) {
      if (workingSlot.slot === from) {
        setWorkingSlot({ setlist: 1, slot: to });
      } else if (workingSlot.slot === to) {
        setWorkingSlot({ setlist: 1, slot: from });
      }
    }
    setDirty(true);
    appendLog(
      `Local move: User ${slotLabel(from)} ↔ User ${slotLabel(to)} (not written to the pedal).`,
    );
  }

  /** Right-click entry point from the librarian. */
  function openPresetMenu(
    kind: SetlistKind,
    entry: SetlistEntry,
    x: number,
    y: number,
  ): void {
    setContextMenu({ kind, slot: entry.slot, x, y });
  }

  function menuItems(kind: SetlistKind, slot: number): PresetMenuEntry[] {
    const name = slotName(kind, slot);
    const isWorking =
      workingSlot?.setlist === kind && workingSlot.slot === slot;
    const hasDoc =
      Boolean(localDocs[localKey(kind, slot)]) || (isWorking && Boolean(workingDoc));
    const empty = !name && !hasDoc;
    const items: PresetMenuEntry[] = [
      {
        id: 'menu-open',
        label: empty && kind === 1 ? 'Start a new preset here' : 'Open',
        onSelect: () => openSlot(kind, { slot, name }),
      },
    ];
    if (!empty) {
      items.push({
        id: 'menu-new',
        label: 'New preset here',
        disabled: kind === 0,
        onSelect: () => startNewPreset(slot),
      });
    }
    items.push(
      'separator',
      {
        id: 'menu-save',
        label: 'Save to Pedal',
        hint: !connected
          ? 'No pedal connected'
          : !writeEnabled
            ? 'Enable writing first'
            : 'Apply the drafts',
        disabled: !connected || !writeEnabled,
        onSelect: () => void saveWorkingPreset(),
      },
      {
        id: 'menu-rename',
        label: 'Rename…',
        disabled: kind === 0,
        onSelect: () => renameSlot(kind, slot),
      },
      {
        id: 'menu-copy',
        label: 'Copy',
        disabled: !name && !hasDoc,
        onSelect: () => void copySlot(kind, slot),
      },
      {
        id: 'menu-paste',
        label: 'Paste here',
        disabled: kind === 0 || !clipboard || !clipboardDoc,
        onSelect: () => pasteSlot(1, slot, 'paste'),
      },
      {
        id: 'menu-move',
        label: 'Move here',
        disabled:
          kind === 0 ||
          !clipboard ||
          !clipboardDoc ||
          (clipboard.setlist === 1 && clipboard.slot === slot),
        onSelect: () => pasteSlot(1, slot, 'move'),
      },
      'separator',
      {
        id: 'menu-export',
        label: 'Export .pgp',
        disabled: !hasDoc,
        onSelect: () => exportSlot(kind, slot),
      },
      {
        id: 'menu-import',
        label: 'Import .pgp…',
        disabled: kind === 0,
        onSelect: () => {
          setImportTarget({ setlist: 1, slot });
          setImportOpen(true);
        },
      },
    );
    return items;
  }

  function openActionsDialog() {
    if (!structure) {
      return;
    }
    setActionError(null);
    setActionsOpen(true);
    appendLog('Preset actions dialog opened.');
  }

  /** Keep the loaded body or offline document in memory. */
  function copyLoadedPreset() {
    if (!structure) {
      setActionError('Load a preset before copying.');
      return;
    }
    if (!presetBlob && !workingDoc) {
      setActionError('No updatable preset is open.');
      return;
    }
    if (structure.preset.setlist === null || structure.preset.slot === null) {
      setActionError('This preset has no setlist/slot; copy it after a slot read.');
      return;
    }
    const setlist: SetlistKind = structure.preset.setlist === 0 ? 0 : 1;
    setClipboard({
      name: structure.preset.name,
      setlist,
      slot: structure.preset.slot,
    });
    setClipboardBlob(presetBlob);
    setClipboardDoc(workingDoc ? clonePreset(workingDoc) : null);
    setActionError(null);
    appendLog(
      `Clipboard: ${structure.preset.name || 'unnamed'} (${
        SETLIST_LABELS[setlist]
      } ${slotLabel(structure.preset.slot)}).`,
    );
  }

  function renameLocal(name: string) {
    if (!structure || structure.preset.setlist === null || structure.preset.slot === null) {
      setActionError('No preset is loaded.');
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }
    const setlist: SetlistKind = structure.preset.setlist === 0 ? 0 : 1;
    const slot = structure.preset.slot;
    setLocalName(setlist, slot, name);
    if (workingDoc) {
      setImportedName(workingDoc, name);
      setWorkingDoc({ ...workingDoc });
      setDirty(true);
    }
    const preset = localDocs[localKey(setlist, slot)];
    if (preset) {
      const renamed = clonePreset(preset);
      setImportedName(renamed, name);
      setLocalDocs((current) => ({
        ...current,
        [localKey(setlist, slot)]: renamed,
      }));
    }
    upsertPending({
      key: `${setlist}:${slot}`,
      setlist,
      slot,
      name,
      kind: 'rename',
    });
    setActionError(null);
    appendLog(
      `Local rename: ${SETLIST_LABELS[setlist]} ${slotLabel(slot)} → "${name}" ` +
        '(not written to the pedal).',
    );
  }

  function pasteLocal(
    destSetlist: SetlistKind,
    destSlot: number,
    name: string,
    mode: PasteMode,
  ) {
    if (!clipboard) {
      setActionError('The clipboard is empty.');
      return;
    }
    if (mode === 'move' && destSetlist === clipboard.setlist && destSlot === clipboard.slot) {
      setActionError('Choose a different destination for a move.');
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }
    setLocalName(destSetlist, destSlot, name);
    if (clipboardDoc) {
      const dest = clonePreset(clipboardDoc);
      dest.setlist = destSetlist;
      dest.slot = destSlot;
      setImportedName(dest, name);
      setLocalDocs((current) => ({
        ...current,
        [localKey(destSetlist, destSlot)]: dest,
      }));
    }
    upsertPending({
      key: `${destSetlist}:${destSlot}`,
      setlist: destSetlist,
      slot: destSlot,
      name,
      kind: mode,
    });
    if (mode === 'move') {
      // The local model clears the source, but no evidenced operation can
      // clear a slot on the pedal: say so and keep the pending marker.
      setLocalName(clipboard.setlist, clipboard.slot, '');
      setLocalDocs((current) => {
        const next = { ...current };
        delete next[localKey(clipboard.setlist, clipboard.slot)];
        return next;
      });
      upsertPending({
        key: `${clipboard.setlist}:${clipboard.slot}`,
        setlist: clipboard.setlist,
        slot: clipboard.slot,
        name: '',
        kind: 'clear',
      });
    }
    setActionError(null);
    appendLog(
      `Local ${mode}: ${clipboard.name || 'unnamed'} → ${
        SETLIST_LABELS[destSetlist]
      } ${slotLabel(destSlot)} as "${name}" (not written to the pedal).`,
    );
  }

  /** Clear every pending marker once the pedal has been re-read. */
  function clearPendingForSetlist(setlist: SetlistKind): void {
    setPending((current) => current.filter((item) => item.setlist !== setlist));
  }

  async function saveToSlot(slot: number, name: string) {
    const connection = connectionRef.current;
    if (!connection || saveBusy) {
      return;
    }
    if (!writeEnabled || !activePresetLoaded) {
      appendLog('ERROR save refused: enable editing and read the active preset first.');
      return;
    }
    if (!saveBackup || saveBackup.slot !== slot) {
      setSaveBackupError('Read the destination slot before saving.');
      return;
    }

    setSaveBackupError(null);
    setUsbError(null);
    setSaveBusy(true);
    setUsbBusy('Saving preset…');
    appendLog(
      `Saving the active preset as "${name}" to User ${slotLabel(slot)}…`,
    );
    try {
      const result = await savePreset(connection, { slot, name }, reportProgress);
      appendLog(
        `Save accepted after ${result.attempts} attempt(s); frame ` +
          `${frameHex(result.frame)}.`,
      );
      applyLocalSave(slot, name);
      setFreshBackup(null);
      setSaveOpen(false);
      setSaveBackup(null);

      // Confirm the pedal's own setlist now shows the new name.
      try {
        const list = await readSetlist(connection, 1, reportProgress);
        setSetlists((current) => ({ ...current, 1: list.entries }));
        clearPendingForSetlist(1);
        const entry = list.entries[slot];
        if (entry && entry.name === name) {
          appendLog(
            `Save verified: User ${slotLabel(slot)} now reads "${entry.name}".`,
          );
        } else {
          appendLog(
            `WARNING save verification: User ${slotLabel(slot)} reads "${
              entry?.name ?? '—'
            }", expected "${name}".`,
          );
        }
      } catch (error) {
        const message = errorMessage(error);
        appendLog(`WARNING save verification failed: ${message}`);
        console.error('[POD Go] setlist verification failed', error);
      }
      setUsbBusy(null);
    } catch (error) {
      const message = errorMessage(error);
      setUsbError(message);
      setSaveBackupError(message);
      appendLog(`ERROR save: ${message}`);
      console.error('[POD Go] preset save failed', error);
    } finally {
      setSaveBusy(false);
      setUsbBusy(null);
    }
  }

  /**
   * Rename the active User preset on the pedal (operation 71).
   *
   * Operation 71 stores the active preset's metadata, so this is only offered
   * when the editor shows the active preset and it belongs to the User setlist.
   * One gate: the write button, then one `window.confirm`.
   */
  async function writeRename(name: string) {
    const connection = connectionRef.current;
    if (!connection || actionBusy) {
      return;
    }
    if (!writeEnabled || !activePresetLoaded) {
      setActionError('Enable writing and read the active preset first.');
      return;
    }
    if (
      !structure ||
      structure.preset.setlist !== 1 ||
      structure.preset.slot === null
    ) {
      setActionError(
        'Renaming on the pedal is limited to the active preset in the User setlist.',
      );
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }
    const slot = structure.preset.slot;
    const confirmed = window.confirm(
      `Rename the active preset to "${name}" on the pedal?\n\n` +
        `Destination: User ${slotLabel(slot)}\n\n` +
        'Operation 71 stores the active preset metadata. The sound is the ' +
        'active one; this is not a pure name edit.',
    );
    if (!confirmed) {
      appendLog('Rename cancelled by the user.');
      return;
    }

    setActionError(null);
    setActionBusy(true);
    setUsbBusy('Renaming preset…');
    appendLog(
      `Renaming the active preset to "${name}" at User ${slotLabel(slot)}…`,
    );
    try {
      const result = await savePreset(connection, { slot, name }, reportProgress);
      appendLog(
        `Rename accepted after ${result.attempts} attempt(s); frame ` +
          `${frameHex(result.frame)}.`,
      );
      setLocalName(1, slot, name);
      clearPending(1, slot);
      setFreshBackup(null);

      const list = await readSetlist(connection, 1, reportProgress);
      setSetlists((current) => ({ ...current, 1: list.entries }));
      clearPendingForSetlist(1);
      const entry = list.entries[slot];
      if (entry?.name === name) {
        appendLog(`Rename verified: User ${slotLabel(slot)} now reads "${name}".`);
      } else {
        appendLog(
          `WARNING rename verification: User ${slotLabel(slot)} reads "${
            entry?.name ?? '—'
          }", expected "${name}".`,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      appendLog(`ERROR rename: ${message}`);
      console.error('[POD Go] rename failed', error);
    } finally {
      setActionBusy(false);
      setUsbBusy(null);
    }
  }

  /**
   * Write the clipboard body to one User slot with operation 5.
   *
   * A one-entry `.pgbak` is built with the Rust core and replayed by
   * `RestoreFlow`, so the stream framing is exactly the tested restore path.
   * The slot is overwritten; one `window.confirm` is the only gate after the
   * explicit write button.
   */
  async function writePaste(destSlot: number, name: string, mode: PasteMode) {
    const connection = connectionRef.current;
    if (!connection || actionBusy) {
      return;
    }
    if (!writeEnabled) {
      setActionError('Enable writing first.');
      return;
    }
    if (!clipboard || !clipboardBlob) {
      setActionError('The clipboard is empty.');
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }
    const existing = setlists[1]?.[destSlot]?.name ?? '';
    const confirmed = window.confirm(
      `Write the clipboard preset to User ${slotLabel(destSlot)}?\n\n` +
        `Current: ${existing || 'empty'}\nNew name: ${name}\n\n` +
        'This overwrites the slot with operation 5 and cannot be undone ' +
        'without a copy of the current contents. Operation 5 has not been ' +
        'validated on hardware yet.' +
        (mode === 'move'
          ? '\n\nThe source slot is left untouched on the pedal.'
          : ''),
    );
    if (!confirmed) {
      appendLog('Preset write cancelled by the user.');
      return;
    }

    setActionError(null);
    setActionBusy(true);
    setUsbBusy('Writing preset…');
    appendLog(
      `Writing "${name}" to User ${slotLabel(destSlot)} from the clipboard ` +
        `(operation 5, ${clipboardBlob.length} B)…`,
    );
    try {
      const builder = new BackupBuilder(
        structure?.product ?? '',
        structure?.firmware ?? '',
      );
      let bytes: Uint8Array;
      try {
        builder.add(1, destSlot, name, clipboardBlob);
        bytes = builder.finish();
      } finally {
        builder.free();
      }

      const result = await restoreFullBackup(connection, bytes, (progress) => {
        if (progress.done > 0) {
          reportProgress(
            `Preset write ${progress.done}/${progress.total}: User slot ${
              progress.slot ?? '—'
            } (${progress.name || 'unnamed'})…`,
          );
        }
      });
      appendLog(`Preset write: ${result.entries} body streamed. Re-reading User…`);

      const list = await readSetlist(connection, 1, reportProgress);
      setSetlists((current) => ({ ...current, 1: list.entries }));
      clearPendingForSetlist(1);
      const entry = list.entries[destSlot];
      if (entry?.name === name) {
        appendLog(`Preset write verified: User ${slotLabel(destSlot)} reads "${name}".`);
      } else {
        appendLog(
          `WARNING preset write: User ${slotLabel(destSlot)} reads "${
            entry?.name ?? '—'
          }", expected "${name}". The body may have been written without the ` +
            'name (operation 9 is not sent by this build).',
        );
      }
      if (mode === 'move') {
        appendLog(
          `Move: the source ${SETLIST_LABELS[clipboard.setlist]} ` +
            `${slotLabel(clipboard.slot)} was not cleared on the pedal.`,
        );
      }
      setFreshBackup(null);
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      appendLog(`ERROR preset write: ${message}`);
      console.error('[POD Go] preset write failed', error);
    } finally {
      setActionBusy(false);
      setUsbBusy(null);
    }
  }

  /** Open the backup/restore dialog; reads stay available, restore is gated. */
  function openBackupDialog() {
    if (!connected || busy) {
      return;
    }
    setBackupError(null);
    setRestoreError(null);
    setBackupOpen(true);
    appendLog('Backup/restore dialog opened.');
  }

  /**
   * Read both setlists and every non-empty slot, then download a `.pgbak`.
   *
   * The result becomes the session's fresh backup: restore stays disabled until
   * one exists.
   */
  async function backupToFile() {
    const connection = connectionRef.current;
    if (!connection || backupBusy || restoreBusy) {
      return;
    }
    setUsbError(null);
    setBackupError(null);
    setRestoreError(null);
    setBackupBusy(true);
    setUsbBusy('Starting the full backup…');
    appendLog('Full backup: reading both setlists and every non-empty slot…');
    try {
      const result = await createFullBackup(connection, reportProgress);
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      downloadBytes(result.bytes, `podgo-full-backup-${stamp}.pgbak`);
      setFreshBackup(result.summary);
      appendLog(
        `Full backup: ${result.summary.entries.length} preset(s), ` +
          `${result.bytes.length} B, SHA-256 ${result.summary.digest}. ` +
          'Download started.',
      );
      if (result.skipped.length > 0) {
        appendLog(
          `Full backup: ${result.skipped.length} empty slot(s) skipped.`,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      setBackupError(message);
      setUsbError(message);
      appendLog(`ERROR full backup: ${message}`);
      console.error('[POD Go] full backup failed', error);
    } finally {
      setBackupBusy(false);
      setUsbBusy(null);
    }
  }

  /**
   * Stream a verified `.pgbak` back to the pedal, then re-read both setlists.
   *
   * Destructive: gated by armed writes and one confirmation. Operation 5 only;
   * see `usb/restore.ts`.
   */
  async function restoreBackup(bytes: Uint8Array, summary: BackupVerify) {
    const connection = connectionRef.current;
    if (!connection || restoreBusy) {
      return;
    }
    if (!writeEnabled) {
      setRestoreError('Enable writing first.');
      return;
    }
    const confirmed = window.confirm(
      `Restore ${summary.entries.length} preset(s) to the pedal?\n\n` +
        `File SHA-256: ${summary.digest}\n\n` +
        'Operation 5 overwrites the target slots. Slots absent from the file ' +
        'are left untouched. This cannot be undone without a backup.',
    );
    if (!confirmed) {
      appendLog('Restore cancelled by the user.');
      return;
    }

    setUsbError(null);
    setRestoreError(null);
    setRestoreBusy(true);
    setUsbBusy('Restoring…');
    appendLog(
      `Restore: streaming ${summary.entries.length} preset(s) from a file ` +
        `with SHA-256 ${summary.digest}…`,
    );
    try {
      const result = await restoreFullBackup(connection, bytes, (progress) => {
        if (progress.done === 0) {
          reportProgress(`Restore: ${progress.name}…`);
          return;
        }
        const label = progress.setlist === 0 ? 'Factory' : 'User';
        reportProgress(
          `Restore ${progress.done}/${progress.total}: ${label} slot ${
            progress.slot ?? '—'
          } (${progress.name || 'unnamed'})…`,
        );
      });
      appendLog(
        `Restore: ${result.entries} preset(s) streamed; verifying setlist names…`,
      );

      let checked = 0;
      let mismatches = 0;
      for (const setlist of [0, 1] as const) {
        const list = await readSetlist(connection, setlist, reportProgress);
        setSetlists((current) => ({ ...current, [setlist]: list.entries }));
        const expected = summary.entries.filter(
          (entry) => entry.setlist === setlist,
        );
        for (const entry of expected) {
          checked += 1;
          const current = list.entries[entry.slot];
          if (!current || current.name !== entry.name) {
            mismatches += 1;
            if (mismatches <= 8) {
              appendLog(
                `WARNING restore verification: ${
                  setlist === 0 ? 'Factory' : 'User'
                } slot ${entry.slot} reads "${current?.name ?? '—'}", expected "${
                  entry.name
                }".`,
              );
            }
          }
        }
      }
      if (mismatches === 0) {
        appendLog(`Restore verified: ${checked} name(s) match the backup.`);
      } else {
        appendLog(
          `WARNING restore verification: ${mismatches}/${checked} name(s) differ.`,
        );
      }
      // The pedal no longer matches the pre-restore backup.
      setFreshBackup(null);
      setPending([]);
      setBackupOpen(false);
      setUsbBusy(null);
    } catch (error) {
      const message = errorMessage(error);
      setRestoreError(message);
      setUsbError(message);
      appendLog(`ERROR restore: ${message}`);
      console.error('[POD Go] restore failed', error);
    } finally {
      setRestoreBusy(false);
      setUsbBusy(null);
    }
  }

  async function copyLog() {
    if (log.length === 0) {
      return;
    }
    try {
      await navigator.clipboard.writeText(log.join('\n'));
      setLogCopied(true);
      window.setTimeout(() => setLogCopied(false), 1500);
    } catch (error) {
      const message = `Could not copy the log: ${errorMessage(error)}`;
      setUsbError(message);
      appendLog(`ERROR: ${message}`);
      console.error('[POD Go] clipboard write failed', error);
    }
  }

  function downloadPreset() {
    if (!presetBlob) {
      return;
    }
    downloadBytes(presetBlob, 'podgo-active-preset.bin');
  }

  const moduleReady = module.status === 'ready';
  const busy = usbBusy !== null;
  const connected = deviceInfo !== null;
  const canExport = workingDoc !== null;
  /** **Export .pgb** is only offered for the preset opened from a backup. */
  const canExportBackup =
    importedBackup !== null &&
    workingSlot !== null &&
    backupExportKey === localKey(workingSlot.setlist, workingSlot.slot);
  /** User slots that live only in the browser (offline copy or draft). */
  const browserSlots = new Set(Object.keys(localDocs));
  const canEditHere = workingDoc !== null || (connected && activePresetLoaded);
  const editable = canEditHere && !busy;
  const editHint = workingDoc
    ? 'Edits change this offline copy. Use Export .pgp to keep them.'
    : writeEnabled
      ? 'Changes are drafts until you press Save (Ctrl+S), which writes them to the pedal and stores the preset in its slot.'
      : 'Changes are drafts. Enable writing, then press Save (Ctrl+S) to write and store them on the pedal.';

  /**
   * Ctrl+S / Cmd+S saves the working copy, exactly like the header button:
   * only while a pedal is connected, the active preset is loaded and writing
   * is enabled. Otherwise it explains why, instead of writing.
   */
  const saveRef = useRef(saveWorkingPreset);
  saveRef.current = saveWorkingPreset;
  const saveBlockReason = !connected
    ? 'No POD Go connected. Export .pgp works offline.'
    : !writeEnabled
      ? 'Check “Enable writing” to save to the pedal. Export .pgp needs no pedal.'
      : !activePresetLoaded
        ? 'Read the active preset from the pedal before saving.'
        : null;
  const saveBlockRef = useRef<string | null>(saveBlockReason);
  saveBlockRef.current = saveBlockReason;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return;
      }
      // Do not hijack Ctrl+S inside a text field; a focused slider or the
      // Enable writing checkbox is not text entry, so Save still works.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const type = (target as HTMLInputElement | null)?.type;
      const typing =
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (tag === 'INPUT' &&
          !['range', 'checkbox', 'radio', 'button'].includes(type ?? 'text'));
      if (typing) {
        return;
      }
      event.preventDefault();
      const reason = saveBlockRef.current;
      if (reason) {
        setSaveNotice({ kind: 'info', text: reason });
        return;
      }
      void saveRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <main className="app">
      <header className="app-bar">
        <div className="brand">
          <h1>
            POD Go <span>Editor</span>
          </h1>
          <p className="subtitle">
            Unofficial preset editor — Rust core in WebAssembly. Works offline;
            connect a pedal for live reads and writes.
          </p>
        </div>

        <div className="header-actions">
          <button
            id="connect"
            type="button"
            className="toolbar-button"
            disabled={!moduleReady || !usbSupported || busy || connected}
            onClick={() => void connect()}
          >
            Connect
          </button>
          <button
            id="disconnect"
            type="button"
            className="toolbar-button"
            disabled={!connected || busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>

          {connected && (
            <label
              className="edit-arm"
              title="Safeguard: Save is disabled until you enable writing for this session"
            >
              <input
                id="arm-writes"
                type="checkbox"
                checked={writeEnabled}
                disabled={busy}
                onChange={(event) => {
                  setWriteEnabled(event.target.checked);
                  setSaveNotice(null);
                  appendLog(
                    event.target.checked
                      ? 'Writing enabled for this session.'
                      : 'Writing disabled.',
                  );
                }}
              />
              <span>Enable writing</span>
            </label>
          )}

          <button
            id="save-preset"
            type="button"
            className="toolbar-button is-primary"
            disabled={
              !moduleReady ||
              busy ||
              !connected ||
              !writeEnabled ||
              !activePresetLoaded
            }
            onClick={() => void saveWorkingPreset()}
            title={
              !connected
                ? 'Connect a POD Go to save. Export .pgp works offline.'
                : !writeEnabled
                  ? 'Check “Enable writing” first. Export .pgp needs no pedal.'
                  : !activePresetLoaded
                    ? 'Read the active preset from the pedal first.'
                    : 'Write the drafts to the pedal and store the preset in its slot (Ctrl+S)'
            }
          >
            Save
          </button>
          <button
            id="new-preset"
            type="button"
            className="toolbar-button"
            disabled={!moduleReady || busy}
            onClick={() => startNewPreset()}
            title="Create a neutral preset in the first empty User slot"
          >
            New
          </button>
          <button
            id="import-edit-file"
            type="button"
            className="toolbar-button"
            disabled={!moduleReady || busy}
            onClick={() => {
              setImportTarget(null);
              setImportOpen(true);
            }}
            title="Open a POD Go Edit .pgp preset or .pgb backup as an offline copy"
          >
            Import…
          </button>

          <ModuleBadge module={module} />
          <a
            className="github-link"
            href="https://github.com/Ultchad/open-podgoedit"
            target="_blank"
            rel="noreferrer"
            title="Open the source repository on GitHub"
            aria-label="Open the source repository on GitHub"
          >
            <svg
              viewBox="0 0 16 16"
              width="18"
              height="18"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
          </a>
        </div>
      </header>

      {!connected && (
        <p id="offline-notice" className="notice is-offline" role="status">
          <strong>No POD Go connected.</strong> Factory names and one default
          User preset are loaded so you can edit and export offline. Saving
          needs the pedal; <strong>Export .pgp</strong> always works.
        </p>
      )}

      {saveNotice && (
        <p
          id="save-notice"
          className={`notice ${saveNotice.kind === 'error' ? 'is-error' : 'is-info'}`}
          role="alert"
        >
          {saveNotice.text}
        </p>
      )}

      <div className="workspace">
        <PresetList
          setlists={setlists}
          activeSetlist={activeSetlist}
          loadedSetlist={loaded?.setlist ?? null}
          loadedSlot={loaded?.slot ?? null}
          canRead={connected && !busy}
          onSetlist={setActiveSetlist}
          onOpenSlot={(setlist, entry) => openSlot(setlist, entry)}
          onContextMenu={openPresetMenu}
          onMoveSlot={moveSlot}
          browserSlots={browserSlots}
        />

        <section className="editor-pane">
          {structure ? (
            <PresetView
              structure={structure}
              source={presetSource}
              busy={busy}
              dirty={dirty}
              offline={workingDoc !== null}
              editable={editable}
              editHint={editHint}
              onEditParam={editWorkingParam}
              onSelectModel={workingDoc ? changeModel : undefined}
              onMoveBlock={workingDoc ? moveBlock : undefined}
              onSelectSnapshot={workingDoc ? selectSnapshot : undefined}
              onRenameSnapshot={workingDoc ? renameSnapshot : undefined}
              onSetSnapshotLedColor={
                workingDoc ? setSnapshotLedColor : undefined
              }
              onToggleSnapshotParam={
                workingDoc ? toggleSnapshotParam : undefined
              }
              onSetBlockEnabled={workingDoc ? setBlockEnabled : undefined}
              canExport={canExport}
              onExport={exportWorkingPreset}
              canExportBackup={canExportBackup}
              onExportBackup={() => void exportBackup()}
              canRename={workingDoc !== null}
              onRename={renameWorkingPreset}
            />
          ) : (
            <div className="empty-editor">
              <h2>No preset loaded</h2>
              <p>
                Pick a User preset on the left to edit and export offline, or
                connect a POD Go to read its presets.
              </p>
            </div>
          )}
        </section>
      </div>

      <details className="developer-tools" id="developer-tools">
        <summary>Developer tools — pedal reads, backups and raw reports</summary>
        <p className="hint">
          Everything here is for diagnostics and pedal-only operations. Normal
          editing lives in the header and the preset menu.
        </p>

        <section className="device-card">
          <div className="device-head">
            <div>
              <h2>POD Go connection (WebUSB)</h2>
              <p className="hint">
                Chrome or Edge, page served on <code>127.0.0.1</code>. Reads are
                always available; each pedal write is confirmed.
              </p>
            </div>
            <DeviceBadge
              supported={usbSupported}
              info={deviceInfo}
              busy={usbBusy}
              error={usbError}
            />
          </div>

          {!usbSupported && (
            <p className="inline-error">
              WebUSB is not available in this browser. File reports remain
              usable offline; Firefox and Safari cannot open the device.
            </p>
          )}

          <div className="actions">
            <button
              id="read-factory"
              type="button"
              disabled={!connected || busy}
              onClick={() => void readFromDevice(0)}
            >
              Read Factory
            </button>
            <button
              id="read-user"
              type="button"
              disabled={!connected || busy}
              onClick={() => void readFromDevice(1)}
            >
              Read User
            </button>
            <button
              id="read-preset"
              type="button"
              disabled={!connected || busy}
              onClick={() => void readPresetFromDevice()}
            >
              Read active preset
            </button>
            <button
              id="backup-restore"
              type="button"
              disabled={!connected || busy}
              onClick={openBackupDialog}
            >
              Full backup / restore
            </button>
            <button
              id="preset-actions"
              type="button"
              disabled={!structure || busy}
              onClick={openActionsDialog}
              title="Pedal-only library writes: rename, paste or move a preset body"
            >
              Advanced preset actions
            </button>
            <button
              id="download-preset"
              type="button"
              disabled={!presetBlob}
              onClick={downloadPreset}
              title="Download the raw l6-helix body of the preset read from the pedal"
            >
              Download .bin
            </button>
            <button
              id="save-to-slot"
              type="button"
              disabled={!connected || !writeEnabled || !activePresetLoaded || busy}
              onClick={openSaveDialog}
              title="Store the active preset in a User slot (metadata only)"
            >
              Save active preset to slot…
            </button>
          </div>

          {deviceInfo && (
            <p className="device-info">
              {describeDevice(deviceInfo)} ·{' '}
              {writeEnabled ? 'writing enabled' : 'read-only'}
            </p>
          )}
          {usbBusy && <p className="progress">{usbBusy}</p>}
          {usbError && <pre className="report error compact">{usbError}</pre>}

          {log.length > 0 && (
            <details className="diagnostics" open={usbError !== null}>
              <summary>Diagnostics log · {log.length} line(s)</summary>
              <div className="actions">
                <button
                  id="copy-log"
                  type="button"
                  onClick={() => void copyLog()}
                >
                  {logCopied ? 'Copied' : 'Copy log'}
                </button>
              </div>
              <pre className="report log">{log.join('\n')}</pre>
            </details>
          )}

          {deviceReport && (
            <div className="device-report">
              <div className="panel-head">
                <h2>
                  {deviceReport.kind === 'setlist'
                    ? `Setlist ${SETLIST_LABELS[deviceReport.setlist]}`
                    : deviceReport.label}
                </h2>
                <span className="source">
                  {deviceReport.chunks} chunk(s)
                  {deviceReport.truncated ? ' · truncated' : ''}
                </span>
              </div>
              <pre className="report">{deviceReport.report}</pre>
            </div>
          )}
        </section>

        <details className="offline-tools">
          <summary>Offline reports &amp; files</summary>
          <div className="grid">
            {(['preset', 'setlist'] as const).map((kind) => (
              <section className="panel" key={kind}>
                <div className="panel-head">
                  <h2>{LABELS[kind]}</h2>
                  <span className="source">{panels[kind].source || '—'}</span>
                </div>

                <div className="actions">
                  <button type="button" onClick={() => void loadFixture(kind)}>
                    Load fixture
                  </button>
                  <label className="file">
                    <span>Open a file…</span>
                    <input
                      type="file"
                      accept=".bin,application/octet-stream"
                      onChange={(event) => void onFile(kind, event)}
                    />
                  </label>
                </div>

                {panels[kind].error ? (
                  <pre className="report error">{panels[kind].error}</pre>
                ) : (
                  <pre className="report">
                    {panels[kind].text || 'Waiting…'}
                  </pre>
                )}
              </section>
            ))}
          </div>
        </details>
      </details>

      {contextMenu && (
        <PresetMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu.kind, contextMenu.slot)}
          onClose={() => setContextMenu(null)}
        />
      )}

      <SavePresetDialog
        open={saveOpen}
        busy={busy || saveBusy || saveBackupBusy}
        defaultSlot={
          structure?.preset.setlist === 1 ? structure.preset.slot : null
        }
        defaultName={structure?.preset.name ?? ''}
        backup={saveBackup}
        backupBusy={saveBackupBusy}
        backupError={saveBackupError}
        onClose={() => {
          setSaveOpen(false);
          setSaveBackup(null);
          setSaveBackupError(null);
        }}
        onPrepareBackup={(slot) => void prepareSaveBackup(slot)}
        onSave={(slot, name) => void saveToSlot(slot, name)}
      />

      <BackupRestoreDialog
        open={backupOpen}
        connected={connected}
        writeArmed={writeEnabled}
        busy={busy || saveBusy}
        setlists={setlists}
        freshBackup={freshBackup}
        backupBusy={backupBusy}
        backupError={backupError}
        restoreBusy={restoreBusy}
        restoreError={restoreError}
        onClose={() => {
          setBackupOpen(false);
          setBackupError(null);
          setRestoreError(null);
        }}
        onCreateBackup={() => void backupToFile()}
        onRestore={(bytes, summary) => void restoreBackup(bytes, summary)}
      />

      <PodgoEditImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          setImportTarget(null);
        }}
        onOpenPreset={openImportedPreset}
      />

      <PresetActionsDialog
        open={actionsOpen}
        busy={busy || saveBusy || restoreBusy || backupBusy}
        connected={connected}
        writeArmed={writeEnabled}
        activePresetLoaded={activePresetLoaded}
        structure={structure}
        setlists={setlists}
        clipboard={clipboard}
        pending={pending}
        actionBusy={actionBusy}
        actionError={actionError}
        onClose={() => {
          setActionsOpen(false);
          setActionError(null);
        }}
        onCopy={copyLoadedPreset}
        onClearClipboard={() => {
          setClipboard(null);
          setClipboardBlob(null);
          setClipboardDoc(null);
          appendLog('Clipboard cleared.');
        }}
        onRenameLocal={renameLocal}
        onPasteLocal={pasteLocal}
        onRenameWrite={(name) => void writeRename(name)}
        onPasteWrite={(slot, name, mode) => void writePaste(slot, name, mode)}
      />

      <p id="unofficial-disclaimer" className="disclaimer" role="note">
        <strong>Unofficial project.</strong> Not made, endorsed or supported by
        Line 6 / Yamaha Guitar Group, and not linked to the official POD Go Edit
        software. Use it at your own risk: the author is not responsible for any
        damage to your pedal, presets or data. Always keep a backup.
      </p>

      <footer>
        <span>
          Local only — no outgoing network request. Connect a POD Go for live
          reads and writes.
        </span>
        <span>
          Catalog: id → name → range data from the MIT-licensed openpodgo
          project. Vendor icons are not shipped.
        </span>
      </footer>
    </main>
  );
}

function ModuleBadge({ module }: { module: ModuleState }) {
  if (module.status === 'loading') {
    return <span className="badge loading">Loading WASM…</span>;
  }
  if (module.status === 'error') {
    return <span className="badge error">WASM unavailable</span>;
  }
  return <span className="badge ready">WASM ready · v{module.version}</span>;
}

function DeviceBadge({
  supported,
  info,
  busy,
  error,
}: {
  supported: boolean;
  info: PodgoDeviceInfo | null;
  busy: string | null;
  error: string | null;
}) {
  if (!supported) {
    return <span className="badge error">WebUSB unavailable</span>;
  }
  if (busy) {
    return <span className="badge loading">USB busy</span>;
  }
  if (error) {
    return <span className="badge error">USB error</span>;
  }
  if (info) {
    return (
      <span className="badge ready">
        {info.productName} · {info.productId.toString(16).toUpperCase()}
      </span>
    );
  }
  return <span className="badge idle">No device</span>;
}
