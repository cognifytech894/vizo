// Invidora restore: checks a backup made by scripts/backup.js and copies it into a NEW, empty data folder.
//
//   node scripts/restore.js --verify <backup folder>                     (check only, writes nothing)
//   node scripts/restore.js --from <backup folder> --to <new data folder>
//
// - Never overwrites anything: the target folder must not exist yet, and it can't be the live data folder.
// - Checks every file against the manifest checksums and runs SQLite's integrity check before and after copying.
// - To switch the app to the restored data, stop the server and start it with DATA_DIR=<new data folder>
//   (and the same ADMIN_KEY as before, or a new one). Keep the old folder until you have checked the app.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const die = msg => { console.error('Restore failed: ' + msg); process.exit(1); };
const sha256 = file => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', rej).on('data', c => h.update(c)).on('end', () => res(h.digest('hex')));
});
const NAME = /^(uploads|thumbs|avatars)\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/;

async function verify(dir) {
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('no manifest.json in ' + dir);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  if (m.app !== 'invidora' || m.format !== 1) throw new Error('this is not an Invidora backup (format 1)');
  const dbf = path.join(dir, 'invidora.db');
  if (!fs.existsSync(dbf) || (await sha256(dbf)) !== m.database.sha256) throw new Error('the database file is missing or its checksum does not match');
  const db = new DatabaseSync(dbf, { readOnly: true });
  const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const refs = [
    ...db.prepare('SELECT file f FROM videos WHERE file IS NOT NULL').all().map(r => 'uploads/' + r.f),
    ...db.prepare('SELECT thumb f FROM videos WHERE thumb IS NOT NULL').all().map(r => 'thumbs/' + r.f),
    ...db.prepare('SELECT avatar f FROM users WHERE avatar IS NOT NULL').all().map(r => 'avatars/' + r.f),
  ];
  db.close();
  if (ok !== 'ok') throw new Error('the database failed its integrity check: ' + ok);
  for (const f of m.files) {
    if (!NAME.test(f.path)) throw new Error('unexpected file name in the manifest: ' + f.path);
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) throw new Error('missing file: ' + f.path);
    if ((await sha256(p)) !== f.sha256) throw new Error('checksum does not match: ' + f.path);
  }
  const listed = new Set(m.files.map(f => f.path));
  const notInBackup = refs.filter(r => !listed.has(r));
  return { m, refs, notInBackup };
}

(async () => {
  try {
    const only = arg('verify');
    if (only) {
      const { m, notInBackup } = await verify(path.resolve(only));
      console.log(`Backup OK: database (integrity ok, checksum ok) and ${m.files.length} media files (checksums ok). Made ${m.created}.`);
      if (notInBackup.length) console.log(`  note: ${notInBackup.length} file(s) the database refers to were already missing when the backup was made`);
      return;
    }
    const from = arg('from'), to = arg('to');
    if (!from || !to) die('usage: node scripts/restore.js --from <backup folder> --to <new data folder>   (or --verify <backup folder>)');
    const FROM = path.resolve(from), TO = path.resolve(to);
    const live = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
    if (TO === live || (TO + path.sep).startsWith(live + path.sep) || (live + path.sep).startsWith(TO + path.sep)) die('the target must be a new folder outside the live data folder.');
    if (fs.existsSync(TO)) die(`${TO} already exists. Restore only goes into a new, empty folder.`);
    const { m, notInBackup } = await verify(FROM);
    const TMP = TO + '.partial-' + process.pid;
    fs.mkdirSync(TMP, { recursive: true });
    try {
      fs.copyFileSync(path.join(FROM, 'invidora.db'), path.join(TMP, 'invidora.db'), fs.constants.COPYFILE_EXCL);
      for (const d of ['uploads', 'thumbs', 'avatars']) fs.mkdirSync(path.join(TMP, d));
      for (const f of m.files) fs.copyFileSync(path.join(FROM, f.path), path.join(TMP, f.path), fs.constants.COPYFILE_EXCL);
      const db = new DatabaseSync(path.join(TMP, 'invidora.db'));
      const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
      const counts = Object.fromEntries(Object.keys(m.database.counts).map(t => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n]));
      db.close();
      if (ok !== 'ok') throw new Error('the restored database failed its integrity check');
      for (const [t, n] of Object.entries(m.database.counts)) if (counts[t] !== n) throw new Error(`row count differs for ${t}: ${counts[t]} vs ${n}`);
      fs.renameSync(TMP, TO);
    } catch (e) { fs.rmSync(TMP, { recursive: true, force: true }); throw e; }
    console.log(`Restored into ${TO}: database (integrity ok, row counts match) and ${m.files.length} media files.`);
    if (notInBackup.length) console.log(`  note: ${notInBackup.length} file(s) were already missing when the backup was made`);
    console.log('  The admin key is not part of a backup: set ADMIN_KEY, or the server makes a new one in the new folder.');
    console.log(`  Next: stop the server, then start it with DATA_DIR=${TO}`);
  } catch (e) { die(e.message); }
})();
