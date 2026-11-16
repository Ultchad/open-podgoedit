# Preset management

> **Implementation status:** browsing and read-only preset loading are
> available in the web app. Editing, dirty state, copy/paste and
> synchronization are planned; writing is disabled in this milestone.

## 1. Browsing

- **Factory** and **User** setlists each contain 128 slots.
- A slot is the position in the setlist (program change number).
- An index is the stable preset id; the two differ after reordering.
- The browser shows slot and name; dirty state is planned.

## 2. Reading from the device

1. Connect and wait for **WASM ready** and an open device.
2. Read the Factory or User setlist; the app streams all 128 entries.
3. Click a preset in the librarian to open its full chain over WebUSB.
4. The click reads that slot's body; it does not recall the preset on the
   pedal. **Read active preset** remains the way to see what the pedal plays.

## 3. Editing offline

- Edits apply to a local copy first.
- The chain view lets you enable/disable and reorder blocks where supported.
- Parameter edits validate against the model definition's min/max.
- Undo/redo is local and unlimited within the session (bounded by memory).

## 4. Dirty state

A preset is **dirty** when local changes differ from the last read/saved
version. The app never marks a preset clean without a successful save or an
explicit discard.

## 5. Copy, paste, duplicate, move, delete

- Duplicate creates a new local preset with a new id.
- Move changes slot order locally; synchronization is a separate, explicit step.
- Delete requires confirmation and is undoable until the app closes.

## 6. Comparing presets

The compare view shows only meaningful differences: model, enabled state,
parameter values, controller assignments and snapshots. Unknown fields are
listed as opaque differences, not hidden.

## 7. Synchronization

- **Device → app:** changes made on the pedal appear as events; the active
  preset refreshes.
- **App → device:** requires an explicit **Apply** action, a backup and
  confirmation.
- Conflicts (same field changed on both sides) prompt the user.

## 8. Safety rules

- Always export a backup before applying changes.
- Writing is disabled in the read-only milestone.
- Object-14 integrity is not yet understood; the app verifies by re-reading,
  not by recomputing a checksum.

## 9. Keyboard

| Action | Shortcut (planned) |
|---|---|
| Undo | Ctrl/Cmd+Z |
| Redo | Ctrl/Cmd+Shift+Z |
| Save | Ctrl/Cmd+S |
| Duplicate | Ctrl/Cmd+D |
| Delete | Delete |
| Next preset | ↓ |
| Previous preset | ↑ |
