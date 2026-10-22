// Invidora backup: a consistent copy of the database plus the media files it uses, with a checksum manifest.
//
//   node scripts/backup.js [--data <data dir>] [--out <new folder>]
//
// - Safe while the server is running: the database is copied with SQLite's online backup API (WAL-consistent).
// - Never changes the data folder. Refuses to write into a folder that already exists.
// - Copies only the media the database refers to (videos, thumbnails, profile photos); unfinished uploads are skipped.
// - Does NOT copy secrets: data/admin-key.txt, data/vapid.json (push key) and .env are left out on purpose (keep them in
//   your password manager). Without the old push key, devices simply turn push notifications on again.
// - Check a backup with:  node scripts/restore.js --verify <backup folder>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const DATA = path.resolve(arg('data', process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'backups', 'invidora-' + stamp)));
const DIRS = ['uploads', 'thumbs', 'avatars'];

const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', rej).on('data', c => h.update(c)).on('end', () => res(h.digest('hex')));
});
const die = msg => { console.error('Backup failed: ' + msg); process.exit(1); };

(async () => {
  const dbFile = path.join(DATA, 'invidora.db');
  if (!fs.existsSync(dbFile)) die(`no database at ${dbFile}`);
  if (fs.existsSync(OUT)) die(`${OUT} already exists. Pick a new folder; backups are never overwritten.`);
  if ((OUT + path.sep).startsWith(DATA + path.sep)) die('the backup folder must not be inside the data folder.');
  const TMP = OUT + '.partial-' + process.pid;
  fs.mkdirSync(TMP, { recursive: true });
  try {
    // 1. Database snapshot (online backup API: consistent even while the app writes)
    const src = new DatabaseSync(dbFile, { readOnly: true });
    await backup(src, path.join(TMP, 'invidora.db'));
    src.close();
    const snap = new DatabaseSync(path.join(TMP, 'invidora.db'));
    const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error('the database copy failed its integrity check: ' + integrity);
    snap.exec('PRAGMA journal_mode=DELETE'); // a single self-contained file
    const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const counts = Object.fromEntries(tables.map(t => [t, snap.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
    // 2. Media the snapshot refers to
    const want = {
      uploads: snap.prepare('SELECT file f FROM videos WHERE file IS NOT NULL').all(),
      thumbs: snap.prepare('SELECT thumb f FROM videos WHERE thumb IS NOT NULL').all(),
      avatars: snap.prepare('SELECT avatar f FROM users WHERE avatar IS NOT NULL').all(),
    };
    snap.close();
    const files = [], missing = [];
    for (const d of DIRS) {
      fs.mkdirSync(path.join(TMP, d));
      for (const { f } of want[d]) {
        if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(f)) { missing.push(`${d}/${f} (unexpected name, skipped)`); continue; }
        const from = path.join(DATA, d, f);
        if (!fs.existsSync(from)) { missing.push(`${d}/${f}`); continue; }
        fs.copyFileSync(from, path.join(TMP, d, f), fs.constants.COPYFILE_EXCL);
        files.push({ path: `${d}/${f}`, size: fs.statSync(path.join(TMP, d, f)).size, sha256: await sha256(path.join(TMP, d, f)) });
      }
    }
    // 3. Manifest with checksums
    const manifest = {
      app: 'invidora', format: 1, created: new Date().toISOString(), node: process.version,
      database: { path: 'invidora.db', size: fs.statSync(path.join(TMP, 'invidora.db')).size, sha256: await sha256(path.join(TMP, 'invidora.db')), integrity, counts },
      files, missing,
      notes: 'Secrets are not included (admin-key.txt, vapid.json, .env). Restore with: node scripts/restore.js --from <this folder> --to <new data folder>',
    };
    fs.writeFileSync(path.join(TMP, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(TMP, OUT);
    const bytes = files.reduce((s, f) => s + f.size, manifest.database.size);
    console.log(`Backup written to ${OUT}`);
    console.log(`  database: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
    console.log(`  media files: ${files.length} (${(bytes / 1048576).toFixed(1)} MB in total)`);
    if (missing.length) console.log(`  warning: ${missing.length} file(s) the database refers to were not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  } catch (e) {
    fs.rmSync(TMP, { recursive: true, force: true }); // only our own unfinished folder
    die(e.message);
  }
})();
