# Legal and ethical notes

## 1. Position

This project performs **interoperability-oriented** analysis only. It exists so
that owners of a POD Go can use their own hardware on platforms the official
editor does not support, and so that presets remain portable.

The project is **unofficial** and is **not affiliated with, endorsed by, or
supported by** Line 6 or Yamaha Guitar Group.

## 2. What was done

- Static inspection of publicly installed application binaries for file type,
  architecture, imported libraries, human-readable strings, resource formats and
  protocol identifiers.
- Reading an existing MIT-licensed community project as a behavioural reference.
- Analysis of legally obtained sample presets and fixtures already present in
  that project.
- No live device interaction in Phase 1.

## 3. What was not done, and will not be done

- No circumvention of licensing, authentication, copy protection, DRM or access
  controls.
- No extraction of firmware, encryption keys, credentials or private user data.
- No redistribution of the official installers, applications, resources,
  manuals, fonts, images or firmware.
- No inclusion of decompiled proprietary code in the repository.
- No use of Line 6/Yamaha trademarks in a way that implies endorsement.
- No reverse engineering of the update/authentication path beyond identifying
  that it exists.

The `AuthenticationManager` and `L6UpdateEngine` strings observed in the macOS
binary are recorded as **architecture facts only**; their internals were not
inspected and will not be bypassed.

## 4. Clean-room process

1. Observe behaviour and record message structure (this documentation).
2. Write an implementation specification independent of source code.
3. Implement original code from the specification.
4. Validate with user-owned hardware and legally obtained presets.

Contributors who have seen proprietary source must not contribute to the
corresponding module. Reviews should confirm that code derives from the
specification, not from decompilation.

## 5. Copyright and trademarks

- "Line 6", "POD Go", "POD Go Edit", "Helix" and related marks belong to their
  owners. They are used descriptively (nominative fair use) to describe
  interoperability.
- The project name and UI must not imitate official branding, logos or trade
  dress.
- Protocol facts (message layouts, identifiers) are functional and are recorded
  as facts, not copied creative expression.

## 6. Data handling

- Fixtures may contain user-created preset names. Before publishing a fixture,
  confirm it contains no personal data and that redistribution is permitted.
- Device serial numbers are treated as personal data and are redacted from logs.
- No telemetry, analytics or network calls are made by default.

## 7. Distribution

- The repository ships **source code and documentation only**.
- Users must obtain the official editor and their own presets lawfully if they
  want to compare behaviour.
- Platform packages must not bundle proprietary libraries beyond what their
  licenses permit. `libusb` is LGPL-2.1 and may be dynamically linked; its
  license and attribution must be included.

## 8. Firmware and device safety

- Firmware update functionality is out of scope.
- Destructive writes require a verified backup, explicit confirmation and a
  restoration procedure.
- The first public milestone is read-only.

## 9. Jurisdiction and responsibility

Laws on reverse engineering and interoperability vary. Contributors are
responsible for complying with local law. If you are unsure, contribute
documentation and tests rather than code derived from protected material.

## 10. Reporting concerns

If any contribution appears to violate this policy, open a private security
advisory or contact the maintainers. Such material will be removed promptly.
