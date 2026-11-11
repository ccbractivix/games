'use strict';

// The source dataset is CC0: https://github.com/unitedstates/congress-legislators
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('yaml');

async function main() {
  const response = await fetch('https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml');
  if (!response.ok) throw new Error(`Congress roster download failed: ${response.status}`);
  const members = parse(await response.text());
  if (!Array.isArray(members) || members.length < 500) throw new Error('Congress roster is unexpectedly incomplete.');
  const names = new Set();
  for (const member of members) {
    const { first, last, official_full: full, nickname } = member.name;
    if (!first || !last) throw new Error('Congress roster contains an incomplete name.');
    names.add(`${first} ${last}`);
    if (full) names.add(full);
    if (nickname) names.add(`${nickname} ${last}`);
  }
  const data = {
    source: 'https://github.com/unitedstates/congress-legislators',
    license: 'CC0-1.0',
    updated: new Date().toISOString().slice(0, 10),
    names: [...names].sort(),
  };
  await fs.writeFile(path.join(__dirname, '../lib/political-names.json'), `${JSON.stringify(data, null, 2)}\n`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
