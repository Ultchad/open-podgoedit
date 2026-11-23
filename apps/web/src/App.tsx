import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { readInputFile } from './androidFiles';
import { isDesktopShell } from './desktop';
import {
  BackupBuilder,
  coreVersion,
  initWasm,
  inspectPreset,
  inspectSetlist,
  moveChainEntry,
  presetStructure,
  setlistEntries,
} from './wasmClient';
import {
  describeDevice,
  isUserCancellation,
  type PodgoDeviceInfo,
} from './usb/podgoUsb';
import {
  connectToPickerResult,
  requestPedal,
  runningOnAndroidShell,
  usbLinkSupported,
  type PodgoConnection,
} from './usb';
import { readActivePreset, readPresetSlot } from './usb/preset';
import { readSetlist, type SetlistKind } from './usb/setlist';
import { createFullBackup, createSelectedBackup } from './usb/backup';
import type { BackupTarget } from './usb/backup';
import { restoreFullBackup } from './usb/restore';
import {
  recallPreset,
  removeEffect,
  savePreset,
  writeBypass,
  writeChain,
  writeModel,
  writeParam,
} from './usb/write';
import type {
  BackupVerify,
  CatalogModel,
  ChainParamValue,
  PresetStructure,
  Selection,
  SetlistEntry,
} from './types';
import {
  canSwapModel,
  modelById,
  modelDefaultParams,
  paramAt,
  parseSlotLabel,
  slotLabel,
  wireIdOf,
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
  structureToEditPreset,
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

/** A model swap drafted on the pedal's active preset, applied by Save (op 40). */
interface PendingModel {
  block: number;
  modelId: number;
  noSnapshotBypass: boolean;
  label: string;
}

/** One effect copied from a preset, kept until it is pasted elsewhere. */
interface BlockClipboard {
  model: CatalogModel;
  /** Parameter values positionally, in `model.params` order. */
  params: ChainParamValue[];
}

/**
 * One bounded undo step for the loaded preset.
 *
 * Only the state a user edit can change is kept. The history is cleared when
 * another preset is opened, after a successful save/export and when an
 * editable copy is created, so it never mixes documents.
 */
interface EditorSnapshot {
  structure: PresetStructure | null;
  workingDoc: EditPreset | null;
  workingSlot: WorkingSlot | null;
  pendingParams: Record<string, PendingParam>;
  pendingModels: Record<string, PendingModel>;
  dirty: boolean;
  /** Clone of the working slot's offline document, when it had one. */
  localDoc: EditPreset | null;
  /** Key the clone belongs to (`setlist:slot`), or null without a slot. */
  localDocKey: string | null;
  /** Whether the working slot was flagged as an unsaved draft. */
  slotDirty: boolean;
  /** Short description shown by the undo/redo notice. */
  label: string;
}

/** Steps kept per preset; older edits are dropped. */
const HISTORY_LIMIT = 50;

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

/**
 * Back-button hook the Android shell calls before leaving the page.
 *
 * Returns `true` when the page handled the press (e.g. it closed the preset
 * drawer); `false` lets the shell close the app. Absent outside the shell.
 */
declare global {
  interface Window {
    __podgoBack?: () => boolean;
  }
}

/** Lowercase space-separated hex, for the diagnostics log. */
function frameHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ' ',
  );
}

/** Base64 encodes bytes for the Android save bridge. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Trigger a browser download for a byte buffer. */
function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = 'application/octet-stream',
): void {
  // A WebView cannot save a `blob:` link, so both native shells write the file
  // themselves. The Android side goes to the app's Downloads folder; the
  // desktop side opens a save dialog. The native side reports success and
  // failures itself, which is why nothing is returned here.
  const desktopSave = window.podgoDesktopFiles?.save;
  if (desktopSave) {
    desktopSave(filename, bytesToBase64(bytes)).catch(() => undefined);
    return;
  }
  const androidSave = window.podgoAndroidFiles?.save;
  if (androidSave) {
    androidSave(filename, bytesToBase64(bytes)).catch(() => undefined);
    return;
  }
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

declare global {
  interface Window {
    /** Native file save injected by the Android shell. */
    podgoAndroidFiles?: {
      /** Write `base64` as `name`; resolves to the stored path. */
      save(name: string, base64: string): Promise<string>;
      /** Read back a picked file; see `src/androidFiles.ts`. */
      read(name: string): Promise<string>;
    };
  }
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

/** Byte-for-byte comparison, used to verify an op-5 body read-back. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export default function App() {
  const [module, setModule] = useState<ModuleState>({ status: 'loading' });
  const [panels, setPanels] = useState<Record<Kind, PanelState>>({
    preset: EMPTY_PANEL,
    setlist: EMPTY_PANEL,
  });

  const [usbSupported] = useState(() => usbLinkSupported());
  const [androidShell] = useState(() => runningOnAndroidShell());
  const [desktopShell] = useState(() => isDesktopShell());
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

  /** Keep the shortcut target in step with the slot selected in PresetView. */
  const handleSelectionChange = useCallback((selection: Selection) => {
    setSelectedBlock(typeof selection === 'number' ? selection : null);
  }, []);

  const [structure, setStructure] = useState<PresetStructure | null>(null);
  const [presetBlob, setPresetBlob] = useState<Uint8Array | null>(null);
  const [presetSource, setPresetSource] = useState('—');
  const [setlists, setSetlists] = useState<
    Record<SetlistKind, SetlistEntry[] | null>
  >({ 0: null, 1: null });
  const [activeSetlist, setActiveSetlist] = useState<SetlistKind>(1);
  /** On a phone the librarian becomes an off-canvas drawer. */
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    setlist: SetlistKind;
    slot: number;
  } | null>(null);
  // The pedal's write path is always live while a pedal is connected: the old
  // "Enable writing" arm was removed on request, together with the per-action
  // confirmations. An edit reaches the pedal as soon as it is made and Save
  // stores it; nothing is ever sent while no pedal is connected.
  /** True only when the editor shows the preset the pedal has active. */
  const [activePresetLoaded, setActivePresetLoaded] = useState(false);
  /**
   * User slot the pedal had active when it was last read.
   *
   * Re-opening that slot means "show the active preset again", not "read some
   * stored slot": the page re-reads object 22 so Save and the bypass control
   * stay available without a manual reload. A slot read of any other position
   * still disarms writes until the active preset is read back.
   */
  const [activePresetAt, setActivePresetAt] = useState<{
    setlist: SetlistKind;
    slot: number;
  } | null>(null);
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
  /** Model swaps for the active pedal preset, applied by Save (op 40). */
  const [pendingModels, setPendingModels] = useState<
    Record<string, PendingModel>
  >({});
  /** Bounded undo/redo for edits to the loaded preset, kept in this tab. */
  const historyRef = useRef<{
    past: EditorSnapshot[];
    future: EditorSnapshot[];
  }>({ past: [], future: [] });
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  /** Effect copied with Ctrl/Cmd+C, ready to paste into another preset. */
  const [blockClipboard, setBlockClipboard] = useState<BlockClipboard | null>(
    null,
  );
  /** 0-based processing slot selected in the editor, reported by PresetView. */
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null);
  /** Sticky message under the header (no pedal, save unavailable, …). */
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    kind?: number;
    slot?: number;
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

  const connectionRef = useRef<PodgoConnection | null>(null);
  /** Latest `usbBusy` for `await`ed code that must wait for the channel. */
  const usbBusyRef = useRef<string | null>(null);
  usbBusyRef.current = usbBusy;

  /**
   * Serialized, coalescing queue for live edits.
   *
   * The pedal applies every write immediately, but the write channel cannot
   * interleave commands: a slider drag would otherwise start a new handshake
   * before the previous command's status. Tasks are keyed by target (for
   * example `block:param`) so only the latest value is sent, and a single
   * promise chain runs them one at a time.
   */
  const liveQueueRef = useRef(
    new Map<string, { label: string; run: () => Promise<unknown> }>(),
  );
  const liveChainRef = useRef<Promise<void>>(Promise.resolve());

  function queueLiveWrite(
    key: string,
    label: string,
    run: () => Promise<unknown>,
  ): void {
    liveQueueRef.current.set(key, { label, run });
    liveChainRef.current = liveChainRef.current.then(() => drainLiveWrites());
  }

  async function drainLiveWrites(): Promise<void> {
    for (;;) {
      const next = liveQueueRef.current.entries().next();
      if (next.done) {
        return;
      }
      const [key, task] = next.value;
      liveQueueRef.current.delete(key);
      try {
        await task.run();
        appendLog(`Live: ${task.label} sent to the pedal (not stored).`);
      } catch (error) {
        const message = errorMessage(error);
        setSaveNotice({
          kind: 'error',
          text: `Live change failed: ${message}`,
        });
        appendLog(`ERROR live ${task.label}: ${message}`);
      } finally {
        // The flow reports progress, which the channel indicator shows; the
        // live queue must release it so Save is not stuck waiting.
        setUsbBusy(null);
        setWriting(false);
      }
    }
  }

  /** Wait until every queued live edit has been sent. */
  async function flushLiveWrites(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = liveChainRef.current;
      await chain;
    } while (chain !== liveChainRef.current);
  }

  /**
   * Run one pedal operation that is not a single slider edit.
   *
   * Recall, chain uploads and removals each own the write channel for several
   * seconds. They set `writing` so Save, the move and the remove handlers
   * refuse to interleave, and they must release it however they end.
   */
  async function runPedalOperation(task: () => Promise<void>): Promise<void> {
    setWriting(true);
    try {
      await flushLiveWrites();
      await task();
    } finally {
      setWriting(false);
      setUsbBusy(null);
    }
  }

  // Warn before leaving with edits that only exist in this tab.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Escape closes the phone preset drawer.
  useEffect(() => {
    if (!libraryOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setLibraryOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [libraryOpen]);

  // Bring the Android back button to the page so it closes whatever is open
  // (the phone preset drawer here) instead of leaving the app mid-edit. The
  // native side asks the page first and only navigates back when the page has
  // nothing to dismiss.
  useEffect(() => {
    if (!androidShell) {
      return;
    }
    window.__podgoBack = () => {
      if (libraryOpen) {
        setLibraryOpen(false);
        return true;
      }
      return false;
    };
    return () => {
      delete window.__podgoBack;
    };
  }, [androidShell, libraryOpen]);

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
          setPendingModels({});
          setLoaded(null);
          resetHistory();
          // A file or fixture is not the pedal's active preset: writes would
          // target a different sound, so disarm until the device is re-read.
          setActivePresetLoaded(false);
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
    void openLocalPreset(1, 0, preset);
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
    const chosen = await readInputFile(event);
    if (!chosen) {
      return;
    }
    run(kind, chosen.bytes, chosen.name);
  }

  async function connect() {
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy(
      androidShell || desktopShell
        ? 'Opening the USB device…'
        : 'Selecting the device…',
    );
    appendLog(
      androidShell
        ? 'Opening the POD Go over Android USB host…'
        : desktopShell
          ? 'Opening the POD Go over desktop USB (libusb)…'
          : 'Opening the WebUSB device picker…',
    );
    try {
      const device = await requestPedal();
      setUsbBusy('Opening the vendor interface…');
      appendLog('Device selected; claiming the vendor interface…');
      const connection = await connectToPickerResult(device);
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
  async function loadFromPedalOnConnect(connection: PodgoConnection) {
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
      setActivePresetAt(slot === null ? null : { setlist, slot });
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
      setActivePresetLoaded(false);
      setActivePresetAt(null);
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
    if (!(await confirmDiscardPedalDrafts())) {
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
        setPendingModels({});
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
    setPendingModels({});
    setSaveNotice(null);
    resetHistory();
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

  /**
   * Read the pedal's active preset (object 23 then object 22) and make it the
   * edit target again.
   *
   * Shared by the **Read active preset** button and by re-opening the slot the
   * pedal has active: either way the page must end up holding the pedal's
   * current edit buffer, not a stored slot body, before Save (op 30/71) or the
   * bypass control is allowed to act on it.
   */
  async function loadActivePreset(
    connection: PodgoConnection,
    reason: string,
  ): Promise<{
    ok: boolean;
    location: { setlist: SetlistKind; slot: number } | null;
  }> {
    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Handshake…');
    appendLog(reason);
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
      const location = slot === null ? null : { setlist, slot };
      setActivePresetLoaded(true);
      setActivePresetAt(location);
      setUsbBusy(null);
      appendLog(
        `Read active preset: ${result.chunks} chunk(s)${
          result.truncated ? ', truncated' : ''
        }, ${result.structure.preset.name || 'unnamed'}.`,
      );
      return { ok: true, location };
    } catch (error) {
      setUsbBusy(null);
      const message = errorMessage(error);
      setUsbError(message);
      appendLog(`ERROR active preset: ${message}`);
      console.error('[POD Go] active preset read failed', error);
      return { ok: false, location: null };
    }
  }

  async function readPresetFromDevice() {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    if (!(await confirmDiscardPedalDrafts())) {
      return;
    }
    await loadActivePreset(connection, 'Reading the active preset…');
  }

  async function openSlotFromDevice(
    setlist: SetlistKind,
    entry: SetlistEntry,
  ) {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    if (!(await confirmDiscardPedalDrafts())) {
      return;
    }
    const label = `${SETLIST_LABELS[setlist]} ${slotLabel(entry.slot)}`;

    // Clicking the slot the pedal has active is the user's way of returning to
    // it after browsing another preset. Re-read the active preset instead of
    // the stored slot body: that keeps Save and the bypass control armed, and
    // it picks up the pedal's current edit buffer too.
    if (
      activePresetAt !== null &&
      activePresetAt.setlist === setlist &&
      activePresetAt.slot === entry.slot
    ) {
      const { ok, location } = await loadActivePreset(
        connection,
        `Re-reading the pedal's active preset ${label}…`,
      );
      if (
        ok &&
        location &&
        (location.setlist !== setlist || location.slot !== entry.slot)
      ) {
        setSaveNotice({
          kind: 'info',
          text:
            `The pedal's active preset is now ${SETLIST_LABELS[location.setlist]} ` +
            `${slotLabel(location.slot)}; the editor opened that preset.`,
        });
      }
      return;
    }

    // Switching presets is a real recall (op 20) while a pedal is connected,
    // so the pedal plays the slot and the editor reads back its edit buffer.
    if (connected) {
      setUsbError(null);
      setDeviceReport(null);
      setUsbBusy('Recall…');
      await runPedalOperation(async () => {
        try {
          appendLog(`Recalling ${label} (${entry.name}) on the pedal…`);
          const recalled = await recallPreset(
            connection,
            { setlist, slot: entry.slot },
            reportProgress,
          );
          appendLog(
            `Recall: ${label} after ${recalled.attempts} attempt(s); ` +
              'the pedal now plays that preset. Reading it back…',
          );
          await loadActivePreset(
            connection,
            `Reading the recalled preset ${label}…`,
          );
        } catch (error) {
          const message = errorMessage(error);
          setUsbError(message);
          setSaveNotice({ kind: 'error', text: `Recall failed: ${message}` });
          appendLog(`ERROR recall (${label}): ${message}`);
          console.error('[POD Go] recall failed', error);
        }
      });
      return;
    }

    setUsbError(null);
    setDeviceReport(null);
    setUsbBusy('Handshake…');
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
   * way to keep a preset without a pedal. On the pedal, queued model swaps
   * (operation 40) and parameter drafts (operation 30) are applied first, then
   * operation 71 stores the active preset (parameters included) in its User
   * slot, so the change survives a preset switch or a reboot. One confirmation
   * covers the whole save.
   *
   * Model writes come from the MIT reference's annotated capture and are not
   * yet validated on hardware here.
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
    const models = Object.entries(pendingModels);
    const changeCount = entries.length + models.length;
    // Live edits are already audible on the pedal but not stored until op 71.
    const liveChanges = dirty;
    if (writing) {
      setSaveNotice({
        kind: 'info',
        text: 'Another pedal write is still running; press Save again in a moment.',
      });
      return;
    }
    // `usbBusy` also covers the connect-time reads, so wait for those instead
    // of ignoring the key press.
    if (usbBusy !== null) {
      await flushLiveWrites();
      // Bounded: a stalled indicator must not silently swallow the save.
      for (
        let waited = 0;
        usbBusyRef.current !== null && waited < 20000;
        waited += 150
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
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
    if (changeCount === 0 && !liveChanges) {
      setSaveNotice({ kind: 'info', text: 'No changes to save.' });
      return;
    }

    const confirmed = window.confirm(
      `Save the active preset to User ${slotLabel(slot)} "${name}"?`,
    );
    if (!confirmed) {
      appendLog('Save cancelled by the user.');
      return;
    }

    if (!(await storeActivePreset(connection))) {
      return;
    }
  }

  /**
   * Store the active preset in its User slot with operation 71.
   *
   * Live changes are already on the pedal, so this only stores: it waits for
   * the write channel, applies any drafts queued while no pedal was connected,
   * sends op 71, then verifies the setlist name. Returns false on failure.
   */
  async function storeActivePreset(
    connection: PodgoConnection,
  ): Promise<boolean> {
    const slot = structure?.preset.slot ?? null;
    const name = (structure?.preset.name ?? '').trim();
    if (slot === null || name.length === 0) {
      setSaveNotice({
        kind: 'error',
        text: 'The active preset has no User slot or name to store.',
      });
      return false;
    }
    setUsbError(null);
    setSaveNotice(null);
    setWriting(true);
    try {
      await flushLiveWrites();
      const applied = await applyPendingDrafts(connection);
      reportProgress(`Storing User ${slotLabel(slot)} "${name}"…`);
      const stored = await savePreset(connection, { slot, name }, reportProgress);
      appendLog(
        `Save: stored after ${stored.attempts} attempt(s); frame ` +
          `${frameHex(stored.frame)}.`,
      );
      setPendingParams({});
      setPendingModels({});
      setDirty(false);
      resetHistory();
      setFreshBackup(null);
      setSaveNotice({
        kind: 'info',
        text:
          `Saved to User ${slotLabel(slot)} "${name}". ` +
          (applied.models || applied.params
            ? `${applied.models} model(s) and ${applied.params} parameter(s) ` +
              'were applied first. '
            : '') +
          'The preset is stored on the pedal.',
      });
      // Confirm the pedal's setlist still reports the stored slot.
      try {
        const list = await readSetlist(connection, 1, reportProgress);
        setSetlists((current) => ({ ...current, 1: list.entries }));
        clearPendingForSetlist(1);
        const entry = list.entries[slot];
        if (entry && entry.name === name) {
          appendLog(`Save verified: User ${slotLabel(slot)} reads "${entry.name}".`);
        } else {
          appendLog(
            `WARNING save verification: User ${slotLabel(slot)} reads "${
              entry?.name ?? '—'
            }", expected "${name}".`,
          );
        }
      } catch (error) {
        appendLog(`WARNING save verification failed: ${errorMessage(error)}`);
      }
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setUsbError(message);
      setSaveNotice({ kind: 'error', text: `Save failed: ${message}` });
      appendLog(`ERROR save: ${message}`);
      console.error('[POD Go] save failed', error);
      return false;
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

  /** Reflect an accepted bypass write in the in-memory structure only. */
  function applyLocalBlockEnabled(block: number, enabled: boolean) {
    setStructure((current) => {
      if (!current) {
        return current;
      }
      const rawSlot = block + 1;
      const chain = current.chain.map((entry) =>
        entry.slot === rawSlot &&
        (entry.kind === 'block' || entry.kind === 'looper')
          ? { ...entry, enabled }
          : entry,
      );
      return { ...current, chain };
    });
  }

  /**
   * Reflect a model swap in the in-memory structure.
   *
   * `block` is the 0-based `dsp0` index (the inspector's processing index).
   * The new entry keeps the block's bypass flags and takes the catalog
   * defaults, which is what the pedal loads. Controllers and snapshot
   * overrides attached to the old model no longer refer to existing
   * parameters, so they are dropped for that block.
   */
  function applyLocalModel(block: number, model: CatalogModel) {
    setStructure((current) => {
      if (!current) {
        return current;
      }
      const rawSlot = block + 1;
      const chain = current.chain.map((entry) => {
        if (entry.slot !== rawSlot) {
          return entry;
        }
        const enabled =
          entry.kind === 'block' || entry.kind === 'looper'
            ? entry.enabled
            : true;
        const noSnapshotBypass =
          entry.kind === 'block' ? entry.noSnapshotBypass : false;
        const params = modelDefaultParams(model);
        const modelId = wireIdOf(model) ?? 0;
        return model.category === 'Looper'
          ? { slot: rawSlot, kind: 'looper' as const, modelId, enabled, params }
          : {
              slot: rawSlot,
              kind: 'block' as const,
              modelId,
              category: null,
              enabled,
              noSnapshotBypass,
              params,
            };
      });
      const controllers = (current.controllers ?? []).filter(
        (entry) => entry.block !== block,
      );
      const snapshots = (current.snapshots ?? []).map((snapshot) => ({
        ...snapshot,
        controllers: (snapshot.controllers ?? []).filter(
          (entry) => entry.block !== block,
        ),
      }));
      return { ...current, chain, controllers, snapshots };
    });
  }

  /**
   * Apply queued model swaps (op 40) then parameter drafts (op 30) to the
   * pedal's active preset. Drafts stay queued until operation 71 succeeds.
   */
  async function applyPendingDrafts(
    connection: PodgoConnection,
  ): Promise<{ models: number; params: number }> {
    const models = Object.values(pendingModels);
    const params = Object.values(pendingParams);
    for (const [index, model] of models.entries()) {
      reportProgress(
        `Saving model ${index + 1}/${models.length}: ${model.label}…`,
      );
      await writeModel(
        connection,
        {
          block: model.block,
          wireId: model.modelId,
          noSnapshotBypass: model.noSnapshotBypass,
        },
        reportProgress,
      );
    }
    for (const [index, edit] of params.entries()) {
      reportProgress(
        `Saving parameter ${index + 1}/${params.length}: ${edit.label}…`,
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
    }
    return { models: models.length, params: params.length };
  }

  /** Open the save dialog, reusing the active preset's slot and name. */
  function openSaveDialog() {
    if (!connected || !activePresetLoaded || busy) {
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
   * Ask before leaving the pedal's preset with changes that were not stored.
   *
   * Live edits are audible on the pedal but are not stored until Save runs
   * operation 71, so switching presets would lose them. The user picks
   * Save / Don't save / Cancel; Save stores the current preset first.
   * Returns true when it is fine to continue.
   */
  async function confirmDiscardPedalDrafts(): Promise<boolean> {
    const count =
      Object.keys(pendingParams).length + Object.keys(pendingModels).length;
    const liveUnsaved = activePresetLoaded && dirty && !workingDoc;
    if (!connected || (count === 0 && !liveUnsaved)) {
      return true;
    }
    const connection = connectionRef.current;
    const canStore =
      connection !== null &&
      structure?.preset.setlist === 1 &&
      structure.preset.slot !== null;
    const choice = window.prompt(
      'This preset has changes that are not saved to its slot.\n\n' +
        (canStore
          ? 'Type "save" to store it first, "no" to discard the changes, ' +
            'or Cancel to stay.'
          : 'Type "no" to discard the changes, or Cancel to stay.'),
      canStore ? 'save' : 'no',
    );
    if (choice === null) {
      return false;
    }
    const answer = choice.trim().toLowerCase();
    if (answer === 'save' && canStore && connection) {
      if (await storeActivePreset(connection)) {
        return true;
      }
      // The store failed; the notice explains why. Stay on the preset.
      return false;
    }
    if (answer === 'no') {
      setPendingParams({});
      setPendingModels({});
      setDirty(false);
      appendLog('Discarded the unsaved changes.');
      return true;
    }
    return false;
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

  // --- bounded undo/redo ---------------------------------------------------
  // The stack lives in a ref so a key press never acts on stale state, while
  // the depth state re-renders the toolbar buttons. Everything stays in this
  // tab: no history is persisted and nothing is sent to the pedal by undo.

  function syncHistoryDepth(): void {
    setHistoryDepth({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  }

  function resetHistory(): void {
    historyRef.current = { past: [], future: [] };
    syncHistoryDepth();
  }

  /** Snapshot the current editor state, ready to be restored by Undo. */
  function captureHistory(label: string): EditorSnapshot {
    const key = workingSlot
      ? localKey(workingSlot.setlist, workingSlot.slot)
      : null;
    return {
      structure,
      workingDoc: workingDoc ? clonePreset(workingDoc) : null,
      workingSlot,
      pendingParams: { ...pendingParams },
      pendingModels: { ...pendingModels },
      dirty,
      localDoc: key && localDocs[key] ? clonePreset(localDocs[key]) : null,
      localDocKey: key,
      slotDirty: key ? Boolean(dirtySlots[key]) : false,
      label,
    };
  }

  function pushSnapshot(snapshot: EditorSnapshot): void {
    const past = [...historyRef.current.past, snapshot];
    if (past.length > HISTORY_LIMIT) {
      past.splice(0, past.length - HISTORY_LIMIT);
    }
    historyRef.current = { past, future: [] };
    syncHistoryDepth();
  }

  /** Record the state before an edit; call once, before mutating. */
  function pushHistory(label: string): void {
    pushSnapshot(captureHistory(label));
  }

  /**
   * Apply one snapshot. `discardKey` removes the local document an undone
   * action created (the snapshot itself had no working slot).
   */
  function restoreSnapshot(
    snapshot: EditorSnapshot,
    discardKey: string | null,
  ): void {
    setStructure(snapshot.structure);
    setWorkingDoc(
      snapshot.workingDoc ? clonePreset(snapshot.workingDoc) : null,
    );
    setWorkingSlot(snapshot.workingSlot);
    setPendingParams(snapshot.pendingParams);
    setPendingModels(snapshot.pendingModels);
    setDirty(snapshot.dirty);

    const key = snapshot.localDocKey;
    if (key) {
      setLocalDocs((current) => {
        const next = { ...current };
        if (snapshot.localDoc) {
          next[key] = clonePreset(snapshot.localDoc);
        } else {
          delete next[key];
        }
        return next;
      });
      setDirtySlots((current) => {
        const next = { ...current };
        if (snapshot.slotDirty) {
          next[key] = true;
        } else {
          delete next[key];
        }
        return next;
      });
    } else if (discardKey) {
      setLocalDocs((current) => {
        const next = { ...current };
        delete next[discardKey];
        return next;
      });
      setDirtySlots((current) => {
        const next = { ...current };
        delete next[discardKey];
        return next;
      });
    }
  }

  function undoEdit(): void {
    const { past, future } = historyRef.current;
    if (past.length === 0) {
      setSaveNotice({ kind: 'info', text: 'Nothing to undo.' });
      return;
    }
    const snapshot = past[past.length - 1];
    const currentKey = workingSlot
      ? localKey(workingSlot.setlist, workingSlot.slot)
      : null;
    const current = captureHistory(snapshot.label);
    historyRef.current = {
      past: past.slice(0, -1),
      future: [...future, current],
    };
    syncHistoryDepth();
    restoreSnapshot(snapshot, currentKey);
    setSaveNotice({ kind: 'info', text: `Undid ${snapshot.label}.` });
    appendLog(`Undo: ${snapshot.label}.`);
  }

  function redoEdit(): void {
    const { past, future } = historyRef.current;
    if (future.length === 0) {
      setSaveNotice({ kind: 'info', text: 'Nothing to redo.' });
      return;
    }
    const snapshot = future[future.length - 1];
    const currentKey = workingSlot
      ? localKey(workingSlot.setlist, workingSlot.slot)
      : null;
    const current = captureHistory(snapshot.label);
    historyRef.current = {
      past: [...past, current],
      future: future.slice(0, -1),
    };
    syncHistoryDepth();
    restoreSnapshot(snapshot, currentKey);
    setSaveNotice({ kind: 'info', text: `Redid ${snapshot.label}.` });
    appendLog(`Redo: ${snapshot.label}.`);
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
  async function openLocalPreset(
    setlist: SetlistKind,
    slot: number,
    source?: EditPreset,
    options?: {
      fresh?: boolean;
      draftsConfirmed?: boolean;
      /** The `.pgb` this copy came from, when **Export .pgb** is available. */
      backup?: EditBackup | null;
    },
  ): Promise<boolean> {
    const preset = source ?? localDocs[localKey(setlist, slot)];
    if (!preset) {
      return false;
    }
    if (!options?.draftsConfirmed && !(await confirmDiscardPedalDrafts())) {
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
    setPendingModels({});
    setSaveNotice(null);
    setActionsOpen(false);
    setImportOpen(false);
    setActionError(null);
    resetHistory();
    appendLog(
      `Opened offline preset "${working.name || 'unnamed'}" at ${
        SETLIST_LABELS[setlist]
      } ${slotLabel(slot)}.`,
    );
    return true;
  }

  /** Start a neutral preset in a User slot (no pedal required). */
  async function startNewPreset(slot?: number): Promise<void> {
    const target = slot ?? firstEmptyUserSlot();
    if (!(await confirmDiscardPedalDrafts())) {
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
    void openLocalPreset(1, target, preset, {
      fresh: true,
      draftsConfirmed: true,
    });
    appendLog(`New offline preset at User ${slotLabel(target)}.`);
  }

  /**
   * Open a slot.
   *
   * With a pedal connected the click always recalls the slot on the pedal and
   * shows its edit buffer, even when a browser copy of that slot exists: the
   * pedal's preset is what the user hears, so that is what must open. Offline,
   * a local copy opens, otherwise a new document starts.
   */
  function openSlot(kind: SetlistKind, entry: SetlistEntry): void {
    if (connected) {
      void openSlotFromDevice(kind, entry);
      return;
    }
    if (kind === 1) {
      const preset = localDocs[localKey(1, entry.slot)];
      if (preset) {
        void openLocalPreset(1, entry.slot, preset);
        return;
      }
      void startNewPreset(entry.slot);
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
    void openLocalPreset(1, target.slot, stored, {
      fresh: true,
      backup: fromBackup,
    });
    appendLog(
      `Imported "${name}" from ${label} into User ${slotLabel(
        target.slot,
      )} (offline copy, exports as .pgp${
        fromBackup ? ' or .pgb' : ''
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
    if (!workingDoc && !(activePresetLoaded && connected)) {
      setSaveNotice({
        kind: 'error',
        text:
          'This preset is read-only. Open a User preset from the pedal, or ' +
          'import/create an offline preset, then enable editing.',
      });
      return;
    }
    pushHistory('the parameter edit');
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
      if (connectionRef.current) {
        // Armed: op 30 reaches the pedal now, so the change is audible while
        // the user keeps turning the knob. Save (op 71) is what stores it.
        const connection = connectionRef.current;
        queueLiveWrite(
          `${block}:${paramIndex}`,
          `${model?.display ?? 'Block'} · ${param.n} = ${value} (live, not stored)`,
          () =>
            writeParam(
              connection,
              { block, param: paramIndex, value },
              reportProgress,
            ),
        );
      } else {
        // Not armed: keep the change in the page and let Save apply it after
        // the user enables writing.
        setPendingParams((current) => ({
          ...current,
          [`${block}:${paramIndex}`]: {
            block,
            param: paramIndex,
            value,
            label: `${model?.display ?? 'Block'} · ${param.n} = ${value}`,
          },
        }));
      }
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

  /**
   * Turn the preset read from the pedal into an editable offline copy.
   *
   * A device body is not a `.pgp` document, so this rebuilds one from the
   * structure the editor already shows. The copy stays in the browser: it can
   * be edited and exported as `.pgp`, but this build cannot write a preset
   * body back to the pedal.
   */
  function createEditableCopy(): { doc: EditPreset; slot: number } | null {
    if (!structure) {
      return null;
    }
    if (workingDoc) {
      return {
        doc: workingDoc,
        slot: workingSlot?.slot ?? structure.preset.slot ?? 0,
      };
    }

    const sourceSlot =
      structure.preset.setlist === 1 ? structure.preset.slot : null;
    const slotIsFree = (slot: number) =>
      !(localKey(1, slot) in localDocs) &&
      !setlists[1]?.find((entry) => entry.slot === slot)?.name;
    const slot =
      sourceSlot !== null &&
      !dirtySlots[localKey(1, sourceSlot)] &&
      !localDocs[localKey(1, sourceSlot)]
        ? sourceSlot
        : ((setlists[1] ?? []).find((entry) => slotIsFree(entry.slot))
            ?.slot ?? sourceSlot ?? 0);
    const doc = structureToEditPreset(structure, 1, slot);
    setWorkingDoc(doc);
    setWorkingSlot({ setlist: 1, slot });
    setActiveSetlist(1);
    setLoaded({ setlist: 1, slot });
    setPresetSource(`${SETLIST_LABELS[1]} ${slotLabel(slot)} · editable copy`);
    setLocalDocs((current) => ({
      ...current,
      [localKey(1, slot)]: clonePreset(doc),
    }));
    markSlotDirty(localKey(1, slot));
    setDirty(true);
    setActivePresetLoaded(false);
    setPendingParams({});
    setPendingModels({});
    setSaveNotice({
      kind: 'info',
      text:
        'Editable offline copy created. Model and parameter changes stay in ' +
        'the browser and export as .pgp; this build cannot write a preset ' +
        'body back to the pedal.',
    });
    appendLog(
      `Created an editable copy of "${doc.name || 'unnamed'}" at User ` +
        `${slotLabel(slot)} (offline draft, not written to the pedal).`,
    );
    return { doc, slot };
  }

  /**
   * Load a catalog model into the selected block.
   *
   * On the pedal's active preset the change is a draft: the in-memory
   * structure updates immediately and Save sends operation 40 (load the model,
   * defaults included) followed by operation 71 (store the active preset).
   * Offline documents are edited in JSON directly. With no editable target (a
   * slot read, or no pedal) the first model change asks to rebuild an editable
   * copy, as before.
   *
   * Operation 40 is unit-tested offline but not yet validated on hardware in
   * this repository, and an empty-slot add is the least proven case: the pedal
   * may reject it, which Save then reports.
   */
  function changeModel(index: number | null, model: CatalogModel): void {
    if (index === null || !structure) {
      return;
    }
    const block = index;
    const entry = structure.chain.find((item) => item.slot === block + 1);
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

    // Connected and armed: op 40 changes the pedal's edit buffer immediately.
    // Save (op 71) is what stores it, exactly like the official editor.
    if (!workingDoc && connected && activePresetLoaded) {
      const wireId = wireIdOf(model);
      if (wireId === null) {
        setSaveNotice({
          kind: 'error',
          text: `${model.display} has no on-wire id; it cannot be sent to the pedal.`,
        });
        return;
      }
      const rawBlock = block + 1;
      const noSnapshotBypass =
        entry && entry.kind === 'block' ? entry.noSnapshotBypass : false;
      const connection = connectionRef.current;
      pushHistory('the model change');
      // The old model's parameter drafts refer to different parameters.
      setPendingParams((queued) => {
        const next = { ...queued };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${rawBlock}:`)) {
            delete next[key];
          }
        }
        return next;
      });
      applyLocalModel(block, model);
      setDirty(true);
      setSaveNotice(null);
      if (connection) {
        setWriting(true);
        queueLiveWrite(
          `model:${rawBlock}`,
          `block ${rawBlock} → ${model.display}`,
          () =>
            writeModel(
              connection,
              { block: rawBlock, wireId, noSnapshotBypass },
              reportProgress,
            ),
        );
      }
      appendLog(
        `Live: block ${rawBlock} → ${model.display} (${model.name}); ` +
          'applied to the pedal, press Save to store it.',
      );
      return;
    }

    // Pedal draft: queue op 40 and update the structure the panel shows.
    if (!workingDoc && connected && activePresetLoaded) {
      const wireId = wireIdOf(model);
      if (wireId === null) {
        setSaveNotice({
          kind: 'error',
          text: `${model.display} has no on-wire id; it cannot be sent to the pedal.`,
        });
        return;
      }
      const rawBlock = block + 1;
      const noSnapshotBypass =
        entry && entry.kind === 'block' ? entry.noSnapshotBypass : false;
      pushHistory('the model change');
      setPendingModels((queued) => ({
        ...queued,
        [String(rawBlock)]: {
          block: rawBlock,
          modelId: wireId,
          noSnapshotBypass,
          label: `block ${rawBlock} → ${model.display}`,
        },
      }));
      // The old model's parameter drafts refer to different parameters.
      setPendingParams((queued) => {
        const next = { ...queued };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${rawBlock}:`)) {
            delete next[key];
          }
        }
        return next;
      });
      applyLocalModel(block, model);
      setDirty(true);
      setSaveNotice(null);
      appendLog(
        `Draft: block ${rawBlock} → ${model.display} (${model.name}); ` +
          'Save sends operation 40 then stores the preset. Not written yet.',
      );
      return;
    }

    const created = workingDoc ? null : createEditableCopy();
    if (!workingDoc && !created) {
      return;
    }
    const doc = created?.doc ?? workingDoc;
    if (!doc) {
      return;
    }
    pushHistory('the model change');
    setImportedModel(doc, block, model);
    const next = { ...doc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    const slot = created?.slot ?? workingSlot?.slot ?? null;
    if (slot !== null) {
      const key = localKey(1, slot);
      setLocalDocs((currentDocs) => ({
        ...currentDocs,
        [key]: clonePreset(next),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    setSaveNotice(
      created
        ? {
            kind: 'info',
            text:
              `${model.display} loaded on the editable offline copy. ` +
              'Export .pgp to keep it; this build cannot write a preset body ' +
              'back to the pedal.',
          }
        : null,
    );
    appendLog(
      `Draft: block ${block + 1} → ${model.display} (${model.name}), ` +
        'vendor defaults, not written to the pedal.',
    );
  }

  /** Reorder blocks in an offline preset or live on the pedal (op 21). */
  function moveBlock(from: number, to: number): void {
    if (from === to) {
      return;
    }
    if (!workingDoc) {
      if (!connected || !activePresetLoaded || !connectionRef.current) {
        setSaveNotice({
          kind: 'error',
          text:
            'Read the active preset from the pedal before reordering blocks.',
        });
        return;
      }
      if (writing || busy) {
        return;
      }
      void moveBlockOnPedal(from, to);
      return;
    }
    pushHistory('the block move');
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
   * Reorder the active preset's chain on the pedal (operation 21).
   *
   * The upload is a whole-chain write, so the blob must come from a fresh
   * object-22 read: any earlier copy would overwrite parameter changes made
   * live. The Rust domain layer splices the chain, the per-snapshot enables
   * and the footswitch targets, then the pedal applies the result.
   */
  async function moveBlockOnPedal(from: number, to: number): Promise<void> {
    const connection = connectionRef.current;
    if (!connection) {
      return;
    }
    setUsbError(null);
    setSaveNotice(null);
    await runPedalOperation(async () => {
      try {
        appendLog(
          "Move: reading the pedal's current edit buffer before the chain upload…",
        );
        const result = await readActivePreset(connection, reportProgress);
        const moved = moveChainEntry(result.blob, from + 1, to + 1);
        reportProgress(
          `Uploading the reordered chain: block ${from + 1} → ${to + 1}…`,
        );
        const sent = await writeChain(
          connection,
          { blob: moved },
          reportProgress,
        );
        appendLog(
          `Live: moved block ${from + 1} to ${to + 1} with operation 21 ` +
            `(${sent.attempts} attempt(s)); applied to the pedal, not stored.`,
        );
        setDirty(true);
        await loadActivePreset(
          connection,
          'Refreshing after the chain move…',
        );
        setSaveNotice({
          kind: 'info',
          text:
            `Block moved from ${from + 1} to ${to + 1} on the pedal. ` +
            'The change is live but not stored: press Save to keep it.',
        });
      } catch (error) {
        const message = errorMessage(error);
        setUsbError(message);
        setSaveNotice({ kind: 'error', text: `Chain move failed: ${message}` });
        appendLog(`ERROR chain move: ${message}`);
        console.error('[POD Go] chain move failed', error);
      }
    });
  }

  /**
   * Remove one effect from the active preset (operations 28 then 78).
   *
   * The official editor sends the pair and the pedal then reports the slot as
   * empty; the page re-reads the active preset so the chain (and the snapshot
   * enables) match the pedal again.
   */
  async function removeActiveBlock(block: number): Promise<void> {
    const connection = connectionRef.current;
    if (!connection || !activePresetLoaded || workingDoc) {
      return;
    }
    if (writing || busy) {
      return;
    }
    const raw = block + 1;

    setUsbError(null);
    setSaveNotice(null);
    await runPedalOperation(async () => {
      try {
        reportProgress(`Removing the effect in block ${raw}…`);
        const removed = await removeEffect(
          connection,
          { block: raw },
          reportProgress,
        );
        appendLog(
          `Live: removed block ${raw} with operations 28+78 ` +
            `(${removed.attempts} attempt(s)); applied to the pedal, not stored.`,
        );
        setDirty(true);
        await loadActivePreset(
          connection,
          'Refreshing after removing the effect…',
        );
        setSaveNotice({
          kind: 'info',
          text:
            `Effect in block ${raw} removed from the pedal. ` +
            'The change is live but not stored: press Save to keep it.',
        });
      } catch (error) {
        const message = errorMessage(error);
        setUsbError(message);
        setSaveNotice({
          kind: 'error',
          text: `Remove effect failed: ${message}`,
        });
        appendLog(`ERROR remove effect: ${message}`);
        console.error('[POD Go] remove effect failed', error);
      }
    });
  }

  /** Copy one amp/effect block for pasting into another preset. */
  function copyBlockAt(index: number): void {
    if (!structure) {
      return;
    }
    const entry = structure.chain.find((item) => item.slot === index + 1);
    if (!entry || (entry.kind !== 'block' && entry.kind !== 'looper')) {
      setSaveNotice({
        kind: 'error',
        text:
          'Copy works on an amp, effect or looper block. Input and Output ' +
          'are fixed stages.',
      });
      return;
    }
    const model = modelById(entry.modelId);
    if (!model) {
      setSaveNotice({
        kind: 'error',
        text: 'This block has no catalog model, so its effect cannot be copied.',
      });
      return;
    }
    setBlockClipboard({ model, params: [...entry.params] });
    setSaveNotice({
      kind: 'info',
      text:
        `Copied ${model.display}. Select a block and use Paste effect, or ` +
        'press Ctrl+V (Cmd+V on a Mac).',
    });
    appendLog(
      `Copied ${model.display} from block ${index + 1} to the effect clipboard.`,
    );
  }

  /** Ctrl/Cmd+C entry point; the effect menu passes an explicit index. */
  function copySelectedBlock(): void {
    if (selectedBlock === null) {
      setSaveNotice({
        kind: 'info',
        text: 'Select an amp or effect block to copy, then press Ctrl+C (Cmd+C on a Mac).',
      });
      return;
    }
    copyBlockAt(selectedBlock);
  }

  /**
   * Paste the effect clipboard into one processing slot.
   *
   * The model and its parameter values are copied; bypass state and snapshot
   * assignments stay with the destination block, because they belong to the
   * preset rather than to the effect. Offline the change edits the JSON
   * document; on the active pedal preset it queues operation 40 plus the
   * parameter drafts (op 30), which Save applies before storing the preset.
   */
  function pasteBlockAt(block: number): void {
    const clip = blockClipboard;
    if (!clip) {
      setSaveNotice({
        kind: 'info',
        text: 'The effect clipboard is empty. Select an effect and copy it first.',
      });
      return;
    }
    if (!structure) {
      return;
    }
    const entry = structure.chain.find((item) => item.slot === block + 1);
    if (
      !entry ||
      (entry.kind !== 'block' &&
        entry.kind !== 'looper' &&
        entry.kind !== 'empty')
    ) {
      setSaveNotice({
        kind: 'error',
        text:
          'Paste needs an amp or effect slot. Input and Output are fixed ' +
          'stages.',
      });
      return;
    }
    const current =
      entry.kind === 'block' || entry.kind === 'looper'
        ? modelById(entry.modelId)
        : null;
    if (!canSwapModel(current, clip.model, usedModelCategories(block + 1))) {
      setSaveNotice({
        kind: 'error',
        text: `${clip.model.display} (${clip.model.category ?? 'model'}) cannot go in this slot.`,
      });
      return;
    }
    const rawBlock = block + 1;

    // Connected and armed: op 40 loads the model, then op 30 applies each
    // copied value, all on the live queue. Save (op 71) stores the result.
    if (
      !workingDoc &&
      connected &&
      activePresetLoaded &&
      connectionRef.current
    ) {
      const connection = connectionRef.current;
      const wireId = wireIdOf(clip.model);
      if (wireId === null) {
        setSaveNotice({
          kind: 'error',
          text: `${clip.model.display} has no on-wire id; it cannot be sent to the pedal.`,
        });
        return;
      }
      const noSnapshotBypass =
        entry.kind === 'block' ? entry.noSnapshotBypass : false;
      pushHistory('the effect paste');
      setPendingParams((queued) => {
        const next = { ...queued };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${rawBlock}:`)) {
            delete next[key];
          }
        }
        return next;
      });
      applyLocalModel(block, clip.model);
      setDirty(true);
      setSaveNotice(null);
      setWriting(true);
      queueLiveWrite(
        `model:${rawBlock}`,
        `block ${rawBlock} → ${clip.model.display}`,
        () =>
          writeModel(
            connection,
            { block: rawBlock, wireId, noSnapshotBypass },
            reportProgress,
          ),
      );
      // Parameters are queued after the model and coalesced per parameter, so
      // the pedal sees op 40 first and then the copied values.
      clip.model.params.forEach((param, index) => {
        const value = clip.params[index];
        if (typeof value !== 'number') {
          return;
        }
        applyLocalParam(rawBlock, index, value);
        queueLiveWrite(
          `${rawBlock}:${index}`,
          `${clip.model.display} · ${param.n} = ${value} (live, not stored)`,
          () =>
            writeParam(
              connection,
              { block: rawBlock, param: index, value },
              reportProgress,
            ),
        );
      });
      appendLog(
        `Live: pasted ${clip.model.display} into block ${rawBlock} ` +
          '(op 40 + copied parameters); applied to the pedal, press Save to store it.',
      );
      return;
    }

    // Pedal draft: op 40 loads the model, then op 30 applies each value.
    if (!workingDoc && connected && activePresetLoaded) {
      const wireId = wireIdOf(clip.model);
      if (wireId === null) {
        setSaveNotice({
          kind: 'error',
          text: `${clip.model.display} has no on-wire id; it cannot be sent to the pedal.`,
        });
        return;
      }
      const noSnapshotBypass =
        entry.kind === 'block' ? entry.noSnapshotBypass : false;
      pushHistory('the effect paste');
      setPendingModels((queued) => ({
        ...queued,
        [String(rawBlock)]: {
          block: rawBlock,
          modelId: wireId,
          noSnapshotBypass,
          label: `block ${rawBlock} → ${clip.model.display}`,
        },
      }));
      setPendingParams((queued) => {
        const next = { ...queued };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${rawBlock}:`)) {
            delete next[key];
          }
        }
        clip.model.params.forEach((param, index) => {
          const value = clip.params[index];
          if (typeof value !== 'number') {
            return;
          }
          next[`${rawBlock}:${index}`] = {
            block: rawBlock,
            param: index,
            value,
            label: `${clip.model.display} · ${param.n} = ${value}`,
          };
        });
        return next;
      });
      applyLocalModel(block, clip.model);
      clip.model.params.forEach((_param, index) => {
        const value = clip.params[index];
        if (typeof value === 'number') {
          applyLocalParam(rawBlock, index, value);
        }
      });
      setDirty(true);
      setSaveNotice({
        kind: 'info',
        text:
          `Pasted ${clip.model.display} into block ${rawBlock}. Save sends ` +
          'operation 40, then the copied parameter drafts (op 30), then stores the preset.',
      });
      appendLog(
        `Draft: pasted ${clip.model.display} into block ${rawBlock} ` +
          '(op 40 + copied parameters, not written yet).',
      );
      return;
    }

    // Offline document (or a pedal read-only preset converted on request).
    const created = workingDoc ? null : createEditableCopy();
    if (!workingDoc && !created) {
      return;
    }
    const doc = created?.doc ?? workingDoc;
    if (!doc) {
      return;
    }
    if (created) {
      // Undo should keep the new editable copy and only revert the paste.
      historyRef.current = { past: [], future: [] };
      pushSnapshot({
        structure: toneToStructure(created.doc),
        workingDoc: clonePreset(created.doc),
        workingSlot: { setlist: 1, slot: created.slot },
        pendingParams: {},
        pendingModels: {},
        dirty: true,
        localDoc: clonePreset(created.doc),
        localDocKey: localKey(1, created.slot),
        slotDirty: true,
        label: 'the effect paste',
      });
    } else {
      pushHistory('the effect paste');
    }
    setImportedModel(doc, block, clip.model);
    clip.model.params.forEach((param, index) => {
      const value = clip.params[index];
      if (typeof value === 'number' || typeof value === 'boolean') {
        setImportedParam(doc, block, param.n, value);
      }
    });
    const next = { ...doc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    const slot = created?.slot ?? workingSlot?.slot ?? null;
    if (slot !== null) {
      const key = localKey(1, slot);
      setLocalDocs((currentDocs) => ({
        ...currentDocs,
        [key]: clonePreset(next),
      }));
      markSlotDirty(key);
    } else {
      setDirty(true);
    }
    setSaveNotice({
      kind: 'info',
      text:
        `Pasted ${clip.model.display} into block ${rawBlock} (draft, not ` +
        'written to the pedal). Ctrl+Z undoes it.',
    });
    appendLog(
      `Draft: pasted ${clip.model.display} into block ${rawBlock} ` +
        '(offline JSON, not written to the pedal).',
    );
  }

  /** Ctrl/Cmd+V entry point; the effect menu passes an explicit index. */
  function pasteSelectedBlock(): void {
    if (!blockClipboard) {
      setSaveNotice({
        kind: 'info',
        text: 'The effect clipboard is empty. Select an effect and press Ctrl+C (Cmd+C on a Mac) first.',
      });
      return;
    }
    if (selectedBlock === null) {
      setSaveNotice({
        kind: 'info',
        text: 'Select an amp or effect slot, then press Ctrl+V to paste.',
      });
      return;
    }
    pasteBlockAt(selectedBlock);
  }

  /**
   * Commit a snapshot-only change to the working copy.
   *
   * Snapshot selection and labels live in the same JSON document as the rest
   * of the preset, so they follow the normal draft contract: the working copy
   * and the local library are updated, Save writes them to the pedal and
   * Export writes them to a `.pgp`.
   */
  function commitSnapshotDraft(
    changed: (doc: EditPreset) => void,
    message: string,
    historyLabel = 'the snapshot edit',
    draft?: { doc: EditPreset; setlist: SetlistKind; slot: number },
  ): void {
    const doc = draft?.doc ?? workingDoc;
    if (!doc) {
      return;
    }
    pushHistory(historyLabel);
    changed(doc);
    const next = { ...doc };
    setWorkingDoc(next);
    setStructure(toneToStructure(next));
    const slot = draft
      ? { setlist: draft.setlist, slot: draft.slot }
      : workingSlot;
    if (slot) {
      const key = localKey(slot.setlist, slot.slot);
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
    if (structure?.currentSnapshot === index) {
      return;
    }
    if (!workingDoc) {
      // The pedal's snapshot is chosen on the pedal. No capture shows how the
      // editor recalls one, so the page only follows it.
      setSaveNotice({
        kind: 'info',
        text:
          `Snapshot ${index + 1} is selected in the editor. The pedal keeps ` +
          'its own snapshot: switch it on the pedal. Changing it here is not ' +
          'sent.',
      });
      setStructure((current) =>
        current ? { ...current, currentSnapshot: index } : current,
      );
      return;
    }
    commitSnapshotDraft(
      (doc) => setImportedSnapshot(doc, index),
      `Draft: active snapshot set to ${index + 1} (not written to the pedal).`,
      'the snapshot change',
    );
  }

  /** Rename one snapshot in an offline draft (10 printable ASCII chars). */
  function renameSnapshot(index: number, name: string): void {
    if (!workingDoc) {
      setSaveNotice({
        kind: 'info',
        text:
          'Snapshot names can be edited on an offline copy. The pedal keeps ' +
          `snapshot ${index + 1} as it is.`,
      });
      return;
    }
    const error = validateSnapshotName(name);
    if (error) {
      setSaveNotice({ kind: 'error', text: error });
      return;
    }
    commitSnapshotDraft(
      (doc) => setImportedSnapshotName(doc, index, name),
      name
        ? `Draft: snapshot ${index + 1} renamed to "${name}" (not written).`
        : `Draft: snapshot ${index + 1} name cleared (not written).`,
      'the snapshot rename',
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
      (doc) =>
        setImportedSnapshotAssignment(
          doc,
          block,
          param.n,
          assigned,
          value,
        ),
      assigned
        ? `Draft: ${param.n} now stores a value per snapshot (starting at ${String(value)}).`
        : `Draft: ${param.n} no longer changes with snapshots.`,
      'the snapshot assignment',
    );
  }

  /**
   * Bypass or enable one block in the active snapshot.
   *
   * A preset read from the pedal is read-only here, so the first bypass
   * change rebuilds an editable offline copy (and says so). This keeps the
   * control usable on a connected pedal without inventing an unvalidated
   * bypass write.
   */
  function setBlockEnabled(block: number, enabled: boolean): void {
    const index = structure?.currentSnapshot ?? 0;

    // Connected and armed: op 41 changes the pedal's edit buffer immediately.
    if (
      !workingDoc &&
      connected &&
      activePresetLoaded &&
      connectionRef.current
    ) {
      const connection = connectionRef.current;
      pushHistory('the bypass change');
      applyLocalBlockEnabled(block, enabled);
      setDirty(true);
      setSaveNotice(null);
      queueLiveWrite(
        `bypass:${block + 1}`,
        `block ${block + 1} ${enabled ? 'enabled' : 'bypassed'}`,
        () =>
          writeBypass(
            connection,
            { block: block + 1, enabled },
            reportProgress,
          ),
      );
      appendLog(
        `Live: block ${block + 1} ${enabled ? 'enabled' : 'bypassed'} in ` +
          `snapshot ${index + 1}; applied to the pedal, press Save to store it.`,
      );
      return;
    }

    if (!workingDoc) {
      // The pedal body stays read-only: the first bypass change on a
      // pedal-read preset asks for an editable offline copy, then applies the
      // bypass to that copy in the same step.
      const created = createEditableCopy();
      if (!created) {
        return;
      }
      commitSnapshotDraft(
        (doc) => setImportedBlockEnabled(doc, index, block, enabled),
        `Created an editable copy and set block ${block + 1} ` +
          `${enabled ? 'enabled' : 'bypassed'} in snapshot ${index + 1} ` +
          '(not written).',
        'the bypass change',
        { doc: created.doc, setlist: 1, slot: created.slot },
      );
      setSaveNotice({
        kind: 'info',
        text:
          `Block ${block + 1} ${enabled ? 'enabled' : 'bypassed'} on the ` +
          'editable offline copy. The pedal is unchanged: this build has no ' +
          'validated bypass write. Use the effect footswitch on the pedal, ' +
          'or export the copy as .pgp.',
      });
      return;
    }
    commitSnapshotDraft(
      (doc) => setImportedBlockEnabled(doc, index, block, enabled),
      `Draft: block ${block + 1} ${
        enabled ? 'enabled' : 'bypassed'
      } in snapshot ${index + 1} (not written).`,
      'the bypass change',
    );
    setSaveNotice({
      kind: 'info',
      text:
        `Block ${block + 1} ${enabled ? 'enabled' : 'bypassed'} on the ` +
        'offline copy. Nothing was sent to the pedal.',
    });
  }

  /** Change the LED colour of one snapshot. */
  function setSnapshotLedColor(index: number, color: number): void {
    if (!workingDoc) {
      setSaveNotice({
        kind: 'info',
        text:
          'Snapshot LED colours can be edited on an offline copy. The pedal ' +
          'keeps its own colours.',
      });
      return;
    }
    commitSnapshotDraft(
      (doc) => setImportedSnapshotLedColor(doc, index, color),
      `Draft: snapshot ${index + 1} LED colour set to palette ${color} (not written).`,
      'the LED colour change',
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
    pushHistory('the preset rename');
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
    resetHistory();
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

  /**
   * Copy a preset to another User slot (the librarian's “Copy to…” action).
   *
   * An offline document is cloned in the page and stays a draft. A pedal body
   * is read first and then written with operation 5, so it uses the same
   * write-armed, confirmed path as Paste.
   */
  async function copyToSlot(kind: SetlistKind, slot: number): Promise<void> {
    const isWorking =
      workingSlot?.setlist === kind && workingSlot.slot === slot;
    const preset =
      (isWorking ? workingDoc : null) ?? localDocs[localKey(kind, slot)];
    const loadedHere =
      structure?.preset.setlist === kind && structure.preset.slot === slot;
    /** The source is the pedal's current edit buffer, so op 71 can copy it. */
    const activeHere = loadedHere && activePresetLoaded && workingDoc === null;
    const sourceName =
      slotName(kind, slot) ||
      preset?.name ||
      (loadedHere ? structure?.preset.name ?? '' : '');

    const entered = window.prompt(
      `Copy "${sourceName || 'preset'}" to which User slot? (e.g. 13A):`,
      '',
    );
    if (entered === null) {
      return;
    }
    const target = parseSlotLabel(entered);
    if (target === null) {
      setSaveNotice({
        kind: 'error',
        text: `“${entered.trim()}” is not a slot. Use a label such as 13A or 01A…32D.`,
      });
      return;
    }
    if (kind === 1 && target === slot) {
      setSaveNotice({ kind: 'info', text: 'Choose a different slot.' });
      return;
    }


    // Offline document: clone locally, no pedal needed.
    if (preset) {
      const copyName = sourceName || preset.name || DEFAULT_PRESET_NAME;
      const copy = clonePreset(preset);
      copy.setlist = 1;
      copy.slot = target;
      setImportedName(copy, copyName);
      setLocalDocs((current) => ({
        ...current,
        [localKey(1, target)]: copy,
      }));
      updateSetlistName(1, target, copyName);
      setPending((list) => [
        ...list.filter((item) => item.key !== localKey(1, target)),
        {
          key: localKey(1, target),
          setlist: 1,
          slot: target,
          name: copyName,
          kind: 'paste',
        },
      ]);
      setSaveNotice({
        kind: 'info',
        text:
          `Copied “${copyName}” to User ${slotLabel(target)} as a local ` +
          'draft (not written to the pedal).',
      });
      appendLog(
        `Local copy: "${copyName}" → User ${slotLabel(target)} (not written to the pedal).`,
      );
      return;
    }

    // Pedal body: read it, then overwrite the destination with operation 5.
    if (!connected) {
      setSaveNotice({
        kind: 'error',
        text:
          'Connect the pedal to read this slot, or open it first to copy it ' +
          'as an offline document.',
      });
      return;
    }
    const connection = connectionRef.current;
    if (!connection || busy) {
      return;
    }

    // Copying the pedal's active preset does not need a body read: operation
    // 71 stores the current edit buffer in the destination slot. That path is
    // captured from POD Go Edit (docs/protocol/writes.md §2.5) and avoids the
    // unvalidated op-5 stream for the most common copy case.
    if (activeHere) {
      await writeActivePresetToSlot(
        target,
        sourceName || structure?.preset.name || DEFAULT_PRESET_NAME,
      );
      return;
    }

    let blob = loadedHere ? presetBlob : null;
    let copyName = sourceName;
    if (!blob) {
      setUsbBusy('Reading source slot…');
      appendLog(
        `Copy to: reading ${SETLIST_LABELS[kind]} ${slotLabel(slot)} ` +
          `(${sourceName || 'unnamed'})…`,
      );
      try {
        const result = await readPresetSlot(
          connection,
          kind,
          slot,
          sourceName,
          reportProgress,
        );
        blob = result.blob;
        copyName = copyName || result.structure.preset.name;
      } catch (error) {
        const message = errorMessage(error);
        setSaveNotice({ kind: 'error', text: `Copy failed: ${message}` });
        appendLog(
          `ERROR copy (${SETLIST_LABELS[kind]} ${slotLabel(slot)}): ${message}`,
        );
        console.error('[POD Go] copy-to read failed', error);
        return;
      } finally {
        setUsbBusy(null);
      }
    }
    if (!blob) {
      setSaveNotice({
        kind: 'error',
        text: 'The pedal returned no preset body for this slot.',
      });
      return;
    }
    await writeBodyToSlot(
      target,
      copyName || DEFAULT_PRESET_NAME,
      blob,
      'copy',
      { setlist: kind, slot, name: copyName },
    );
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
      // A slot copy holds the pedal's raw body. Paste it with operation 5
      // instead of dropping it: this is the same gated path as the advanced
      // dialog, and it is the only way a connected paste can work.
      if (!clipboardBlob) {
        setSaveNotice({ kind: 'error', text: 'The clipboard is empty.' });
        return;
      }
      if (!connected) {
        setSaveNotice({
          kind: 'error',
          text:
            'This clipboard holds a pedal body. Connect the pedal and enable ' +
            'writing to paste it, or open the source preset and copy it as an ' +
            'offline document.',
        });
        return;
      }
      const bodyName = clipboard.name || DEFAULT_PRESET_NAME;
      void writeBodyToSlot(slot, bodyName, clipboardBlob, mode, {
        setlist: clipboard.setlist,
        slot: clipboard.slot,
        name: clipboard.name,
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
      void openLocalPreset(1, slot, dest, { fresh: true });
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

  /** The preset the editor is showing, for the title's ⋯ menu. */
  function currentPresetTarget(): { kind: SetlistKind; slot: number } | null {
    if (workingSlot) {
      return { kind: workingSlot.setlist, slot: workingSlot.slot };
    }
    const kind = structure?.preset.setlist;
    const slot = structure?.preset.slot;
    if ((kind === 0 || kind === 1) && slot !== null && slot !== undefined) {
      return { kind, slot };
    }
    return null;
  }

  /** Open the same preset menu from the ⋯ button next to the name. */
  function openCurrentPresetMenu(x: number, y: number): void {
    const target = currentPresetTarget();
    if (!target) {
      return;
    }
    setContextMenu({ kind: target.kind, slot: target.slot, x, y });
  }

  function menuItems(kind: SetlistKind, slot: number): PresetMenuEntry[] {
    const isWorking =
      workingSlot?.setlist === kind && workingSlot.slot === slot;
    const isLoadedPedal =
      structure?.preset.setlist === kind && structure.preset.slot === slot;
    const name =
      slotName(kind, slot) ||
      (isWorking ? (workingDoc?.name ?? '') : '') ||
      (isLoadedPedal ? (structure?.preset.name ?? '') : '');
    const hasDoc =
      Boolean(localDocs[localKey(kind, slot)]) ||
      (isWorking && Boolean(workingDoc)) ||
      (isLoadedPedal && Boolean(presetBlob));
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
        onSelect: () => void startNewPreset(slot),
      });
    }
    items.push(
      'separator',
      {
        id: 'menu-save',
        label: 'Save to Pedal',
        hint: !connected ? 'No pedal connected' : 'Store the preset',
        disabled: !connected,
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
        id: 'menu-copy-to',
        label: 'Copy to…',
        hint: connected ? 'Another User slot' : 'Open it first',
        disabled: empty,
        onSelect: () => void copyToSlot(kind, slot),
      },
      {
        id: 'menu-paste',
        label: 'Paste here',
        disabled:
          kind === 0 || !clipboard || (!clipboardDoc && !clipboardBlob),
        onSelect: () => pasteSlot(1, slot, 'paste'),
      },
      {
        id: 'menu-move',
        label: 'Move preset…',
        disabled: kind === 0,
        onSelect: () => {
          const dest = prompt(
            `Move preset to slot (e.g. ${slotLabel(slot)}, 01A…32D):`,
            slotLabel(slot),
          );
          if (dest === null) {
            return;
          }
          const target = parseSlotLabel(dest);
          if (target === null) {
            setSaveNotice({
              kind: 'error',
              text: `“${dest.trim()}” is not a slot. Use a label such as 01A, 12C or 32D.`,
            });
            return;
          }
          if (target === slot) {
            return;
          }
          moveSlot(slot, target);
        },
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
    if (!activePresetLoaded) {
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
      const applied = await applyPendingDrafts(connection);
      if (applied.models + applied.params > 0) {
        appendLog(
          `Save: ${applied.models} model(s) and ${applied.params} ` +
            `parameter(s) applied in RAM before storing User ${slotLabel(
              slot,
            )}.`,
        );
      }
      const result = await savePreset(connection, { slot, name }, reportProgress);
      appendLog(
        `Save accepted after ${result.attempts} attempt(s); frame ` +
          `${frameHex(result.frame)}.`,
      );
      setPendingParams({});
      setPendingModels({});
      setDirty(false);
      resetHistory();
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
   * One gate: the write button. No confirmation dialog.
   */
  async function writeRename(name: string) {
    const connection = connectionRef.current;
    if (!connection || actionBusy) {
      return;
    }
    if (!activePresetLoaded) {
      setActionError('Read the active preset from the pedal first.');
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
   * Copy the pedal's active preset into another User slot with operation 71.
   *
   * Operation 71 stores the pedal's current edit buffer under a destination
   * slot and name, so copying the preset the editor already has active needs
   * no body stream. Pending model/parameter drafts are applied first, exactly
   * like Save, so the copy matches what is on screen. The destination name is
   * read back afterwards; a mismatch is reported instead of assumed.
   *
   * The op-71 frame is taken from a POD Go Edit capture (writes.md §2.5). It
   * has not been validated from this build on hardware.
   */
  async function writeActivePresetToSlot(
    destSlot: number,
    name: string,
  ): Promise<void> {
    const connection = connectionRef.current;
    if (!connection || actionBusy) {
      return;
    }
    if (!activePresetLoaded) {
      setActionError('Read the active preset from the pedal before copying it.');
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }

    setActionError(null);
    setActionBusy(true);
    setUsbBusy('Copying the active preset…');
    appendLog(
      `Copy: storing the active preset as "${name}" in User ` +
        `${slotLabel(destSlot)} (operation 71)…`,
    );
    try {
      const applied = await applyPendingDrafts(connection);
      if (applied.models + applied.params > 0) {
        appendLog(
          `Copy: ${applied.models} model(s) and ${applied.params} ` +
            'parameter draft(s) applied before storing the destination.',
        );
      }
      const stored = await savePreset(
        connection,
        { slot: destSlot, name },
        reportProgress,
      );
      appendLog(
        `Copy: active preset stored at User ${slotLabel(destSlot)} after ` +
          `${stored.attempts} attempt(s); frame ${frameHex(stored.frame)}.`,
      );

      // The pedal owns this slot now; drop a stale browser draft for it.
      const key = localKey(1, destSlot);
      setLocalDocs((current) => {
        if (!(key in current)) {
          return current;
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
      clearSlotDirty(key);
      setFreshBackup(null);

      // Confirm the destination name; the body came from the edit buffer, so
      // the name is the only value op 71 lets us check directly.
      try {
        const list = await readSetlist(connection, 1, reportProgress);
        setSetlists((current) => ({ ...current, 1: list.entries }));
        const entry = list.entries[destSlot];
        if (entry?.name === name) {
          setSaveNotice({
            kind: 'info',
            text:
              `Copied the active preset to User ${slotLabel(destSlot)} as ` +
              `“${name}”. Recall that slot on the pedal to verify the sound.`,
          });
          appendLog(
            `Copy verified: User ${slotLabel(destSlot)} reads "${entry.name}".`,
          );
        } else {
          setSaveNotice({
            kind: 'error',
            text:
              `The pedal accepted the copy, but User ${slotLabel(destSlot)} ` +
              `reads “${entry?.name || 'empty'}”, expected “${name}”.`,
          });
          appendLog(
            `WARNING copy verification: User ${slotLabel(destSlot)} reads ` +
              `"${entry?.name ?? '—'}", expected "${name}".`,
          );
        }
      } catch (error) {
        appendLog(`WARNING copy verification failed: ${errorMessage(error)}`);
        setSaveNotice({
          kind: 'info',
          text:
            `The active preset was sent to User ${slotLabel(destSlot)} as ` +
            `“${name}”, but the setlist could not be re-read to verify it.`,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      setSaveNotice({ kind: 'error', text: `Copy failed: ${message}` });
      appendLog(`ERROR copy active preset: ${message}`);
      console.error('[POD Go] active-preset copy failed', error);
    } finally {
      setActionBusy(false);
      setUsbBusy(null);
    }
  }

  /**
   * Write a pedal-body blob to one User slot with operation 5.
   *
   * Shared by **Paste**, **Move** and **Copy to…**. The caller already has a
   * body (the clipboard, a slot read or the active preset); the gates are the
   * same: writing armed, one confirmation, then a read-back of the User
   * setlist. A one-entry `.pgbak` is built with the Rust core and replayed by
   * `RestoreFlow`, so the stream framing is exactly the tested restore path.
   * The slot is overwritten; there is no confirmation dialog after the
   * explicit write button.
   */
  async function writeBodyToSlot(
    destSlot: number,
    name: string,
    blob: Uint8Array,
    mode: PasteMode | 'copy',
    source?: { setlist: SetlistKind; slot: number; name: string },
  ): Promise<void> {
    const connection = connectionRef.current;
    if (!connection || actionBusy) {
      return;
    }
    const error = validatePresetName(name);
    if (error) {
      setActionError(error);
      return;
    }

    setActionError(null);
    setActionBusy(true);
    setUsbBusy('Writing preset…');
    appendLog(
      `Writing "${name}" to User ${slotLabel(destSlot)}` +
        (source
          ? ` from ${SETLIST_LABELS[source.setlist]} ${slotLabel(
              source.slot,
            )} ("${source.name || 'unnamed'}")`
          : ' from the clipboard') +
        ` (operation 5, ${blob.length} B)…`,
    );
    try {
      const builder = new BackupBuilder(
        structure?.product ?? '',
        structure?.firmware ?? '',
      );
      let bytes: Uint8Array;
      try {
        builder.add(1, destSlot, name, blob);
        bytes = builder.finish();
      } finally {
        builder.free();
      }

      // A read session may still be draining late replies. Give them a moment
      // to arrive (and drop them) before the op-5 preamble starts, like the
      // write-channel driver does.
      await connection.discard();
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await connection.discard();

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
      // The destination now holds the pedal's bytes, so any browser copy of
      // that slot is stale: drop it and let the pedal be the source again.
      const destKey = localKey(1, destSlot);
      setLocalDocs((current) => {
        if (!current[destKey]) {
          return current;
        }
        const next = { ...current };
        delete next[destKey];
        return next;
      });
      clearSlotDirty(destKey);
      setPending((current) =>
        current.filter((item) => item.key !== destKey),
      );
      if (!list.entries[destSlot]?.name) {
        // Operation 5 does not carry the name slot, so show the name the user
        // asked for instead of leaving the row empty.
        updateSetlistName(1, destSlot, name);
      }
      const entry = list.entries[destSlot];
      const nameOk = entry?.name === name;
      if (nameOk) {
        appendLog(`Preset write: User ${slotLabel(destSlot)} reads "${name}".`);
      } else {
        appendLog(
          `WARNING preset write: User ${slotLabel(destSlot)} reads "${
            entry?.name ?? '—'
          }", expected "${name}". The name may not travel with operation 5 ` +
            '(operation 9 is not sent by this build).',
        );
      }

      // A name match does not prove that the body changed. Read the
      // destination back and compare it byte for byte with what was sent, so
      // the page can say whether the copy actually landed.
      let bodyVerified: boolean | null = null;
      try {
        reportProgress(`Verifying the body at User ${slotLabel(destSlot)}…`);
        const written = await readPresetSlot(
          connection,
          1,
          destSlot,
          name,
          reportProgress,
        );
        bodyVerified = sameBytes(written.blob, blob);
        appendLog(
          bodyVerified
            ? `Preset write body verified: User ${slotLabel(
                destSlot,
              )} matches the source byte for byte.`
            : `WARNING preset write body: User ${slotLabel(
                destSlot,
              )} differs from the source (${written.blob.length} B written, ` +
                `${blob.length} B sent).`,
        );
      } catch (readError) {
        appendLog(
          `WARNING preset write body read-back failed: ${errorMessage(
            readError,
          )}`,
        );
      }

      if (bodyVerified === false) {
        setActionError(
          `The pedal accepted the stream, but User ${slotLabel(
            destSlot,
          )} does not read the source body. The slot may not have changed.`,
        );
        setSaveNotice({
          kind: 'error',
          text:
            `The pedal accepted the write, but User ${slotLabel(destSlot)} ` +
            'does not match the source body. Recall the slot and check it ' +
            'before relying on the copy.',
        });
      } else if (bodyVerified === true && nameOk) {
        setSaveNotice({
          kind: 'info',
          text:
            `Copied “${name}” to User ${slotLabel(destSlot)}. The destination ` +
            'body was read back and matches the source byte for byte.',
        });
      } else if (bodyVerified === true) {
        setSaveNotice({
          kind: 'info',
          text:
            `User ${slotLabel(destSlot)} now holds the copied body ` +
            `(verified byte for byte), but its name still reads “${
              entry?.name || 'empty'
            }”. Operation 9 is not sent by this build; recall the slot to ` +
            'verify the sound.',
        });
      } else {
        setSaveNotice({
          kind: 'info',
          text:
            `The preset was streamed to User ${slotLabel(
              destSlot,
            )}, but the destination body could not be read back. ` +
            'Recall the slot on the pedal to verify it.',
        });
      }

      if (mode === 'move' && source) {
        appendLog(
          `Move: the source ${SETLIST_LABELS[source.setlist]} ` +
            `${slotLabel(source.slot)} was not cleared on the pedal.`,
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

  /** Write the clipboard body to a User slot (Paste / Move paths). */
  async function writePaste(destSlot: number, name: string, mode: PasteMode) {
    if (!clipboard || !clipboardBlob) {
      setActionError('The clipboard is empty.');
      return;
    }
    await writeBodyToSlot(destSlot, name, clipboardBlob, mode, {
      setlist: clipboard.setlist,
      slot: clipboard.slot,
      name: clipboard.name,
    });
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
   * Read the requested slots (or both setlists) and download a `.pgbak`.
   *
   * The result becomes the session's fresh backup: restore stays disabled until
   * one exists.
   */
  async function backupToFile(
    targets: BackupTarget[] | null = null,
  ) {
    const connection = connectionRef.current;
    if (!connection || backupBusy || restoreBusy) {
      return;
    }
    const label = targets === null ? 'Full backup' : 'Selected backup';
    setUsbError(null);
    setBackupError(null);
    setRestoreError(null);
    setBackupBusy(true);
    setUsbBusy(`Starting the ${label.toLowerCase()}…`);
    appendLog(
      targets === null
        ? 'Full backup: reading both setlists and every non-empty slot…'
        : `Selected backup: reading ${targets.length} slot(s)…`,
    );
    try {
      const result =
        targets === null
          ? await createFullBackup(connection, reportProgress)
          : await createSelectedBackup(connection, targets, reportProgress);
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const file =
        targets === null
          ? `podgo-full-backup-${stamp}.pgbak`
          : `podgo-selected-backup-${stamp}.pgbak`;
      downloadBytes(result.bytes, file);
      setFreshBackup(result.summary);
      appendLog(
        `${label}: ${result.summary.entries.length} preset(s), ` +
          `${result.bytes.length} B, SHA-256 ${result.summary.digest}. ` +
          'Download started.',
      );
      if (result.skipped.length > 0) {
        appendLog(`${label}: ${result.skipped.length} empty slot(s) skipped.`);
      }
    } catch (error) {
      const message = errorMessage(error);
      setBackupError(message);
      setUsbError(message);
      appendLog(`ERROR ${label.toLowerCase()}: ${message}`);
      console.error('[POD Go] backup failed', error);
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
    : 'Changes reach the pedal as you make them. Press Save (Ctrl+S) to store the preset in its slot.';

  /**
   * Ctrl+S / Cmd+S saves the working copy, exactly like the header button:
   * only while a pedal is connected, the active preset is loaded and writing
   * is enabled. Otherwise it explains why, instead of writing.
   */
  const saveRef = useRef(saveWorkingPreset);
  saveRef.current = saveWorkingPreset;
  const saveBlockReason = !connected
    ? 'No POD Go connected. Export .pgp works offline.'
    : !activePresetLoaded
      ? 'Read the active preset from the pedal before saving.'
      : null;
  const saveBlockRef = useRef<string | null>(saveBlockReason);
  saveBlockRef.current = saveBlockReason;
  const undoRef = useRef(undoEdit);
  undoRef.current = undoEdit;
  const redoRef = useRef(redoEdit);
  redoRef.current = redoEdit;
  const copyBlockRef = useRef(copySelectedBlock);
  copyBlockRef.current = copySelectedBlock;
  const pasteBlockRef = useRef(pasteSelectedBlock);
  pasteBlockRef.current = pasteSelectedBlock;
  // Effects registered once read the state they closed over. Every action the
  // listener needs goes through a ref that this render refreshes.
  const saveNoticeRef = useRef(setSaveNotice);
  saveNoticeRef.current = setSaveNotice;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();

      // Text fields keep their native shortcuts (undo the typed text, paste
      // text, save the page). A focused slider or checkbox is not text entry,
      // so the editor shortcuts still work there.
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

      if (key === 's') {
        event.preventDefault();
        const reason = saveBlockRef.current;
        if (reason) {
          saveNoticeRef.current({ kind: 'info', text: reason });
          return;
        }
        void saveRef.current();
        return;
      }

      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          redoRef.current();
        } else {
          undoRef.current();
        }
        return;
      }

      if (key === 'y') {
        event.preventDefault();
        redoRef.current();
        return;
      }

      if (key === 'c') {
        // Leave a real text selection to the browser.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && selection.toString()) {
          return;
        }
        event.preventDefault();
        copyBlockRef.current();
        return;
      }

      if (key === 'v') {
        event.preventDefault();
        pasteBlockRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <main className="app">
      <header className="app-bar">
        <div className="brand">
          <div className="brand-title">
            <h1>
              POD Go <span>Editor</span>
            </h1>
            <ModuleBadge module={module} />
          </div>
          <p className="subtitle">
            Unofficial preset editor — Rust core in WebAssembly. Works offline;
            connect a pedal for live reads and writes.
          </p>
        </div>

        <div className="header-actions">
          <button
            id="toggle-presets"
            type="button"
            className="toolbar-button presets-toggle"
            aria-expanded={libraryOpen}
            aria-controls="preset-librarian"
            title="Show or hide the preset list"
            onClick={() => setLibraryOpen((open) => !open)}
          >
            Presets
          </button>
          <button
            id="connect"
            type="button"
            className="toolbar-button"
            disabled={
              busy || (!connected && (!moduleReady || !usbSupported))
            }
            data-connected={connected}
            title={
              connected
                ? 'Disconnect from this POD Go'
                : androidShell
                  ? 'Connect a POD Go over Android USB host'
                  : desktopShell
                    ? 'Connect a POD Go over desktop USB (libusb)'
                    : 'Connect a POD Go over WebUSB'
            }
            onClick={() => void (connected ? disconnect() : connect())}
          >
            {connected ? 'Disconnect' : 'Connect'}
            <span className="connect-dot" aria-hidden="true" />            
          </button>

          <button
            id="save-preset"
            type="button"
            className="toolbar-button is-primary"
            disabled={!moduleReady || writing}
            onClick={() => void saveWorkingPreset()}
            title={
              !connected
                ? 'Connect a POD Go to save. Export .pgp works offline.'
                : !activePresetLoaded
                  ? 'Read the active preset from the pedal first.'
                  : 'Store the preset in its slot (Ctrl+S)'
            }
          >
            Save
          </button>

          <button
            id="new-preset"
            type="button"
            className="toolbar-button"
            disabled={!moduleReady || busy}
            onClick={() => void startNewPreset()}
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
        // <p id="offline-notice" className="notice is-offline" role="status">
        //   <strong>No POD Go connected.</strong> Factory names and one default
        //   User preset are loaded so you can edit and export offline. Saving
        //   needs the pedal; <strong>Export .pgp</strong> always works.
        // </p>
        <p id="offline-notice" className="notice is-offline" role="status">
          <strong>No POD Go connected.</strong> Export always works.
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
        {libraryOpen && (
          <button
            type="button"
            className="librarian-scrim"
            aria-label="Close preset list"
            onClick={() => setLibraryOpen(false)}
          />
        )}
        <PresetList
          setlists={setlists}
          activeSetlist={activeSetlist}
          loadedSetlist={loaded?.setlist ?? null}
          loadedSlot={loaded?.slot ?? null}
          canRead={connected && !busy}
          onSetlist={setActiveSetlist}
          onOpenSlot={(setlist, entry) => {
            setLibraryOpen(false);
            openSlot(setlist, entry);
          }}
          onContextMenu={openPresetMenu}
          onMoveSlot={moveSlot}
          browserSlots={browserSlots}
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
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
              onSelectModel={changeModel}
              onSelectionChange={handleSelectionChange}
              canUndo={historyDepth.past > 0}
              canRedo={historyDepth.future > 0}
              onUndo={undoEdit}
              onRedo={redoEdit}
              onEditCopy={
                workingDoc
                  ? undefined
                  : () => {
                      if (createEditableCopy()) {
                        resetHistory();
                      }
                    }
              }
              onMoveBlock={workingDoc || connected ? moveBlock : undefined}
              onSelectSnapshot={selectSnapshot}
              onRenameSnapshot={renameSnapshot}
              onSetSnapshotLedColor={setSnapshotLedColor}
              onToggleSnapshotParam={
                workingDoc ? toggleSnapshotParam : undefined
              }
              onSetBlockEnabled={setBlockEnabled}
              canSetBlockEnabled={connected}
              onRemoveBlock={
                !workingDoc && connected
                  ? (block) => void removeActiveBlock(block)
                  : undefined
              }
              onPresetMenu={
                currentPresetTarget() ? openCurrentPresetMenu : undefined
              }
              onCopyBlock={copyBlockAt}
              onPasteBlock={pasteBlockAt}
              canPasteBlock={blockClipboard !== null}
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
              <h2>
                POD Go connection (
                {androidShell
                  ? 'Android USB host'
                  : desktopShell
                    ? 'Desktop USB (libusb)'
                    : 'WebUSB'})
              </h2>
              <p className="hint">
                {androidShell
                  ? 'USB host within the Android app. Reads are always available; each pedal write is confirmed.'
                  : desktopShell
                    ? 'Native libusb inside the desktop app. Reads are always available; each pedal write is confirmed.'
                    : 'Chrome or Edge, page served on 127.0.0.1. Reads are always available; each pedal write is confirmed.'}
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
              WebUSB is not available, and this page runs outside the Android
              and desktop apps. File reports remain usable offline; Firefox and
              Safari cannot open the device.
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
              disabled={!connected || !activePresetLoaded || busy}
              onClick={openSaveDialog}
              title="Store the active preset in a User slot (metadata only)"
            >
              Save active preset to slot…
            </button>
          </div>

          {deviceInfo && (
            <p className="device-info">
              {describeDevice(deviceInfo)} ·{' '}
              {'live editing'}
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
          items={menuItems((contextMenu.kind ?? 0) as SetlistKind, contextMenu.slot ?? 0)}
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
        writeArmed={connected}
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
        onCreateBackup={(targets) => void backupToFile(targets)}
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
        writeArmed={connected}
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
