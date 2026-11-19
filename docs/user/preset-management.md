# Preset management

> **Implementation status:** browsing, editing, bounded undo/redo, effect
> copy/paste and offline export are implemented. Pedal writes are opt-in and
> some paths remain unvalidated on hardware; see `docs/protocol/writes.md`.

## 1. Browsing

- **Factory** and **User** setlists each contain 128 slots.
- A slot is the position in the setlist (program change number).
- An index is the stable preset id; the two differ after reordering.
- The browser shows slot and name; dirty state is planned.
- On a phone the librarian is an off-canvas drawer: **Presets** in the header
  opens it, and picking a slot closes it.
- Right-click a block or a preset row for its actions menu. On touch, use a
  long-press; the inspector's **⋯** button opens the same effect menu.

## 2. Reading from the device

1. Connect and wait for **WASM ready** and an open device.
2. Read the Factory or User setlist; the app streams all 128 entries.
3. Click a preset in the librarian to open its full chain over WebUSB.
4. The click reads that slot's body; it does not recall the preset on the
   pedal. **Read active preset** remains the way to see what the pedal plays.

## 3. Editing offline

- Edits apply to a local copy first.
- A preset read from the pedal is edited as a pedal draft: a model change or a
  parameter change shows immediately and is applied by **Save** (op 40 for
  models, op 30 for parameters, then op 71 to store the preset).
- **Edit copy** builds an editable offline copy instead. The copy exports as
  `.pgp`; this build cannot write a preset body back to the pedal.
- The chain view lets you enable/disable and reorder blocks where supported.
- Parameter edits validate against the model definition's min/max.
- Undo/redo is local to the tab and keeps the **last 50 edits** for the loaded
  preset. `Ctrl/Cmd+Z` undoes, `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redoes; the
  two arrows next to the tempo do the same. The history is cleared when another
  preset is opened, after a successful **Save** or **Export**, and when
  **Edit copy** creates a new document. It is not persisted across reloads.

## 4. Dirty state

A preset is **dirty** when local changes differ from the last read/saved
version. The app never marks a preset clean without a successful save or an
explicit discard.

## 5. Copy, paste, duplicate, move, delete

- **Copy an effect between presets:** select an amp or effect block, press
  `Ctrl/Cmd+C`, open another preset, select the destination slot and press
  `Ctrl/Cmd+V`. The in-tab effect clipboard carries the model and its parameter
  values; bypass and snapshot assignments stay with the destination block. On
  the active pedal preset, **Save** sends operation 40 and the copied parameter
  drafts (op 30); on an offline copy it edits the JSON document. Input, Output
  and empty slots cannot be the source, and the usual single-role rules
  (one Amp, Cab, Wah, … per preset) still apply.
- The **preset** clipboard (right-click **Copy** / **Paste**) is separate: it
  moves whole slots in the librarian, not blocks inside a preset.
- Duplicate creates a new local preset with a new id.
- Move changes slot order locally; synchronization is a separate, explicit step.
- Delete is not implemented: there is no evidenced delete-slot operation in
  this build.

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

Implemented in the web app:

| Action | Shortcut |
|---|---|
| Undo | `Ctrl/Cmd+Z` |
| Redo | `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` |
| Save | `Ctrl/Cmd+S` |
| Copy the selected effect | `Ctrl/Cmd+C` |
| Paste the copied effect | `Ctrl/Cmd+V` |

These shortcuts are ignored while a text field has focus, so typing and native
text editing keep working. Planned but not implemented: duplicate (`Ctrl/Cmd+D`),
delete (`Delete`), next/previous preset (`↓` / `↑`).
