#!/usr/bin/env node
// Print the release notes for the changelog's first non-empty section.
//
// The release workflow runs this after a tag is pushed. Notes live under
// `## [Unreleased]` while a build is in progress; once a release is cut they
// move to `## [x.y.z] - date` and a fresh empty Unreleased section stays on
// top. Printed in both cases, so a tag can never publish empty notes.
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'CHANGELOG.md';
const lines = readFileSync(path, 'utf8').split('\n');

const sections = [];
let current = null;
for (const line of lines) {
  const header = /^## \[([^\]]+)\]/.exec(line);
  if (header) {
    if (current) {
      sections.push(current);
    }
    current = { name: header[1], body: [] };
    continue;
  }
  if (current) {
    current.body.push(line);
  }
}
if (current) {
  sections.push(current);
}

const section = sections.find((item) => item.body.join('\n').trim());
if (!section) {
  console.error(`no release notes found in ${path}`);
  process.exit(1);
}
process.stdout.write(`${section.body.join('\n').trim()}\n`);
