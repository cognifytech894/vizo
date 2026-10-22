// Invidora server: accounts, video upload, feed, likes, comments, follows, views, reports, admin.
// No npm packages needed (Node 22.13+).
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { probeVideo, imageType, Bad } = require('./lib/media.js');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';
const PORT = process.env.PORT || 4000;
const PROD = process.env.NODE_ENV === 'production';
// Accounts are required to upload, follow and report, so production must not start without login set up
if (PROD && !(SB_URL && SB_KEY)) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in production. Refusing to start.');
  process.exit(1);
}
const PUB = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIRS = { uploads: path.join(DATA, 'uploads'), avatars: path.join(DATA, 'avatars'), thumbs: path.join(DATA, 'thumbs') };
const MAX = 100 * 1024 * 1024; // 100 MB video
const MAX_SEC = 60; // longest video, checked on the server from the file itself (1 s of slack for rounding)
// Which new uploads wait for an admin before anyone else can see them:
//   all (default)  every upload. The browser's safety check can't be trusted by the server (a modified app can claim
//                  it passed), so a person approves each video. The check's result is shown to the admin as a hint.
//   unscanned      only uploads whose browser check did not pass. This TRUSTS THE CLIENT; for local testing, or if you
//                  accept that risk.
const UPLOAD_REVIEW = process.env.UPLOAD_REVIEW === 'unscanned' ? 'unscanned' : 'all';
const AVMAX = 2 * 1024 * 1024; // 2 MB profile photo
const THMAX = 1024 * 1024; // 1 MB thumbnail
// Storage: each account may keep this much video, and uploads stop while the disk has less than MIN_FREE left
const QUOTA = (Number(process.env.UPLOAD_QUOTA_MB) || 2048) * 1048576;
const MIN_FREE = (Number(process.env.MIN_FREE_MB) || 1024) * 1048576;
const MOODS = ['Comedy', 'Energy', 'Learning', 'Food', 'Travel'];
const FILTERS = ['none', 'warm', 'cool', 'bw', 'vintage', 'vivid'];
const REASONS = ['Spam', 'Nudity or sexual content', 'Violence or danger', 'Hate or harassment', 'Copyright', 'Other'];
const EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v', 'video/3gpp': '.3gp' };
const IMG = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
// Unfinished uploads from a previous run (a crash or restart mid-upload) are never served; clear them
for (const d of Object.values(DIRS)) for (const f of fs.readdirSync(d)) if (f.startsWith('.tmp-')) fs.rmSync(path.join(d, f), { force: true });

// Admin key: from ADMIN_KEY env, else generated once and kept in data/admin-key.txt
const KEYFILE = path.join(DATA, 'admin-key.txt');
let ADMIN_KEY = process.env.ADMIN_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, 'utf8').trim() : '');
if (!ADMIN_KEY) { ADMIN_KEY = crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(KEYFILE, ADMIN_KEY + '\n'); }

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA, 'invidora.db'));
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, handle TEXT NOT NULL, owner TEXT,
  mood TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', emoji TEXT NOT NULL DEFAULT '🎬',
  file TEXT, mime TEXT, likes INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS likes(video INTEGER NOT NULL, uid TEXT NOT NULL, PRIMARY KEY(video, uid));
CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY, avatar TEXT);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY AUTOINCREMENT, video INTEGER NOT NULL, uid TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS comments_video ON comments(video);
CREATE TABLE IF NOT EXISTS follows(follower TEXT NOT NULL, followee TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(follower, followee));
CREATE TABLE IF NOT EXISTS views(video INTEGER NOT NULL, uid TEXT NOT NULL, PRIMARY KEY(video, uid));
CREATE TABLE IF NOT EXISTS reports(video INTEGER NOT NULL, uid TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(video, uid));`);
const addCol = (t, c, def) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
};
addCol('users', 'name', 'TEXT');
addCol('users', 'bio', "TEXT NOT NULL DEFAULT ''");
addCol('users', 'created', 'INTEGER NOT NULL DEFAULT 0');
addCol('videos', 'thumb', 'TEXT');
addCol('videos', 'filter', "TEXT NOT NULL DEFAULT 'none'");
addCol('videos', 'views', 'INTEGER NOT NULL DEFAULT 0');
addCol('likes', 'created', 'INTEGER'); // likes made before this column existed have no time and are left out of notifications
addCol('users', 'seen', 'INTEGER NOT NULL DEFAULT 0'); // when the user last opened Notifications
addCol('comments', 'edited', 'INTEGER'); // time of the last edit, if any
addCol('users', 'fullname', "TEXT NOT NULL DEFAULT ''"); // display name; unlike the username it does not have to be unique
addCol('users', 'links', "TEXT NOT NULL DEFAULT '{}'"); // social links, JSON { instagram, youtube, x, facebook, website }
addCol('videos', 'description', "TEXT NOT NULL DEFAULT ''"); // shown pinned above the comments
addCol('views', 'created', 'INTEGER'); // views made before this column existed have no time
// Waiting for a safety review: uploaded without a passed safety check, so hidden until an admin approves it
addCol('videos', 'pending', 'INTEGER NOT NULL DEFAULT 0');
addCol('videos', 'scan', 'TEXT'); // what the uploader's browser reported about its safety check ('passed' / 'unchecked'); a hint only
// Reports no longer hide videos by themselves; an admin decides. Videos the old rule (5+ reports) had hidden stay hidden.
if (!db.prepare('PRAGMA table_info(videos)').all().some(x => x.name === 'hidden')) {
  db.exec('ALTER TABLE videos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE videos SET hidden=1 WHERE id IN (SELECT video FROM reports GROUP BY video HAVING COUNT(*) >= 5)');
}
addCol('videos', 'size', 'INTEGER'); // bytes on disk, for the per-account storage quota (older uploads: unknown)
// Phase 3 (all additive and safe to run again): comment switch, blocks, comment reports, notification settings, watch history
addCol('videos', 'comments_off', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS blocks(blocker TEXT NOT NULL, blocked TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(blocker, blocked), CHECK(blocker <> blocked));
CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked);
CREATE TABLE IF NOT EXISTS comment_reports(comment INTEGER NOT NULL, uid TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(comment, uid));
CREATE TABLE IF NOT EXISTS notif_prefs(uid TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(uid, type));
CREATE TABLE IF NOT EXISTS notif_mutes(uid TEXT NOT NULL, type TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER);
CREATE INDEX IF NOT EXISTS notif_mutes_uid ON notif_mutes(uid, type);
CREATE TABLE IF NOT EXISTS watch_history(uid TEXT NOT NULL, video INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0, duration REAL, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(uid, video));
CREATE INDEX IF NOT EXISTS watch_history_last ON watch_history(uid, last_at DESC);`);
// One-time data changes run once each (recorded in schema_migrations), inside a transaction
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied INTEGER NOT NULL)');
function migrate(name, fn) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) return;
  db.exec('BEGIN');
  try { fn(); db.prepare('INSERT INTO schema_migrations(name, applied) VALUES(?,?)').run(name, Date.now()); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// "Mute notifications" is now its own setting (type 'all'), so Unmute brings back each person's own choices.
// The old Mute button switched every type off; those accounts become muted with their types on again, which shows
// exactly the same (nothing new) until they unmute, and then everything, as the old Unmute did.
migrate('2026-10-18-global-mute', () => {
  const now = Date.now(), types = ['follow', 'comment', 'like', 'upload'];
  const all = db.prepare(`SELECT uid FROM notif_prefs WHERE type IN (${types.map(() => '?').join(',')}) AND enabled=0 GROUP BY uid HAVING COUNT(*)=4`).all(...types);
  for (const { uid } of all) {
    if (db.prepare("SELECT 1 FROM notif_prefs WHERE uid=? AND type='all'").get(uid)) continue;
    db.prepare("UPDATE notif_mutes SET stop=? WHERE uid=? AND type<>'all' AND stop IS NULL").run(now, uid);
    db.prepare("UPDATE notif_prefs SET enabled=1, updated=? WHERE uid=? AND type<>'all'").run(now, uid);
    db.prepare("INSERT INTO notif_prefs(uid,type,enabled,updated) VALUES(?,'all',0,?)").run(uid, now);
    db.prepare("INSERT INTO notif_mutes(uid,type,start,stop) VALUES(?,'all',?,NULL)").run(uid, now);
  }
});
db.exec('CREATE TABLE IF NOT EXISTS comment_likes(comment INTEGER NOT NULL, uid TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(comment, uid))');
// Replies: one level only (a reply's parent is always a top-level comment of the same video). Pin: one top-level comment per video.
addCol('comments', 'parent', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent)');
addCol('videos', 'pinned', 'INTEGER');
// Analytics: watch time and completion, recorded from this release on (nothing earlier exists, nothing is made up).
// One row per video, viewer and clock hour; viewer = account id, or for guests the same keyed network hash as views.
addCol('videos', 'duration', 'REAL'); // real length from the server's own file check (uploads from now on)
db.exec(`CREATE TABLE IF NOT EXISTS watch(video INTEGER NOT NULL, viewer TEXT NOT NULL, hour INTEGER NOT NULL, at INTEGER NOT NULL,
  last_at INTEGER NOT NULL, seconds REAL NOT NULL DEFAULT 0, max_pos REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(video, viewer, hour));
CREATE INDEX IF NOT EXISTS watch_video_at ON watch(video, at);
CREATE INDEX IF NOT EXISTS views_video_created ON views(video, created);
CREATE INDEX IF NOT EXISTS likes_video_created ON likes(video, created);
CREATE INDEX IF NOT EXISTS comments_video_created ON comments(video, created);
CREATE INDEX IF NOT EXISTS follows_followee_created ON follows(followee, created);
CREATE INDEX IF NOT EXISTS videos_owner_created ON videos(owner, created);`);
migrate('2026-10-19-watch-tracking', () => {}); // its applied time = when watch-time collection started
const TRACKING_SINCE = db.prepare("SELECT applied FROM schema_migrations WHERE name='2026-10-19-watch-tracking'").get().applied;
// Collaborations: one row per invited creator per video (see "collaborations" below)
db.exec(`CREATE TABLE IF NOT EXISTS collabs(video INTEGER NOT NULL, uid TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')), invited INTEGER NOT NULL, responded INTEGER,
  PRIMARY KEY(video, uid));
CREATE INDEX IF NOT EXISTS collabs_uid ON collabs(uid, status);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_name ON users(name COLLATE NOCASE)');
// Every video gets a short public link id, like YouTube: /v/aB3dE9xKq2Z
addCol('videos', 'slug', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS videos_slug ON videos(slug)');
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const slugTaken = db.prepare('SELECT 1 FROM videos WHERE slug=?');
function newSlug() {
  for (;;) {
    const s = [...crypto.randomBytes(11)].map(b => B62[b % 62]).join('');
    if (!slugTaken.get(s)) return s;
  }
}
const fillSlugs = () => {
  for (const { id } of db.prepare('SELECT id FROM videos WHERE slug IS NULL').all())
    db.prepare('UPDATE videos SET slug=? WHERE id=?').run(newSlug(), id);
};
fillSlugs();

// ---------- helpers ----------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (status, error) => Object.assign(new Error(error), { status });
const text = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const cleanName = s => String(s || '').replace(/^@/, '').replace(/[^\p{L}\p{M}\p{N}_.]/gu, '').slice(0, 24);
const parseTags = s => [...new Set(String(Array.isArray(s) ? s.join(' ') : s || '').split(/[\s,#]+/)
  .map(t => t.replace(/[^\p{L}\p{M}\p{N}_]/gu, '').toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 5);
const need = uid => { if (!uid) throw fail(400, 'Please refresh the page and try again.'); };
// Account-only actions. Fails closed: without login set up on the server, nobody can do them.
const needAccount = (uid, what) => {
  if (!SB_URL || !SB_KEY) throw fail(503, 'Accounts are not set up on this server.');
  if (!uid || !uid.startsWith('sb_')) throw Object.assign(fail(401, `Please log in to ${what}.`), { login: true });
};
// Uploading and reporting also need a confirmed email address
const needVerified = (uid, verified, what) => {
  needAccount(uid, what);
  if (!verified) throw fail(403, 'Please confirm your email address first, then try again.');
};
const rm = (dir, file) => file && fs.rm(path.join(dir, file), { force: true }, () => {});
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// Supabase login: check the access token with Supabase, cache the answer for 30 seconds.
// Logging out through this server drops the cached answers at once, and the token stays refused here afterwards.
const tokens = new Map(), revoked = new Map();
const tokKey = t => crypto.createHash('sha256').update(t).digest('base64url');
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tokens) if (t.exp < now) tokens.delete(k);
  for (const [k, exp] of revoked) if (exp < now) revoked.delete(k);
}, 300e3).unref();
function forgetToken(token) {
  const c = tokens.get(token);
  tokens.delete(token);
  if (c) for (const [k, t] of tokens) if (t.uid === c.uid) tokens.delete(k); // "log out everywhere" also ends other cached sessions
  // keep refusing it until it would have expired anyway (Supabase access tokens last 1 h by default)
  let exp = Date.now() + 3600e3;
  try { const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); if (p.exp) exp = Math.min(p.exp * 1000, Date.now() + 86400e3); } catch {}
  revoked.set(tokKey(token), exp);
}
async function sbUser(token) {
  if (revoked.has(tokKey(token))) return null;
  const c = tokens.get(token);
  if (c && c.exp > Date.now()) return c;
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r) throw fail(503, 'Login service is not running.');
  const u = r.ok ? await r.json().catch(() => null) : null;
  if (!u || !u.id) return null;
  const hit = { uid: 'sb_' + u.id, email: u.email || '', verified: !!(u.email_confirmed_at || u.confirmed_at), exp: Date.now() + 30e3 };
  tokens.set(token, hit);
  return hit;
}
// Pass /sb/auth/v1/* through to Supabase, so login also works from a phone on the same Wi-Fi.
// Only the login endpoints the app needs, never the admin API or other Supabase services; only the headers
// Supabase needs; and its own rate limits per network (AUTH_LIMIT_SCALE multiplies them, e.g. for test servers).
const AUTH_PATHS = /^\/sb\/auth\/v1\/(signup|token|logout|user|recover|verify|otp|magiclink|resend|settings|health|reauthenticate|authorize|callback|factors(\/[\w-]{1,64}(\/(challenge|verify))?)?)$/;
const AUTH_HEADERS = ['accept', 'accept-language', 'apikey', 'authorization', 'content-type', 'content-length', 'x-client-info', 'x-supabase-api-version', 'user-agent'];
const AUTH_SCALE = Number(process.env.AUTH_LIMIT_SCALE) > 0 ? Number(process.env.AUTH_LIMIT_SCALE) : 1;
function authLimits(req, what, url) {
  const n = x => Math.max(1, Math.round(x * AUTH_SCALE));
  if (what === 'signup') limit(req, 'auth-signup', n(10), 3600e3);
  else if (what === 'token' && url.searchParams.get('grant_type') === 'password') limit(req, 'auth-login', n(20), 600e3);
  else if (['recover', 'otp', 'magiclink', 'resend', 'reauthenticate'].includes(what)) limit(req, 'auth-email', n(10), 3600e3);
  else if (what === 'verify') limit(req, 'auth-verify', n(30), 600e3);
  limit(req, 'auth-any', n(300), 600e3);
}
function proxyAuth(req, res) {
  const raw = req.url.split('?')[0];
  // no dot segments, encoded slashes / dots or backslashes: the path must already be in its plain form
  if (/\.\.|%2e|%2f|%5c|\\|\/\//i.test(raw)) throw fail(404, 'Not found.');
  const am = AUTH_PATHS.exec(raw);
  if (!am || !['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method)) throw fail(404, 'Not found.');
  const url = new URL(req.url, 'http://x');
  authLimits(req, am[1].split('/')[0], url);
  const target = new URL(SB_URL + '/auth/v1/' + am[1] + url.search);
  const headers = { host: target.host, 'x-forwarded-for': clientIp(req) };
  for (const k of AUTH_HEADERS) if (req.headers[k] !== undefined) headers[k] = req.headers[k];
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const pr = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, r => {
    if (am[1] === 'logout' && bearer) { if (r.statusCode < 300) forgetToken(bearer[1]); else tokens.delete(bearer[1]); }
    const h = { ...r.headers };
    delete h['set-cookie'];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Login service is not running.' }); else res.end(); });
  req.pipe(pr);
}

// Client IP for rate limits. Behind a proxy, TRUST_PROXY is the number of proxies in front of the app (default 1 on
// Render/Docker): only the address those proxies added is used, never values the client wrote into X-Forwarded-For.
function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY) || 0;
  if (hops > 0) {
    const xs = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xs.length >= hops) return xs[xs.length - hops];
  }
  return req.socket.remoteAddress || '';
}
// Simple rate limit (in memory): per client IP by default, or per account when `who` is given
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 600e3).unref();
function limit(req, key, max, ms = 600e3, who = clientIp(req)) {
  const k = key + '|' + who, now = Date.now(), h = hits.get(k);
  if (!h && hits.size >= 100000) { // bounded memory: drop expired entries, then the oldest
    for (const [k2, x] of hits) if (x.reset < now) hits.delete(k2);
    if (hits.size >= 100000) for (const k2 of [...hits.keys()].slice(0, 10000)) hits.delete(k2);
  }
  if (!h || h.reset < now) return void hits.set(k, { n: 1, reset: now + ms });
  if (++h.n > max) throw fail(429, 'Too many tries. Please wait a few minutes.');
}

async function readJson(req) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 4096) throw fail(413, 'Request is too large.'); }
  try { return JSON.parse(body || '{}'); } catch { throw fail(400, 'Invalid data.'); }
}

// Uploads in progress, so parallel uploads can't go past the storage quota or the free-space floor together
const inflight = new Map();
let inflightAll = 0;
function reserve(uid, bytes) {
  inflight.set(uid, (inflight.get(uid) || 0) + bytes); inflightAll += bytes;
  return () => { const n = (inflight.get(uid) || 0) - bytes; if (n > 0) inflight.set(uid, n); else inflight.delete(uid); inflightAll -= bytes; };
}
const tmpName = dir => path.join(dir, '.tmp-' + crypto.randomUUID());
// Profile photos and thumbnails: saved under a temporary name, kept only if the bytes really are JPG, PNG or WebP
async function saveImage(req, dir, max, tooBig) {
  const tmp = tmpName(dir);
  try {
    await save(req, tmp, max, tooBig);
    const type = imageType(tmp);
    if (!type) throw fail(415, 'This file is not a JPG, PNG or WebP image.');
    const file = crypto.randomUUID() + IMG[type];
    fs.renameSync(tmp, path.join(dir, file));
    return file;
  } finally { fs.rmSync(tmp, { force: true }); }
}
// Stream the request body to disk, stopping at `max` bytes
async function save(req, dest, max, tooBig) {
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const c of src) { size += c.length; if (size > max) throw fail(413, tooBig); yield c; }
    }, fs.createWriteStream(dest));
    if (!size) throw fail(400, 'The file is empty.');
    return size;
  } catch (e) {
    fs.rm(dest, { force: true }, () => {});
    throw e;
  }
}
// Free disk space where uploads are kept. Fails closed: if it can't be read, uploads are refused.
function freeBytes() {
  try { const s = fs.statfsSync(DIRS.uploads); return s.bavail * s.bsize; } catch { return 0; }
}
const needDisk = bytes => { if (freeBytes() - bytes < MIN_FREE) throw fail(507, 'The server is low on storage. Please try again later.'); };
const ctype = req => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

// ---------- users ----------
const getUser = db.prepare('SELECT * FROM users WHERE uid=?');
const byName = db.prepare('SELECT * FROM users WHERE name=? COLLATE NOCASE');
function uniqueName(base) {
  base = cleanName(base).slice(0, 20);
  if (base.length < 3) base = 'user' + base;
  if (!byName.get(base)) return base;
  for (let i = 2; ; i++) if (!byName.get(base + i)) return base + i;
}
// Make sure a user row with a username exists (created on first action, not on first visit)
function ensureUser(uid, want) {
  const u = getUser.get(uid);
  if (u && u.name) return u;
  const name = uniqueName(want || 'user' + crypto.randomInt(1000, 99999));
  if (u) db.prepare('UPDATE users SET name=? WHERE uid=?').run(name, uid);
  else db.prepare('INSERT INTO users(uid,name,created) VALUES(?,?,?)').run(uid, name, Date.now());
  return getUser.get(uid);
}
// Blocks work both ways: neither person sees the other's videos or comments, and neither can follow, like or comment on the other
const blockedQ = db.prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)');
const blockedBetween = (a, b) => !!a && !!b && a !== b && !!blockedQ.get(a, b, b, a);
const notBlocked = (me, other) => `NOT EXISTS(SELECT 1 FROM blocks bk WHERE (bk.blocker=${me} AND bk.blocked=${other}) OR (bk.blocker=${other} AND bk.blocked=${me}))`; // fixed SQL names only
const needNoBlock = (a, b) => { if (blockedBetween(a, b)) throw Object.assign(fail(403, "You can't interact with this account because of a block."), { blocked: true }); };
// In-app notification types that exist, and per-user settings (default: on)
const NTYPES = ['follow', 'comment', 'reply', 'like', 'upload', 'collab'];
function prefsOf(uid) {
  const p = Object.fromEntries(NTYPES.map(t => [t, true])), rows = db.prepare('SELECT type, enabled FROM notif_prefs WHERE uid=?').all(uid);
  for (const r of rows) if (r.type in p) p[r.type] = !!r.enabled;
  p.muted = rows.some(r => r.type === 'all' && !r.enabled);
  return p;
}
const countFollowers = db.prepare('SELECT COUNT(*) n FROM follows WHERE followee=?');
const countFollowing = db.prepare('SELECT COUNT(*) n FROM follows WHERE follower=?');
// Social links: a full URL or just a handle; stored as a clean https URL on the right site
const SOCIAL = {
  instagram: { hosts: ['instagram.com'], from: h => 'https://instagram.com/' + h },
  youtube: { hosts: ['youtube.com', 'youtu.be'], from: h => 'https://youtube.com/@' + h },
  x: { hosts: ['x.com', 'twitter.com'], from: h => 'https://x.com/' + h },
  facebook: { hosts: ['facebook.com', 'fb.com'], from: h => 'https://facebook.com/' + h },
  website: { hosts: null, from: h => 'https://' + h },
};
function cleanLinks(b) {
  const outL = {};
  for (const [k, s] of Object.entries(SOCIAL)) {
    let v = text(b && b[k], 200).trim();
    if (!v) continue;
    if (!/^https?:\/\//i.test(v)) v = k !== 'website' && /^@?[\w.-]{1,60}$/.test(v) ? s.from(v.replace(/^@/, '')) : 'https://' + v.replace(/^\/+/, '');
    let u;
    try { u = new URL(v); } catch { throw fail(400, `That ${k === 'x' ? 'X' : k[0].toUpperCase() + k.slice(1)} link doesn't look right.`); }
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
    const okHost = s.hosts ? s.hosts.some(d => host === d || host.endsWith('.' + d)) : /\.[a-z]{2,}$/.test(host);
    if (!/^https?:$/.test(u.protocol) || !okHost) throw fail(400, `Please enter a valid ${k === 'x' ? 'X' : k[0].toUpperCase() + k.slice(1)} link.`);
    u.protocol = 'https:';
    outL[k] = u.href;
  }
  return outL;
}
const linksOf = u => { try { return JSON.parse(u.links || '{}'); } catch { return {}; } };
function meOut(uid, email = '') {
  const u = uid && getUser.get(uid), account = uid.startsWith('sb_');
  if (!u) return { name: null, fullName: '', bio: '', links: {}, avatar: null, account, email, followers: 0, following: 0 };
  return {
    name: u.name, fullName: u.fullname || '', bio: u.bio, links: linksOf(u), avatar: u.avatar ? '/avatars/' + u.avatar : null, account, email,
    followers: countFollowers.get(uid).n, following: countFollowing.get(uid).n,
  };
}

// ---------- demo data + migrations ----------
// [old Hindi title, title, handle, mood, tags, emoji, likes]
const DEMOS = [
  ['Dilli ki sabse tez chai wala', 'The fastest chai seller in Delhi', '@chaiwala_raju', 'Food', ['chai', 'delhi', 'taste'], '☕', 1240],
  ['Jugaad se banaya cooler', 'A homemade hack cooler', '@desi_jugaad', 'Learning', ['hack', 'diy'], '🛠️', 860],
  ['Mumbai local mein dance', 'Dancing on the Mumbai local train', '@bombay_beats', 'Energy', ['dance', 'mumbai'], '💃', 3100],
  ['Dada ji ki hasi wali kahani', "Grandpa's funny story", '@dadaji_stories', 'Comedy', ['story', 'comedy'], '😂', 2210],
  ['Manali ki pehli barf', 'First snow in Manali', '@pahadi_diaries', 'Travel', ['manali', 'snow'], '🏔️', 1540],
  ['60 second mein UPI kaise kaam karta hai', 'How UPI works in 60 seconds', '@paisa_gyaan', 'Learning', ['upi', 'money'], '📱', 970],
  ['Maa ke haath ke aloo parathe', "Mom's homemade aloo paratha", '@ghar_ka_khana', 'Food', ['paratha', 'homemade'], '🫓', 4020],
  ['Cricket gali ka last over', 'Last over of street cricket', '@gully_boys', 'Energy', ['cricket', 'street'], '🏏', 2760],
];
if (db.prepare('SELECT COUNT(*) n FROM videos').get().n === 0) {
  const ins = db.prepare('INSERT INTO videos(title,handle,mood,tags,emoji,likes,created) VALUES(?,?,?,?,?,?,0)');
  DEMOS.forEach(([, t, h, m, g, e, l]) => ins.run(t, h, m, JSON.stringify(g), e, l));
}
for (const [a, b] of [['Hasya', 'Comedy'], ['Josh', 'Energy'], ['Gyaan', 'Learning'], ['Khana', 'Food'], ['Safar', 'Travel']])
  db.prepare('UPDATE videos SET mood=? WHERE mood=?').run(b, a);
{
  const fixDemo = db.prepare('UPDATE videos SET title=?, tags=? WHERE owner IS NULL AND title=?');
  const demoUser = db.prepare('INSERT OR IGNORE INTO users(uid,name,created) VALUES(?,?,0)');
  const demoOwner = db.prepare('UPDATE videos SET owner=? WHERE owner IS NULL AND handle=?');
  // Demo uids contain ':' so they can never be sent as a real X-Uid
  DEMOS.forEach(([old, t, h, , g]) => { fixDemo.run(t, JSON.stringify(g), old); demoUser.run('demo:' + h.slice(1), h.slice(1)); demoOwner.run('demo:' + h.slice(1), h); });
  // Give every existing uploader a username, taken from their latest video's handle
  for (const { owner } of db.prepare('SELECT DISTINCT owner FROM videos WHERE owner IS NOT NULL').all()) {
    const u = getUser.get(owner);
    if (u && u.name) continue;
    ensureUser(owner, db.prepare('SELECT handle FROM videos WHERE owner=? ORDER BY created DESC LIMIT 1').get(owner).handle);
  }
}
fillSlugs(); // demo clips seeded above need link ids too

// ---------- videos ----------
const VSEL = `SELECT * FROM (SELECT v.*, u.name uname, u.avatar uav, u.fullname ufull,
  EXISTS(SELECT 1 FROM likes l WHERE l.video=v.id AND l.uid=$me) liked,
  EXISTS(SELECT 1 FROM follows f WHERE f.follower=$me AND f.followee=v.owner) following,
  (SELECT COUNT(*) FROM comments c WHERE c.video=v.id) ncom,
  (SELECT COUNT(*) FROM reports r WHERE r.video=v.id) nrep,
  (SELECT h.position FROM watch_history h WHERE h.uid=$me AND h.video=v.id AND h.completed=0) wpos
  FROM videos v LEFT JOIN users u ON u.uid=v.owner)`;
const ORDER = ' ORDER BY created DESC, id ASC';
const OWNED = `(owner=$owner AND ((hidden = 0 AND created <= $now) OR owner=$me))
  OR (id IN (SELECT video FROM collabs WHERE uid=$owner AND status='accepted') AND hidden = 0 AND created <= $now AND ${notBlocked('$me', 'owner')})`;
const q = {
  // Your own videos never appear in your feed; they live on your profile
  // A scheduled video stores its publish time in 'created' and stays hidden from others until then
  // Hidden = an admin hid it after reports
  feed: db.prepare(`${VSEL} WHERE hidden = 0 AND (owner IS NULL OR owner <> $me) AND created <= $now AND ${notBlocked('$me', 'owner')}${ORDER}`),
  following: db.prepare(`${VSEL} WHERE hidden = 0 AND following=1 AND created <= $now AND ${notBlocked('$me', 'owner')}${ORDER}`),
  // A creator's videos: their own (hidden / scheduled ones only for themselves), plus public videos they accepted
  // to collaborate on (never hidden, pending or scheduled ones, and not across a block with the video's owner)
  byOwner: db.prepare(`${VSEL} WHERE ${OWNED}${ORDER}`),
  byOwnerPage: db.prepare(`${VSEL} WHERE (${OWNED}) AND (created < $bc OR (created = $bc AND id > $bid))${ORDER} LIMIT $lim`),
  ownerLikes: db.prepare('SELECT SUM(likes) n FROM videos WHERE owner=$owner AND ((hidden = 0 AND created <= $now) OR owner=$me)'),
  // Optional paging (limit + cursor) for API clients; the app itself still loads the whole feed (see GET /api/videos)
  feedPage: db.prepare(`${VSEL} WHERE hidden = 0 AND (owner IS NULL OR owner <> $me) AND created <= $now AND ${notBlocked('$me', 'owner')} AND (created < $bc OR (created = $bc AND id > $bid))${ORDER} LIMIT $lim`),
  followingPage: db.prepare(`${VSEL} WHERE hidden = 0 AND following=1 AND created <= $now AND ${notBlocked('$me', 'owner')} AND (created < $bc OR (created = $bc AND id > $bid))${ORDER} LIMIT $lim`),
  one: db.prepare(`${VSEL} WHERE id=$id`),
  insert: db.prepare('INSERT INTO videos(title,handle,owner,mood,tags,file,mime,filter,created,slug,description,size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),
  bySlug: db.prepare('SELECT id FROM videos WHERE slug=?'),
  hasLike: db.prepare('SELECT 1 FROM likes WHERE video=? AND uid=?'),
  addLike: db.prepare('INSERT INTO likes(video,uid,created) VALUES(?,?,?)'),
  delLike: db.prepare('DELETE FROM likes WHERE video=? AND uid=?'),
  bump: db.prepare('UPDATE videos SET likes=MAX(0,likes+?) WHERE id=?'),
  ncom: db.prepare('SELECT COUNT(*) n FROM comments WHERE video=?'),
};
// Files of videos only some people may see (hidden, waiting for review, scheduled) are served only through a signed link
// that expires; the API hands it to the people allowed to see the video (owner, admin). Public videos keep plain links.
const MEDIA_KEY = crypto.createHmac('sha256', ADMIN_KEY).update('invidora-media-links').digest();
const restricted = v => !!v.hidden || v.created > Date.now();
const mediaSig = (name, exp) => crypto.createHmac('sha256', MEDIA_KEY).update(name + '|' + exp).digest('base64url').slice(0, 32);
function mediaUrl(dir, name, v) {
  if (!name) return null;
  if (!v || !restricted(v)) return `/${dir}/${name}`;
  const exp = Math.ceil(Date.now() / 216e5) * 21600 + 86400; // seconds; the same link for 6 h, so the browser can cache it
  return `/${dir}/${name}?e=${exp}&s=${mediaSig(name, exp)}`;
}
const out = (v, me) => ({
  id: v.id, slug: v.slug, title: v.title, description: v.description || '', name: v.uname || null, fullName: v.ufull || '', handle: '@' + (v.uname || cleanName(v.handle) || 'user'),
  avatar: v.uav ? '/avatars/' + v.uav : null, mood: v.mood, tags: JSON.parse(v.tags), emoji: v.emoji,
  likes: v.likes, views: v.views, comments: v.ncom, filter: v.filter, created: v.created || null,
  src: mediaUrl('uploads', v.file, v), thumb: mediaUrl('thumbs', v.thumb, v),
  liked: !!v.liked, following: !!v.following, mine: !!me && v.owner === me, review: !!v.hidden, pending: !!v.pending, scheduled: v.created > Date.now(),
  commentsOff: !!v.comments_off, resume: v.wpos >= 3 ? Math.round(v.wpos * 10) / 10 : 0,
  // accepted collaborators (lists fetch these in one query via outAll; a single video looks them up itself)
  collabs: (v._collabs || withCollabs([v], me)[0]._collabs),
});
// Can this person see the video right now? (hidden / scheduled only for the owner; never across a block)
const canSee = (v, uid) => v.owner === uid || (!v.hidden && v.created <= Date.now());
const visibleTo = (v, uid) => canSee(v, uid) && !blockedBetween(uid, v.owner);
// A video someone may act on: 404 while hidden or scheduled (as if it didn't exist), 403 across a block
function seeable(uid, id) {
  const v = video(uid, id);
  if (!canSee(v, uid)) throw fail(404, 'Video not found.');
  if (blockedBetween(uid, v.owner)) throw Object.assign(fail(403, "This video isn't available because of a block."), { blocked: true });
  return v;
}
// Description: up to 500 characters, keeps line breaks (at most 2 blank lines in a row)
const desc = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 500);
function video(uid, id) {
  const v = q.one.get({ me: uid, id });
  if (!v) throw fail(404, 'Video not found.');
  return v;
}
function ownVideo(uid, id) {
  need(uid);
  const v = video(uid, id);
  if (v.owner !== uid) throw fail(403, 'You can only change your own videos.');
  return v;
}
function removeVideo(id) {
  const v = db.prepare('SELECT file, thumb FROM videos WHERE id=?').get(id);
  if (!v) return;
  removeCollabs(id);
  db.prepare('DELETE FROM comment_likes WHERE comment IN (SELECT id FROM comments WHERE video=?)').run(id);
  db.prepare('DELETE FROM comment_reports WHERE comment IN (SELECT id FROM comments WHERE video=?)').run(id);
  for (const t of ['likes', 'comments', 'views', 'reports', 'watch_history', 'watch']) db.prepare(`DELETE FROM ${t} WHERE video=?`).run(id);
  db.prepare('DELETE FROM videos WHERE id=?').run(id);
  rm(DIRS.uploads, v.file);
  rm(DIRS.thumbs, v.thumb);
}

// Guest ids made since 19 Oct 2026 are 'g' + sha256(secret) (base64url); the browser keeps the secret and shows it only
// to /api/link, so a leaked guest id alone can't move that guest's data into someone else's account.
// Older ids (any other form) have no secret and can still be linked as before.
const PROVEN_ID = /^g[\w-]{43}$/;
const guestOwned = (id, key) => !PROVEN_ID.test(id) ||
  (typeof key === 'string' && key.length >= 22 && key.length <= 128 && safeEq(id.slice(1), crypto.createHash('sha256').update(key).digest('base64url')));
// Delete a comment with its replies (and their likes / reports); a pin on it goes too. Returns the video id.
function removeComment(id) {
  const c = db.prepare('SELECT id, video FROM comments WHERE id=?').get(id);
  if (!c) return null;
  const ids = [c.id, ...db.prepare('SELECT id FROM comments WHERE parent=?').all(c.id).map(r => r.id)];
  for (const x of ids) {
    db.prepare('DELETE FROM comment_likes WHERE comment=?').run(x);
    db.prepare('DELETE FROM comment_reports WHERE comment=?').run(x);
    db.prepare('DELETE FROM comments WHERE id=?').run(x);
  }
  db.prepare('UPDATE videos SET pinned=NULL WHERE id=? AND pinned=?').run(c.video, c.id);
  return c.video;
}
// Move an anonymous browser's data into the account it just logged in to
function merge(from, to) {
  if (!from || from === to || from.startsWith('sb_')) return;
  const cur = getUser.get(from);
  db.exec('BEGIN');
  try {
    // First login on this account: the browser's profile simply becomes the account's profile
    if (cur && !getUser.get(to)) db.prepare('UPDATE users SET uid=? WHERE uid=?').run(to, from);
    for (const { video: id } of db.prepare('SELECT video FROM likes WHERE uid=? AND video IN (SELECT video FROM likes WHERE uid=?)').all(from, to)) q.bump.run(-1, id);
    db.prepare('DELETE FROM likes WHERE uid=? AND video IN (SELECT video FROM likes WHERE uid=?)').run(from, to);
    db.prepare('UPDATE likes SET uid=? WHERE uid=?').run(to, from);
    for (const t of ['views', 'reports', 'comment_likes']) {
      db.prepare(`UPDATE OR IGNORE ${t} SET uid=? WHERE uid=?`).run(to, from);
      db.prepare(`DELETE FROM ${t} WHERE uid=?`).run(from);
    }
    db.prepare('UPDATE comments SET uid=? WHERE uid=?').run(to, from);
    db.prepare('UPDATE videos SET owner=? WHERE owner=?').run(to, from);
    for (const c of ['follower', 'followee']) {
      db.prepare(`UPDATE OR IGNORE follows SET ${c}=? WHERE ${c}=?`).run(to, from);
      db.prepare(`DELETE FROM follows WHERE ${c}=?`).run(from);
    }
    db.prepare('DELETE FROM follows WHERE follower=followee').run();
    const acc = getUser.get(to);
    if (cur && cur.avatar && acc.avatar !== cur.avatar) {
      if (!acc.avatar) db.prepare('UPDATE users SET avatar=? WHERE uid=?').run(cur.avatar, to);
      else rm(DIRS.avatars, cur.avatar);
    }
    db.prepare('DELETE FROM users WHERE uid=?').run(from);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function setName(uid, raw) {
  const n = cleanName(raw);
  if (n.length < 3) throw fail(400, 'Username must be 3–24 letters, numbers, _ or .');
  const t = byName.get(n);
  if (t && t.uid !== uid) throw fail(409, 'That username is taken.');
  db.prepare('UPDATE users SET name=? WHERE uid=?').run(n, uid);
  db.prepare('UPDATE videos SET handle=? WHERE owner=?').run('@' + n, uid);
}
function userByName(name) {
  const u = byName.get(cleanName(name));
  if (!u) throw fail(404, 'User not found.');
  return u;
}
const isAdmin = req => safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY);
// Wrong admin keys are rate-limited per network, so the key can't be found by trying many
function needAdmin(req) { if (!isAdmin(req)) { limit(req, 'admin-fail', 20, 600e3); throw fail(401, 'Wrong admin key.'); } }

// ---------- collaborations ----------
// One row per invited creator per video. The video stays one record (one set of views, likes and comments); accepted
// collaborators are shown on it and it appears on their profiles too. The owner keeps sole control of the video.
const removeCollabs = video => db.prepare('DELETE FROM collabs WHERE video=?').run(video);
const MAX_COLLABS = 5; // pending + accepted per video
// Accepted collaborators of many videos in one query (no query per video); people across a block are left out
const collabsQ = db.prepare(`SELECT c.video, u.name, u.fullname, u.avatar FROM collabs c JOIN users u ON u.uid=c.uid
  WHERE c.status='accepted' AND c.video IN (SELECT value FROM json_each($ids)) AND ${notBlocked('$me', 'c.uid')} ORDER BY c.responded`);
function withCollabs(rows, me) {
  const by = new Map(rows.map(v => [v.id, v]));
  for (const v of rows) v._collabs = [];
  if (rows.length) for (const c of collabsQ.all({ ids: JSON.stringify([...by.keys()]), me: me || '' }))
    by.get(c.video)._collabs.push({ name: c.name, fullName: c.fullname || '', avatar: c.avatar ? '/avatars/' + c.avatar : null });
  return rows;
}
const outAll = (rows, me) => withCollabs(rows, me).map(v => out(v, me));
// Blocking ends collaborations between the two people, both ways (like follows); unblocking doesn't bring them back
const endCollabsBetween = (a, b) => db.prepare(`DELETE FROM collabs WHERE (uid=$a AND video IN (SELECT id FROM videos WHERE owner=$b))
  OR (uid=$b AND video IN (SELECT id FROM videos WHERE owner=$a))`).run({ a, b });

// ---------- web push (opt-in, per device) ----------
// Standard Web Push: payloads encrypted for the device (RFC 8291, aes128gcm) and signed with this server's VAPID key
// (RFC 8292). Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url), else they are made once and kept in
// data/vapid.json (like the admin key). Requests only go to the known browser push services over https, never to any
// address a client makes up. Pushes follow the same Settings switches, Mute and blocks as in-app notifications.
db.exec(`CREATE TABLE IF NOT EXISTS push_subs(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL, last_ok INTEGER, fails INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS push_subs_uid ON push_subs(uid);
CREATE TABLE IF NOT EXISTS push_log(uid TEXT NOT NULL, key TEXT NOT NULL, sent INTEGER NOT NULL, PRIMARY KEY(uid, key));`);
const VAPID = (() => {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const file = path.join(DATA, 'vapid.json');
  if (!pub || !priv) {
    try { ({ pub, priv } = JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    if (!pub || !priv) {
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      pub = e.getPublicKey().toString('base64url'); priv = e.getPrivateKey().toString('base64url');
      fs.writeFileSync(file, JSON.stringify({ pub, priv }) + '\n', { mode: 0o600 });
    }
  }
  const P = Buffer.from(pub, 'base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: priv, x: P.subarray(1, 33).toString('base64url'), y: P.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  return { pub, key, sub: process.env.VAPID_SUBJECT || 'mailto:admin@invidora.invalid' };
})();
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([\w-]+\.)*push\.services\.mozilla\.com$/, /^[\w-]+\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];
const PUSH_TEST = process.env.PUSH_TEST_ENDPOINT_PREFIX || ''; // test servers only: a local fake push service
function pushEndpointOk(ep) {
  if (typeof ep !== 'string' || ep.length > 1024) return false;
  if (PUSH_TEST && ep.startsWith(PUSH_TEST)) return true;
  let u; try { u = new URL(ep); } catch { return false; }
  return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOSTS.some(h => h.test(u.hostname));
}
const b64 = s => typeof s === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(s) ? Buffer.from(s, 'base64url') : null;
function vapidAuth(endpoint) {
  const u = new URL(endpoint), enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID.sub });
  const sig = crypto.sign('sha256', Buffer.from(data), { key: VAPID.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${data}.${sig}, k=${VAPID.pub}`;
}
// RFC 8291: one aes128gcm record
function pushEncrypt(sub, payload) {
  const ua = Buffer.from(sub.p256dh, 'base64url'), auth = Buffer.from(sub.auth, 'base64url');
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const as = e.getPublicKey(), shared = e.computeSecret(ua), salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, as, body]);
}
// A small queue (4 at a time); a device that says it's gone (404 / 410) or fails 5 times in a row is forgotten
const pushQ = []; let pushBusy = 0;
function pushSend(sub, payload) {
  if (pushQ.length >= 1000) pushQ.shift();
  pushQ.push([sub, payload]); pushPump();
}
function pushPump() {
  while (pushBusy < 4 && pushQ.length) {
    const [sub, payload] = pushQ.shift(); pushBusy++;
    let body; try { body = pushEncrypt(sub, payload); } catch { pushBusy--; db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id); continue; }
    const u = new URL(sub.endpoint);
    const rq = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', timeout: 10000, headers: {
      TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Authorization: vapidAuth(sub.endpoint),
    } }, r => {
      r.resume();
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) db.prepare('UPDATE push_subs SET last_ok=?, fails=0 WHERE id=?').run(Date.now(), sub.id);
        else if (r.statusCode === 404 || r.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id);
        else db.prepare('UPDATE push_subs SET fails=fails+1 WHERE id=?').run(sub.id);
        db.prepare('DELETE FROM push_subs WHERE id=? AND fails>=5').run(sub.id);
        pushBusy--; pushPump();
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', () => { db.prepare('UPDATE push_subs SET fails=fails+1 WHERE id=?').run(sub.id); db.prepare('DELETE FROM push_subs WHERE id=? AND fails>=5').run(sub.id); pushBusy--; pushPump(); });
    rq.end(body);
  }
}
// Send one notification to every device of `to`: only if they turned that type on, aren't muted, aren't blocked with
// whoever caused it, and haven't already had this one (key) within `windowMs`. Payload: title, text and an app link only.
function notifyPush(to, type, actor, key, msg, windowMs = Infinity) {
  if (!to || !to.startsWith('sb_') || to === actor) return;
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE uid=?').all(to);
  if (!subs.length) return;
  const p = prefsOf(to);
  if (p.muted || p[type] === false || (actor && blockedBetween(to, actor))) return;
  const now = Date.now(), had = db.prepare('SELECT sent FROM push_log WHERE uid=? AND key=?').get(to, key);
  if (had && (windowMs === Infinity || now - had.sent < windowMs)) return;
  db.prepare('INSERT INTO push_log(uid,key,sent) VALUES(?,?,?) ON CONFLICT(uid,key) DO UPDATE SET sent=excluded.sent').run(to, key, now);
  // the tag (lets a newer notification replace an older one) is an opaque hash: the key itself holds internal ids
  const tag = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16);
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/?notif=1', tag });
  for (const s of subs) pushSend(s, payload);
}
setInterval(() => db.prepare('DELETE FROM push_log WHERE sent < ?').run(Date.now() - 30 * 864e5), 6 * 3600e3).unref();
const at = n => '@' + (n || 'someone');
const nameOf = uid => (getUser.get(uid) || {}).name;
// A link to the video only while it is public; otherwise the app's Notifications page (never a private file link)
const pushUrl = v => !v.hidden && v.created <= Date.now() && v.slug ? '/v/' + v.slug : '/?notif=1';
function pushComment(id) {
  const c = db.prepare('SELECT c.id, c.uid, c.parent, v.id vid, v.owner, v.title, v.slug, v.hidden, v.created FROM comments c JOIN videos v ON v.id=c.video WHERE c.id=?').get(id);
  if (!c) return;
  const who = at(nameOf(c.uid)), p = c.parent && db.prepare('SELECT uid FROM comments WHERE id=?').get(c.parent);
  // the parent's writer gets "replied"; the video owner gets "commented" (once: a reply to the owner's own comment is a reply)
  if (p && p.uid !== c.uid && (c.owner === p.uid || (!c.hidden && c.created <= Date.now() && !blockedBetween(p.uid, c.owner))))
    notifyPush(p.uid, 'reply', c.uid, 'r:' + c.id, { title: 'New reply', body: `${who} replied to your comment on “${c.title}”`, url: pushUrl(c) });
  if (!p || p.uid !== c.owner) notifyPush(c.owner, 'comment', c.uid, 'c:' + c.id, { title: 'New comment', body: `${who} commented on “${c.title}”`, url: pushUrl(c) });
}
function pushCollab(video, uid, what) {
  const v = db.prepare('SELECT id, owner, title FROM videos WHERE id=?').get(video);
  if (!v) return;
  if (what === 'invite') notifyPush(uid, 'collab', v.owner, `ci:${v.id}:${uid}`, { title: 'Collaboration invitation', body: `${at(nameOf(v.owner))} invited you to collaborate on “${v.title}”` }, 864e5);
  else notifyPush(v.owner, 'collab', uid, `ca:${v.id}:${uid}`, { title: 'Collaboration', body: `${at(nameOf(uid))} ${what === 'accepted' ? 'accepted' : 'declined'} your invitation to collaborate on “${v.title}”` });
}
const pushFollow = (follower, followee) => notifyPush(followee, 'follow', follower, 'f:' + follower, { title: 'New follower', body: `${at(nameOf(follower))} started following you`, url: '/?u=' + encodeURIComponent(nameOf(follower) || '') }, 864e5);
function pushApproved(v) {
  const live = v.created <= Date.now();
  notifyPush(v.owner, 'upload', null, 'ap:' + v.id, { title: 'Video approved', body: live ? `Your video “${v.title}” is live` : `Your video “${v.title}” was approved and goes live as scheduled`, url: live ? '/v/' + v.slug : '/?notif=1' });
  if (live) db.prepare('INSERT OR IGNORE INTO push_log(uid,key,sent) VALUES(?,?,?)').run(v.owner, 'live:' + v.id, Date.now());
}
// Scheduled videos going live: checked every minute (LIVE_CHECK_MS for tests); each video at most once
let liveFrom = Date.now();
setInterval(() => {
  const now = Date.now();
  for (const v of db.prepare(`SELECT id, owner, title, slug, created FROM videos WHERE created > ? AND created <= ? AND hidden=0 AND pending=0 AND substr(owner, 1, 3) = 'sb_'`).all(liveFrom - 5000, now))
    notifyPush(v.owner, 'upload', null, 'live:' + v.id, { title: 'Your video is live', body: `“${v.title}” is now in the feed`, url: '/v/' + v.slug });
  liveFrom = now;
}, Number(process.env.LIVE_CHECK_MS) || 60000).unref();

// Dashboard statements share one parameter object ({ me, since, now }), so names a statement doesn't use are allowed
const dq = sql => { const st = db.prepare(sql); st.setAllowUnknownNamedParameters(true); return st; };

// ---------- routes ----------
const routes = [
  // Without `limit` the whole feed comes back, as the app expects (search and trending work on it in the browser).
  // With ?limit=1..100 (and &before=<cursor> from the X-Next-Before header) it comes in pages.
  ['GET', /^\/api\/videos$/, ({ res, uid, url }) => {
    const p = url.searchParams, fol = p.get('feed') === 'following';
    if (!p.has('limit')) return json(res, 200, outAll((fol ? q.following : q.feed).all({ me: uid, now: Date.now() }), uid));
    const lim = Math.floor(Number(p.get('limit')));
    if (!(lim >= 1 && lim <= 100)) throw fail(400, 'limit must be 1 to 100.');
    const cur = /^(\d{1,15})_(\d{1,15})$/.exec(p.get('before') || '');
    if (p.has('before') && !cur) throw fail(400, 'Invalid cursor.');
    const rows = (fol ? q.followingPage : q.feedPage).all({ me: uid, now: Date.now(), lim, bc: cur ? +cur[1] : 8.64e15, bid: cur ? +cur[2] : 0 });
    const last = rows[rows.length - 1];
    if (rows.length === lim && last) res.setHeader('X-Next-Before', `${last.created}_${last.id}`);
    json(res, 200, outAll(rows, uid));
  }],

  // Uploading needs a confirmed account; limits per network and per account; per-account storage quota; free disk check
  ['POST', /^\/api\/videos$/, async ({ req, res, uid, verified, url }) => {
    needVerified(uid, verified, 'upload videos');
    limit(req, 'upload', 30, 3600e3);
    limit(req, 'upload-acct', 20, 864e5, uid);
    const p = url.searchParams, type = ctype(req), len = +req.headers['content-length'] || 0;
    if (!type.startsWith('video/')) throw fail(415, 'Only video files are allowed.');
    if (len > MAX) throw fail(413, 'Video must be under 100 MB.');
    const room = QUOTA - db.prepare('SELECT COALESCE(SUM(size),0) n FROM videos WHERE owner=?').get(uid).n - (inflight.get(uid) || 0);
    const QUOTA_MSG = 'You have reached your storage limit. Delete some videos to upload more.';
    if (room <= 0 || len > room) throw fail(413, QUOTA_MSG);
    const want = len || Math.min(MAX, room);
    needDisk(want + inflightAll);
    const title = text(p.get('title'), 70);
    if (!title) throw fail(400, 'Please add a title.');
    const mood = MOODS.includes(p.get('mood')) ? p.get('mood') : MOODS[0];
    const filter = FILTERS.includes(p.get('filter')) ? p.get('filter') : 'none';
    // Optional schedule: publish later (at least 1 minute, at most 60 days ahead)
    const now = Date.now(), at = p.get('publishAt') ? Number(p.get('publishAt')) : null;
    if (at !== null && (!Number.isFinite(at) || at < now + 60e3 || at > now + 60 * 864e5)) throw fail(400, 'Pick a time at least 1 minute and at most 60 days from now.');
    const u = ensureUser(uid);
    // Saved under a temporary name; it only becomes a video after the server has checked the file itself:
    // a real MP4 / MOV / 3GP / WebM with a video track, not damaged, at most 60 seconds long
    const release = reserve(uid, want), tmp = tmpName(DIRS.uploads);
    let id;
    try {
      const size = await save(req, tmp, Math.min(MAX, room), room < MAX ? QUOTA_MSG : 'Video must be under 100 MB.');
      let info;
      try { info = probeVideo(tmp); } catch (e) { throw fail(415, e instanceof Bad ? e.message : 'The video file is damaged or not supported.'); }
      if (info.duration > MAX_SEC + 1) throw fail(400, `This video is ${Math.round(info.duration)} seconds long. Videos must be 60 seconds or shorter.`);
      const file = crypto.randomUUID() + info.ext;
      fs.renameSync(tmp, path.join(DIRS.uploads, file));
      // The browser's safety check is only a hint: the client can't approve its own video (see UPLOAD_REVIEW)
      const scan = p.get('scan') === 'passed' ? 'passed' : 'unchecked';
      const held = UPLOAD_REVIEW === 'all' || scan !== 'passed' ? 1 : 0;
      db.exec('BEGIN');
      try {
        id = Number(q.insert.run(title, '@' + u.name, uid, mood, JSON.stringify(parseTags(p.get('tags'))), file, info.mime, filter, at || now, newSlug(), desc(p.get('description')), size).lastInsertRowid);
        db.prepare('UPDATE videos SET hidden=?, pending=?, scan=?, duration=? WHERE id=?').run(held, held, scan, info.duration, id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); rm(DIRS.uploads, file); throw e; }
      // live at once: no "your video is live" push to the person who just posted it
      if (!held && !at) db.prepare('INSERT OR IGNORE INTO push_log(uid,key,sent) VALUES(?,?,?)').run(uid, 'live:' + id, Date.now());
    } finally { release(); fs.rmSync(tmp, { force: true }); }
    json(res, 201, out(video(uid, id), uid));
  }],

  // Look a video up by its public link id
  ['GET', /^\/api\/videos\/s\/([A-Za-z0-9]{6,20})$/, ({ res, uid, m }) => {
    const row = q.bySlug.get(m[1]);
    const v = row && video(uid, row.id);
    if (!v || ((v.hidden || v.created > Date.now()) && v.owner !== uid)) throw fail(404, 'This video is not available.');
    if (blockedBetween(uid, v.owner)) throw Object.assign(fail(403, "This video isn't available because of a block."), { blocked: true });
    json(res, 200, out(v, uid));
  }],

  ['PATCH', /^\/api\/videos\/(\d+)$/, async ({ req, res, uid, m }) => {
    limit(req, 'vedit', 120, 600e3);
    const v = ownVideo(uid, +m[1]), b = await readJson(req);
    const title = text(b.title, 70);
    if (!title) throw fail(400, 'Please add a title.');
    db.prepare('UPDATE videos SET title=?, mood=?, tags=?, filter=?, description=? WHERE id=?').run(
      title, MOODS.includes(b.mood) ? b.mood : v.mood, JSON.stringify(parseTags(b.tags)), FILTERS.includes(b.filter) ? b.filter : v.filter,
      'description' in b ? desc(b.description) : v.description, v.id);
    // Turn comments on or off (owner only, checked by ownVideo above)
    if ('commentsOff' in b) {
      if (typeof b.commentsOff !== 'boolean') throw fail(400, 'commentsOff must be true or false.');
      db.prepare('UPDATE videos SET comments_off=? WHERE id=?').run(b.commentsOff ? 1 : 0, v.id);
    }
    json(res, 200, out(video(uid, v.id), uid));
  }],

  ['DELETE', /^\/api\/videos\/(\d+)$/, ({ res, uid, m }) => { removeVideo(ownVideo(uid, +m[1]).id); json(res, 200, { ok: true }); }],

  ['POST', /^\/api\/videos\/(\d+)\/thumb$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'change thumbnails');
    limit(req, 'thumb', 60, 3600e3, uid);
    const v = ownVideo(uid, +m[1]), type = ctype(req);
    if (!IMG[type]) throw fail(415, 'Thumbnail must be JPG, PNG or WebP.');
    needDisk(THMAX + inflightAll);
    const file = await saveImage(req, DIRS.thumbs, THMAX, 'Thumbnail must be under 1 MB.');
    db.prepare('UPDATE videos SET thumb=? WHERE id=?').run(file, v.id);
    rm(DIRS.thumbs, v.thumb);
    json(res, 200, { thumb: mediaUrl('thumbs', file, v) });
  }],

  ['POST', /^\/api\/videos\/(\d+)\/like$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'like videos');
    limit(req, 'like', 300, 600e3, uid);
    const lv = seeable(uid, +m[1]);
    const id = lv.id, had = q.hasLike.get(id, uid);
    if (had) q.delLike.run(id, uid); else q.addLike.run(id, uid, Date.now());
    q.bump.run(had ? -1 : 1, id);
    const v = video(uid, id);
    json(res, 200, { liked: !!v.liked, likes: v.likes });
  }],

  // A view counts once per account; for guests once per network (a keyed hash of the IP, so made-up ids can't add views)
  ['POST', /^\/api\/videos\/(\d+)\/view$/, ({ req, res, uid, m }) => {
    limit(req, 'view', 600, 3600e3);
    const id = seeable(uid, +m[1]).id;
    const viewer = uid.startsWith('sb_') ? uid : 'ip:' + crypto.createHmac('sha256', ADMIN_KEY).update(clientIp(req)).digest('base64url').slice(0, 22);
    if (db.prepare('INSERT OR IGNORE INTO views(video,uid,created) VALUES(?,?,?)').run(id, viewer, Date.now()).changes)
      db.prepare('UPDATE videos SET views=views+1 WHERE id=?').run(id);
    // Watch history (accounts only); watching again only moves it to the top, it never adds a view
    if (uid.startsWith('sb_')) db.prepare(`INSERT INTO watch_history(uid,video,first_at,last_at) VALUES(?,?,?,?)
      ON CONFLICT(uid,video) DO UPDATE SET last_at=excluded.last_at`).run(uid, id, Date.now(), Date.now());
    json(res, 200, { views: db.prepare('SELECT views FROM videos WHERE id=?').get(id).views });
  }],

  // Watch time (anyone who may see the video). The browser reports the seconds actually played since its last report,
  // about every 10 s and when playback stops. The server caps each report by the time that really passed since the
  // previous one, so a script can't add hours in a minute. Never counts a view.
  ['POST', /^\/api\/videos\/(\d+)\/watch$/, async ({ req, res, uid, m }) => {
    limit(req, 'watch', 900, 600e3);
    const v = seeable(uid, +m[1]), b = await readJson(req);
    const sec = b.seconds, pos = b.position, dur = b.duration;
    if (![sec, pos, dur].every(x => typeof x === 'number' && Number.isFinite(x))) throw fail(400, 'seconds, position and duration must be numbers.');
    if (sec < 0 || sec > 30 || pos < 0 || dur <= 0 || dur > 4 * 3600 || pos > dur + 5) throw fail(400, 'Invalid watch report.');
    const viewer = uid.startsWith('sb_') ? uid : 'ip:' + crypto.createHmac('sha256', ADMIN_KEY).update(clientIp(req)).digest('base64url').slice(0, 22);
    const now = Date.now(), len = v.duration || Math.min(dur, MAX_SEC + 1), p = Math.min(pos, len);
    const prev = db.prepare('SELECT last_at FROM watch WHERE video=? AND viewer=? ORDER BY hour DESC LIMIT 1').get(v.id, viewer);
    const s = Math.min(sec, 15, prev ? Math.max(0, (now - prev.last_at) / 1000 + 0.5) : 15);
    const done = b.ended === true || p >= len - Math.max(1, len * 0.05);
    db.prepare(`INSERT INTO watch(video,viewer,hour,at,last_at,seconds,max_pos,completed) VALUES($v,$w,$h,$now,$now,$s,$p,$c)
      ON CONFLICT(video,viewer,hour) DO UPDATE SET last_at=$now, seconds=MIN(3600, seconds+$s), max_pos=MAX(max_pos,$p), completed=MAX(completed,$c)`)
      .run({ v: v.id, w: viewer, h: Math.floor(now / 36e5), now, s, p, c: done ? 1 : 0 });
    json(res, 200, { ok: true, counted: Math.round(s * 10) / 10 });
  }],

  ['GET', /^\/api\/videos\/(\d+)\/comments$/, ({ res, uid, m }) => {
    const v = seeable(uid, +m[1]);
    // Comments turned off: only the owner still sees them (to moderate). Comments across a block are left out.
    if (v.comments_off && v.owner !== uid) return json(res, 200, []);
    // Top-level comments: the pinned one first, then most-liked, then newest (at most 300). Each carries its replies,
    // oldest first. Comments from people across a block are left out (a pinned one too).
    const COLS = `c.id, c.uid, c.text, c.created, c.edited, c.parent, u.name, u.avatar,
        (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment=c.id) likes,
        EXISTS(SELECT 1 FROM comment_likes cl WHERE cl.comment=c.id AND cl.uid=$me) liked,
        EXISTS(SELECT 1 FROM comment_reports cr WHERE cr.comment=c.id AND cr.uid=$me) reported`;
    const top = db.prepare(`SELECT ${COLS} FROM comments c LEFT JOIN users u ON u.uid=c.uid
      WHERE c.video=$v AND c.parent IS NULL AND ${notBlocked('$me', 'c.uid')}
      ORDER BY (c.id = $pin) DESC, likes DESC, c.id DESC LIMIT 300`).all({ me: uid, v: v.id, pin: v.pinned || 0 });
    const reps = top.length ? db.prepare(`SELECT ${COLS} FROM comments c LEFT JOIN users u ON u.uid=c.uid
      WHERE c.parent IN (SELECT value FROM json_each($ids)) AND ${notBlocked('$me', 'c.uid')}
      ORDER BY c.id ASC LIMIT 3000`).all({ me: uid, ids: JSON.stringify(top.map(c => c.id)) }) : [];
    const acct = uid.startsWith('sb_'), owner = !!uid && v.owner === uid;
    const one = c => ({
      id: c.id, parent: c.parent || null, text: c.text, created: c.created, edited: c.edited || null, name: c.name, avatar: c.avatar ? '/avatars/' + c.avatar : null,
      likes: c.likes, liked: !!c.liked,
      mine: !!uid && c.uid === uid, canEdit: !!uid && c.uid === uid, canDelete: !!uid && (c.uid === uid || owner),
      canReport: acct && c.uid !== uid, reported: !!c.reported,
    });
    json(res, 200, top.map(c => {
      const replies = reps.filter(r => r.parent === c.id).map(one);
      return { ...one(c), pinned: c.id === v.pinned, canPin: owner, replies, replyCount: replies.length };
    }));
  }],

  // Pin one top-level comment (or none) on your own video; pinning another one replaces it
  ['POST', /^\/api\/videos\/(\d+)\/pin$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'pin comments');
    limit(req, 'pin', 60, 600e3, uid);
    const v = ownVideo(uid, +m[1]), b = await readJson(req);
    if (b.comment !== null && !Number.isInteger(b.comment)) throw fail(400, 'comment must be a comment id or null.');
    if (b.comment !== null) {
      const c = db.prepare('SELECT parent FROM comments WHERE id=? AND video=?').get(b.comment, v.id);
      if (!c) throw fail(404, 'Comment not found.');
      if (c.parent) throw fail(400, 'Only a top-level comment can be pinned.');
    }
    db.prepare('UPDATE videos SET pinned=? WHERE id=?').run(b.comment, v.id);
    json(res, 200, { pinned: b.comment });
  }],

  ['POST', /^\/api\/videos\/(\d+)\/comments$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'comment');
    limit(req, 'comment', 40);
    limit(req, 'comment-acct', 30, 600e3, uid);
    const v = video(uid, +m[1]);
    needNoBlock(uid, v.owner);
    if (v.comments_off) throw Object.assign(fail(403, 'Comments are turned off for this video.'), { commentsOff: true });
    if (!visibleTo(v, uid)) throw fail(404, 'Video not found.');
    const b = await readJson(req), t = text(b.text, 300);
    if (!t) throw fail(400, 'Write a comment first.');
    // A reply: its parent must be a top-level comment on this same video, by someone you're not blocked with
    let parent = null;
    if (b.parent !== undefined && b.parent !== null) {
      if (!Number.isInteger(b.parent) || b.parent < 1) throw fail(400, 'Invalid comment to reply to.');
      const p = db.prepare('SELECT id, uid, video, parent FROM comments WHERE id=?').get(b.parent);
      if (!p || p.video !== v.id) throw fail(404, 'The comment you replied to no longer exists.');
      if (p.parent) throw fail(400, 'You can only reply to a top-level comment.');
      needNoBlock(uid, p.uid);
      parent = p.id;
    }
    const u = ensureUser(uid);
    const { lastInsertRowid } = db.prepare('INSERT INTO comments(video,uid,text,created,parent) VALUES(?,?,?,?,?)').run(v.id, uid, t, Date.now(), parent);
    const cid = Number(lastInsertRowid);
    pushComment(cid);
    json(res, 201, {
      comment: { id: cid, parent, text: t, created: Date.now(), edited: null, name: u.name, avatar: u.avatar ? '/avatars/' + u.avatar : null, likes: 0, liked: false, mine: true, canEdit: true, canDelete: true, canReport: false, reported: false, ...(parent ? {} : { pinned: false, canPin: v.owner === uid, replies: [], replyCount: 0 }) },
      comments: q.ncom.get(v.id).n,
    });
  }],

  // Like / unlike a comment (logged-in accounts only)
  ['POST', /^\/api\/comments\/(\d+)\/like$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'like comments');
    limit(req, 'clike', 300, 600e3, uid);
    const c = db.prepare('SELECT c.id, c.uid, v.owner, v.comments_off, v.hidden, v.created FROM comments c JOIN videos v ON v.id=c.video WHERE c.id=?').get(+m[1]);
    if (!c || !canSee(c, uid)) throw fail(404, 'Comment not found.');
    if (c.comments_off) throw Object.assign(fail(403, 'Comments are turned off for this video.'), { commentsOff: true });
    needNoBlock(uid, c.uid); needNoBlock(uid, c.owner);
    const del = db.prepare('DELETE FROM comment_likes WHERE comment=? AND uid=?').run(c.id, uid).changes;
    if (!del) db.prepare('INSERT INTO comment_likes(comment,uid,created) VALUES(?,?,?)').run(c.id, uid, Date.now());
    json(res, 200, { liked: !del, likes: db.prepare('SELECT COUNT(*) n FROM comment_likes WHERE comment=?').get(c.id).n });
  }],

  // Only the person who wrote a comment can edit it
  ['PATCH', /^\/api\/comments\/(\d+)$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'edit comments');
    limit(req, 'cedit', 60, 600e3, uid);
    const c = db.prepare('SELECT c.id, c.uid, v.comments_off FROM comments c JOIN videos v ON v.id=c.video WHERE c.id=?').get(+m[1]);
    if (!c) throw fail(404, 'Comment not found.');
    if (c.uid !== uid) throw fail(403, 'You can only edit your own comments.');
    if (c.comments_off) throw Object.assign(fail(403, 'Comments are turned off for this video.'), { commentsOff: true });
    const t = text((await readJson(req)).text, 300);
    if (!t) throw fail(400, 'A comment can’t be empty.');
    const now = Date.now();
    db.prepare('UPDATE comments SET text=?, edited=? WHERE id=?').run(t, now, c.id);
    json(res, 200, { id: c.id, text: t, edited: now });
  }],

  ['DELETE', /^\/api\/comments\/(\d+)$/, ({ res, uid, m }) => {
    need(uid);
    const c = db.prepare('SELECT c.id, c.uid, c.video, v.owner FROM comments c JOIN videos v ON v.id=c.video WHERE c.id=?').get(+m[1]);
    if (!c) throw fail(404, 'Comment not found.');
    if (c.uid !== uid && c.owner !== uid) throw fail(403, 'You can only delete your own comments.');
    // Deleting a top-level comment also deletes its replies
    db.exec('BEGIN');
    try { removeComment(c.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    json(res, 200, { comments: q.ncom.get(c.video).n });
  }],

  // Report a comment: confirmed accounts only, once per person, rate-limited. Goes to the admin queue; never auto-deleted.
  ['POST', /^\/api\/comments\/(\d+)\/report$/, async ({ req, res, uid, verified, m }) => {
    needVerified(uid, verified, 'report comments');
    limit(req, 'creport', 60, 3600e3);
    limit(req, 'creport-acct', 20, 3600e3, uid);
    // You can still report someone you blocked, but not on a video you can't see
    const c = db.prepare('SELECT c.id, c.uid, v.owner, v.hidden, v.created FROM comments c JOIN videos v ON v.id=c.video WHERE c.id=?').get(+m[1]);
    if (!c || !canSee(c, uid)) throw fail(404, 'Comment not found.');
    if (c.uid === uid) throw fail(400, "You can't report your own comment.");
    const b = await readJson(req);
    const added = db.prepare('INSERT OR IGNORE INTO comment_reports(comment,uid,reason,created) VALUES(?,?,?,?)')
      .run(c.id, uid, REASONS.includes(b.reason) ? b.reason : 'Other', Date.now()).changes;
    json(res, 200, { ok: true, alreadyReported: !added });
  }],

  // Reports need a confirmed account and only go to the admin queue; they never hide a video by themselves
  ['POST', /^\/api\/videos\/(\d+)\/report$/, async ({ req, res, uid, verified, m }) => {
    needVerified(uid, verified, 'report videos');
    limit(req, 'report', 60, 3600e3);
    limit(req, 'report-acct', 20, 3600e3, uid);
    const v = video(uid, +m[1]), b = await readJson(req);
    if (!canSee(v, uid)) throw fail(404, 'Video not found.'); // blocked people can still be reported
    if (v.owner === uid) throw fail(400, "You can't report your own video.");
    db.prepare('INSERT OR IGNORE INTO reports(video,uid,reason,created) VALUES(?,?,?,?)')
      .run(v.id, uid, REASONS.includes(b.reason) ? b.reason : 'Other', Date.now());
    json(res, 200, { ok: true });
  }],

  ['GET', /^\/api\/me$/, ({ res, uid, email }) => json(res, 200, meOut(uid, email))],

  // Activity on your content: new followers, comments and likes from others, plus your own uploads going live
  ['GET', /^\/api\/notifications$/, ({ res, uid }) => {
    // Notifications are for accounts only; guests quietly get an empty list
    if (!uid || !uid.startsWith('sb_')) return json(res, 200, { items: [], unread: 0 });
    const seen = (getUser.get(uid) || {}).seen || 0;
    // Built from activity when read: nothing from people across a block, and nothing of a type while it is switched off
    const rows = [
      ...db.prepare(`SELECT 'follow' type, f.created, u.name, u.avatar,
          EXISTS(SELECT 1 FROM follows g WHERE g.follower=? AND g.followee=f.follower) back
        FROM follows f LEFT JOIN users u ON u.uid=f.follower
        WHERE f.followee=? AND f.follower<>? AND ${notBlocked('?', 'f.follower')} ORDER BY f.created DESC LIMIT 50`).all(uid, uid, uid, uid, uid),
      // comments on your videos; a reply to your own comment shows once, as a reply (below)
      ...db.prepare(`SELECT 'comment' type, c.created, c.text, u.name, u.avatar, v.id vid, v.title, v.thumb, v.emoji, v.hidden vh, v.created vc
        FROM comments c JOIN videos v ON v.id=c.video LEFT JOIN users u ON u.uid=c.uid
        WHERE v.owner=$me AND c.uid<>$me AND ${notBlocked('$me', 'c.uid')}
          AND NOT EXISTS(SELECT 1 FROM comments p WHERE p.id=c.parent AND p.uid=$me) ORDER BY c.created DESC LIMIT 50`).all({ me: uid }),
      // replies to your comments, on videos you can still see
      ...db.prepare(`SELECT 'reply' type, c.created, c.text, u.name, u.avatar, v.id vid, v.title, v.thumb, v.emoji, v.hidden vh, v.created vc
        FROM comments c JOIN comments p ON p.id=c.parent JOIN videos v ON v.id=c.video LEFT JOIN users u ON u.uid=c.uid
        WHERE p.uid=$me AND c.uid<>$me AND ${notBlocked('$me', 'c.uid')} AND ${notBlocked('$me', 'v.owner')}
          AND (v.owner=$me OR (v.hidden=0 AND v.created<=$now)) ORDER BY c.created DESC LIMIT 50`).all({ me: uid, now: Date.now() }),
      ...db.prepare(`SELECT 'like' type, l.created, u.name, u.avatar, v.id vid, v.title, v.thumb, v.emoji, v.hidden vh, v.created vc
        FROM likes l JOIN videos v ON v.id=l.video LEFT JOIN users u ON u.uid=l.uid
        WHERE v.owner=? AND l.uid<>? AND l.created IS NOT NULL AND ${notBlocked('?', 'l.uid')} ORDER BY l.created DESC LIMIT 50`).all(uid, uid, uid, uid),
      ...db.prepare(`SELECT 'upload' type, created, id vid, title, thumb, emoji, hidden vh, created vc
        FROM videos WHERE owner=? AND created <= ? AND pending=0 ORDER BY created DESC LIMIT 20`).all(uid, Date.now()),
      // collaboration invitations to you (with their current answer) and answers to your invitations
      ...db.prepare(`SELECT 'collab' type, c.invited created, c.status, u.name, u.avatar, v.id vid, v.title, v.thumb, v.emoji, v.hidden vh, v.created vc
        FROM collabs c JOIN videos v ON v.id=c.video LEFT JOIN users u ON u.uid=v.owner
        WHERE c.uid=$me AND ${notBlocked('$me', 'v.owner')} ORDER BY c.invited DESC LIMIT 50`).all({ me: uid }),
      ...db.prepare(`SELECT 'collabres' type, c.responded created, c.status, u.name, u.avatar, v.id vid, v.title, v.thumb, v.emoji, v.hidden vh, v.created vc
        FROM collabs c JOIN videos v ON v.id=c.video LEFT JOIN users u ON u.uid=c.uid
        WHERE v.owner=$me AND c.responded IS NOT NULL AND ${notBlocked('$me', 'c.uid')} ORDER BY c.responded DESC LIMIT 50`).all({ me: uid }),
    ];
    const mutes = db.prepare('SELECT type, start, stop FROM notif_mutes WHERE uid=?').all(uid);
    const pref = t => t === 'collabres' ? 'collab' : t;
    const muted = n => mutes.some(x => (x.type === pref(n.type) || x.type === 'all') && n.created >= x.start && (x.stop === null || n.created < x.stop));
    const items = rows.filter(n => !muted(n)).sort((a, b) => b.created - a.created).slice(0, 80).map(n => ({
      type: n.type, created: n.created, unread: n.created > seen,
      name: n.name || null, avatar: n.avatar ? '/avatars/' + n.avatar : null, followBack: n.type === 'follow' ? !!n.back : undefined,
      text: n.text, video: n.vid, title: n.title, emoji: n.emoji,
      // a collaboration on a video that isn't public yet shows no thumbnail (its signed link is only for the owner)
      thumb: (n.type === 'collab' && (n.vh || n.vc > Date.now())) ? null : mediaUrl('thumbs', n.thumb, { hidden: n.vh, created: n.vc }),
      status: n.status,
    }));
    json(res, 200, { items, unread: items.filter(i => i.unread).length });
  }],

  // Creator dashboard: your own videos only (a collaboration counts for its owner). Numbers count other people only.
  // range = 1 / 7 / 28 / 365 days; the chart groups by hour (24 h), day (7 days), day or week (28 days), or month or
  // week (365 days), in the viewer's time zone (tz = getTimezoneOffset() minutes). Older fields are unchanged.
  ['GET', /^\/api\/dashboard$/, ({ res, uid, url }) => {
    needAccount(uid, 'see your dashboard');
    const now = Date.now(), p = url.searchParams;
    const range = [1, 7, 28, 365].includes(+p.get('range')) ? +p.get('range') : 28, since = now - range * 864e5;
    const tz = Math.max(-840, Math.min(840, Number(p.get('tz')) || 0));
    const GROUPS = { 1: ['hour'], 7: ['day'], 28: ['day', 'week'], 365: ['month', 'week'] };
    const unit = p.has('group') ? p.get('group') : GROUPS[range][0];
    if (!GROUPS[range].includes(unit)) throw fail(400, `For this range the chart can be grouped by ${GROUPS[range].join(' or ')}.`);
    const one = (sql, a) => dq(sql).get(a).n || 0, A = { me: uid, since, now };
    // chart buckets
    const dayOf = t => Math.floor((t - tz * 60e3) / 864e5);
    const K = {
      hour: [t => Math.floor(t / 36e5), k => k * 36e5],
      day: [dayOf, k => k * 864e5 + tz * 60e3],
      week: [t => Math.floor((dayOf(t) + 3) / 7), k => (k * 7 - 3) * 864e5 + tz * 60e3], // weeks start on Monday
      month: [t => { const d = new Date(t - tz * 60e3); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }, k => Date.UTC(Math.floor(k / 12), k % 12, 1) + tz * 60e3],
    }, [key, tOf] = K[unit];
    const last = key(now), first = unit === 'hour' ? last - 23 : unit === 'day' ? last - range + 1 : unit === 'month' ? last - 11 : key(since);
    const buckets = [];
    for (let k = first; k <= last; k++) buckets.push({ t: tOf(k), views: 0, watch: 0, followers: 0, likes: 0, comments: 0 });
    const add = (rows, f) => rows.forEach(r => { const i = key(r.c) - first; if (i >= 0 && i < buckets.length) buckets[i][f] += r.n === undefined ? 1 : r.n; });
    const viewRows = dq('SELECT vw.created c FROM views vw JOIN videos v ON v.id=vw.video WHERE v.owner=$me AND vw.uid<>$me AND vw.created>=$since').all(A);
    const likeRows = dq('SELECT l.created c FROM likes l JOIN videos v ON v.id=l.video WHERE v.owner=$me AND l.uid<>$me AND l.created>=$since').all(A);
    const comRows = dq('SELECT c.created c FROM comments c JOIN videos v ON v.id=c.video WHERE v.owner=$me AND c.uid<>$me AND c.created>=$since').all(A);
    const folRows = dq('SELECT created c FROM follows WHERE followee=$me AND created>=$since').all(A);
    const watchRows = dq('SELECT w.at c, w.seconds n FROM watch w JOIN videos v ON v.id=w.video WHERE v.owner=$me AND w.viewer<>$me AND w.at>=$since').all(A);
    add(viewRows, 'views'); add(likeRows, 'likes'); add(comRows, 'comments'); add(folRows, 'followers'); add(watchRows, 'watch');
    buckets.forEach(b => { b.watch = Math.round(b.watch); });
    // watch time per (video, viewer) pair in the period: average and how many reached the end
    const w = dq(`SELECT COUNT(*) pairs, SUM(s) secs, SUM(d) done FROM (SELECT SUM(w.seconds) s, MAX(w.completed) d FROM watch w
      JOIN videos v ON v.id=w.video WHERE v.owner=$me AND w.viewer<>$me AND w.at>=$since GROUP BY w.video, w.viewer)`).get(A);
    const views = viewRows.length, likes = likeRows.length, comments = comRows.length, r1 = x => Math.round(x * 10) / 10;
    const top = dq('SELECT id, slug, title, views, likes, thumb, emoji, hidden, created FROM videos WHERE owner=? AND created<=? ORDER BY views DESC, likes DESC LIMIT 10').all(uid, now)
      .map(({ hidden, created, ...v }) => ({ ...v, thumb: mediaUrl('thumbs', v.thumb, { hidden, created }) }));
    // best this period: most views in the period
    const best = dq(`SELECT v.id, v.slug, v.title, v.thumb, v.emoji, v.hidden, v.created, COUNT(*) pviews,
        (SELECT COUNT(*) FROM likes l WHERE l.video=v.id AND l.uid<>$me AND l.created>=$since) plikes,
        (SELECT COUNT(*) FROM comments c WHERE c.video=v.id AND c.uid<>$me AND c.created>=$since) pcoms
      FROM views vw JOIN videos v ON v.id=vw.video WHERE v.owner=$me AND vw.uid<>$me AND vw.created>=$since
      GROUP BY v.id ORDER BY pviews DESC, v.id DESC LIMIT 5`).all(A)
      .map(v => ({ id: v.id, slug: v.slug, title: v.title, emoji: v.emoji, thumb: mediaUrl('thumbs', v.thumb, v), created: v.created, views: v.pviews, likes: v.plikes, comments: v.pcoms }));
    json(res, 200, {
      range, unit, groups: GROUPS[range], trackingSince: TRACKING_SINCE,
      period: {
        videos: one('SELECT COUNT(*) n FROM videos WHERE owner=$me AND created>=$since AND created<=$now', A),
        views, likes, comments,
        followers: folRows.length,
        // different accounts (guests: networks) who started at least one of your videos in the period
        uniqueViewers: one('SELECT COUNT(DISTINCT vw.uid) n FROM views vw JOIN videos v ON v.id=vw.video WHERE v.owner=$me AND vw.uid<>$me AND vw.created>=$since', A),
        // (likes + comments) per 100 views in the period
        engagement: views ? r1((likes + comments) / views * 100) : null,
        watchSeconds: Math.round(w.secs || 0), watched: w.pairs,
        avgWatch: w.pairs ? r1(w.secs / w.pairs) : null,
        completion: w.pairs ? r1(w.done / w.pairs * 100) : null,
      },
      total: {
        likes: one('SELECT SUM(likes) n FROM videos WHERE owner=$me', A),
        views: one('SELECT COUNT(*) n FROM views vw JOIN videos v ON v.id=vw.video WHERE v.owner=$me AND vw.uid<>$me', A), // other people's views, same rule as the period count
        comments: one('SELECT COUNT(*) n FROM comments c JOIN videos v ON v.id=c.video WHERE v.owner=$me AND c.uid<>$me', A),
        followers: countFollowers.get(uid).n,
        videos: one('SELECT COUNT(*) n FROM videos WHERE owner=$me AND created<=$now', A),
        scheduled: one('SELECT COUNT(*) n FROM videos WHERE owner=$me AND created>$now', A),
      },
      buckets, top, best,
    });
  }],

  // Per-video performance for the period, sorted and paged on the server (10 per page by default, at most 50)
  ['GET', /^\/api\/dashboard\/videos$/, ({ res, uid, url }) => {
    needAccount(uid, 'see your dashboard');
    const p = url.searchParams, now = Date.now();
    const range = [1, 7, 28, 365].includes(+p.get('range')) ? +p.get('range') : 28, since = now - range * 864e5;
    const SORTS = { views: 'pviews DESC', likes: 'plikes DESC', comments: 'pcoms DESC', watch: 'avgw DESC', completion: 'compl DESC', first7: 'first7 DESC', total: 'tviews DESC', published: 'v.created DESC' };
    const sort = p.get('sort') || 'views';
    if (!Object.hasOwn(SORTS, sort)) throw fail(400, `sort must be one of: ${Object.keys(SORTS).join(', ')}.`);
    const lim = p.has('limit') ? Number(p.get('limit')) : 10, page = p.has('page') ? Number(p.get('page')) : 1;
    if (!Number.isInteger(lim) || lim < 1 || lim > 50) throw fail(400, 'limit must be 1 to 50.');
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw fail(400, 'Invalid page.');
    const A = { me: uid, since, now };
    const total = dq('SELECT COUNT(*) n FROM videos WHERE owner=$me AND created<=$now').get(A).n;
    const rows = dq(`SELECT v.id, v.slug, v.title, v.thumb, v.emoji, v.hidden, v.pending, v.created, v.duration,
        (SELECT COUNT(*) FROM views x WHERE x.video=v.id AND x.uid<>$me) tviews,
        (SELECT COUNT(*) FROM views x WHERE x.video=v.id AND x.uid<>$me AND x.created>=$since) pviews,
        (SELECT COUNT(*) FROM likes x WHERE x.video=v.id AND x.uid<>$me AND x.created>=$since) plikes,
        (SELECT COUNT(*) FROM comments x WHERE x.video=v.id AND x.uid<>$me AND x.created>=$since) pcoms,
        (SELECT COUNT(*) FROM views x WHERE x.video=v.id AND x.uid<>$me AND x.created>=v.created AND x.created<v.created+604800000) first7,
        (SELECT SUM(s)/COUNT(*) FROM (SELECT SUM(w.seconds) s FROM watch w WHERE w.video=v.id AND w.viewer<>$me AND w.at>=$since GROUP BY w.viewer)) avgw,
        (SELECT AVG(d)*100 FROM (SELECT MAX(w.completed) d FROM watch w WHERE w.video=v.id AND w.viewer<>$me AND w.at>=$since GROUP BY w.viewer)) compl
      FROM videos v WHERE v.owner=$me AND v.created<=$now ORDER BY ${SORTS[sort]}, v.id DESC LIMIT $lim OFFSET $off`).all({ ...A, lim, off: (page - 1) * lim });
    const r1 = x => x === null || x === undefined ? null : Math.round(x * 10) / 10;
    json(res, 200, {
      range, sort, page, limit: lim, total, pages: Math.max(1, Math.ceil(total / lim)),
      items: rows.map(v => ({
        id: v.id, slug: v.slug, title: v.title, emoji: v.emoji, thumb: mediaUrl('thumbs', v.thumb, v), published: v.created || null,
        status: v.pending ? 'review' : v.hidden ? 'hidden' : 'live', duration: v.duration ? r1(v.duration) : null,
        views: v.pviews, likes: v.plikes, comments: v.pcoms, totalViews: v.tviews, first7: v.first7, avgWatch: r1(v.avgw), completion: r1(v.compl),
      })),
    });
  }],

  // Notification settings (in-app only). Turning a type off records when, so activity while it's off never shows;
  // older notifications stay in the history. `muted` (Mute notifications) is separate and leaves the types as they are.
  ['GET', /^\/api\/me\/notification-prefs$/, ({ res, uid }) => {
    needAccount(uid, 'change notification settings');
    json(res, 200, prefsOf(uid));
  }],
  ['POST', /^\/api\/me\/notification-prefs$/, async ({ req, res, uid }) => {
    needAccount(uid, 'change notification settings');
    limit(req, 'nprefs', 60, 600e3, uid);
    const b = await readJson(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'Invalid settings.');
    for (const [k, v] of Object.entries(b)) {
      if (!NTYPES.includes(k) && k !== 'muted') throw fail(400, `Unknown notification type: ${String(k).slice(0, 20)}`);
      if (typeof v !== 'boolean') throw fail(400, 'Each setting must be true or false.');
    }
    const now = Date.now();
    db.exec('BEGIN');
    try {
      // muted is stored as the type 'all' being off
      for (const [k, on] of Object.entries(b).map(([k, v]) => k === 'muted' ? ['all', !v] : [k, v])) {
        const cur = db.prepare('SELECT enabled FROM notif_prefs WHERE uid=? AND type=?').get(uid, k), was = cur ? !!cur.enabled : true;
        db.prepare('INSERT INTO notif_prefs(uid,type,enabled,updated) VALUES(?,?,?,?) ON CONFLICT(uid,type) DO UPDATE SET enabled=excluded.enabled, updated=excluded.updated').run(uid, k, on ? 1 : 0, now);
        if (was && !on) db.prepare('INSERT INTO notif_mutes(uid,type,start,stop) VALUES(?,?,?,NULL)').run(uid, k, now);
        if (!was && on) db.prepare('UPDATE notif_mutes SET stop=? WHERE uid=? AND type=? AND stop IS NULL').run(now, uid, k);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    json(res, 200, prefsOf(uid));
  }],

  // Watch history (accounts only, newest first, 20 at a time) and Continue watching
  ['GET', /^\/api\/history$/, ({ res, uid, url }) => {
    needAccount(uid, 'see your watch history');
    const lim = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
    const before = Number(url.searchParams.get('before')) || 8.64e15;
    const rows = db.prepare(`SELECT h.last_at, h.position hpos, h.duration hdur, h.completed hdone, x.* FROM watch_history h
      JOIN (${VSEL}) x ON x.id=h.video WHERE h.uid=$me AND h.last_at < $before ORDER BY h.last_at DESC LIMIT $lim`).all({ me: uid, before, lim });
    const items = rows.map(r => visibleTo(r, uid)
      ? { ...out(r, uid), available: true, watchedAt: r.last_at, position: r.hpos, duration: r.hdur, completed: !!r.hdone }
      : { id: r.id, available: false, watchedAt: r.last_at });
    json(res, 200, { items, next: rows.length === lim ? rows[rows.length - 1].last_at : null });
  }],
  ['GET', /^\/api\/history\/continue$/, ({ res, uid }) => {
    needAccount(uid, 'see your watch history');
    const rows = db.prepare(`SELECT h.last_at, h.position hpos, h.duration hdur, x.* FROM watch_history h JOIN (${VSEL}) x ON x.id=h.video
      WHERE h.uid=$me AND h.completed=0 AND h.position >= 3 ORDER BY h.last_at DESC LIMIT 24`).all({ me: uid });
    json(res, 200, rows.filter(r => visibleTo(r, uid)).slice(0, 12)
      .map(r => ({ ...out(r, uid), watchedAt: r.last_at, position: r.hpos, duration: r.hdur })));
  }],
  ['DELETE', /^\/api\/history$/, ({ res, uid }) => {
    needAccount(uid, 'clear your watch history');
    json(res, 200, { removed: db.prepare('DELETE FROM watch_history WHERE uid=?').run(uid).changes });
  }],
  ['DELETE', /^\/api\/history\/(\d+)$/, ({ res, uid, m }) => {
    needAccount(uid, 'change your watch history');
    json(res, 200, { removed: db.prepare('DELETE FROM watch_history WHERE uid=? AND video=?').run(uid, +m[1]).changes });
  }],
  // "Remove from Continue watching": keeps it in history, forgets the position
  ['DELETE', /^\/api\/history\/(\d+)\/progress$/, ({ res, uid, m }) => {
    needAccount(uid, 'change your watch history');
    db.prepare('UPDATE watch_history SET position=0 WHERE uid=? AND video=?').run(uid, +m[1]);
    json(res, 200, { ok: true });
  }],
  // Save where you are in a video (sent every ~10 s while playing, and on pause / end / leaving). Never counts a view.
  ['POST', /^\/api\/videos\/(\d+)\/progress$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'save your place');
    limit(req, 'progress', 400, 600e3, uid);
    const v = video(uid, +m[1]);
    if (!visibleTo(v, uid)) throw fail(404, 'Video not found.');
    const b = await readJson(req), pos = Number(b.position), dur = Number(b.duration);
    if (typeof b.position !== 'number' || typeof b.duration !== 'number' || !Number.isFinite(pos) || !Number.isFinite(dur)) throw fail(400, 'Position and duration must be numbers.');
    if (dur <= 0 || dur > 4 * 3600) throw fail(400, 'Invalid duration.');
    if (pos < 0 || pos > dur + 5) throw fail(400, 'Invalid position.');
    const p = Math.min(pos, dur);
    // Finished = it ended, or less than 5% (at least 1.5 s) was left
    const done = b.ended === true || dur - p <= Math.max(1.5, dur * 0.05);
    const now = Date.now(), cur = db.prepare('SELECT last_at, position, completed FROM watch_history WHERE uid=? AND video=?').get(uid, v.id);
    // the same update again within 2 s is skipped (no extra write)
    if (cur && now - cur.last_at < 2000 && Math.abs(cur.position - p) < 1 && !!cur.completed === done) return json(res, 200, { position: cur.position, completed: !!cur.completed, skipped: true });
    db.prepare(`INSERT INTO watch_history(uid,video,first_at,last_at,position,duration,completed) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(uid,video) DO UPDATE SET last_at=excluded.last_at, position=excluded.position, duration=excluded.duration, completed=excluded.completed`)
      .run(uid, v.id, now, now, done ? 0 : p, dur, done ? 1 : 0);
    json(res, 200, { position: done ? 0 : p, completed: done });
  }],

  ['POST', /^\/api\/notifications\/seen$/, ({ res, uid }) => {
    need(uid);
    ensureUser(uid);
    db.prepare('UPDATE users SET seen=? WHERE uid=?').run(Date.now(), uid);
    json(res, 200, { unread: 0 });
  }],

  ['POST', /^\/api\/me$/, async ({ req, res, uid, email }) => {
    needAccount(uid, 'edit your profile');
    limit(req, 'profile', 60, 600e3, uid);
    const b = await readJson(req);
    ensureUser(uid);
    if ('name' in b) setName(uid, b.name);
    if ('bio' in b) db.prepare('UPDATE users SET bio=? WHERE uid=?').run(text(b.bio, 120), uid);
    if ('links' in b) db.prepare('UPDATE users SET links=? WHERE uid=?').run(JSON.stringify(cleanLinks(b.links)), uid);
    if ('fullName' in b) db.prepare('UPDATE users SET fullname=? WHERE uid=?').run(text(b.fullName, 50).replace(/\s+/g, ' '), uid);
    json(res, 200, meOut(uid, email));
  }],

  ['POST', /^\/api\/me\/avatar$/, async ({ req, res, uid, email }) => {
    needAccount(uid, 'change your photo');
    limit(req, 'avatar', 30, 3600e3, uid);
    const type = ctype(req);
    if (!IMG[type]) throw fail(415, 'Only JPG, PNG or WebP photos are allowed.');
    if (+req.headers['content-length'] > AVMAX) throw fail(413, 'Photo must be under 2 MB.');
    needDisk(AVMAX + inflightAll);
    const old = ensureUser(uid), file = await saveImage(req, DIRS.avatars, AVMAX, 'Photo must be under 2 MB.');
    db.prepare('UPDATE users SET avatar=? WHERE uid=?').run(file, uid);
    rm(DIRS.avatars, old.avatar);
    json(res, 200, meOut(uid, email));
  }],

  ['DELETE', /^\/api\/me\/avatar$/, ({ res, uid, email }) => {
    needAccount(uid, 'change your photo');
    const u = getUser.get(uid);
    if (u && u.avatar) { db.prepare('UPDATE users SET avatar=NULL WHERE uid=?').run(uid); rm(DIRS.avatars, u.avatar); }
    json(res, 200, meOut(uid, email));
  }],

  ['GET', /^\/api\/config$/, ({ res }) => json(res, 200, { login: !!(SB_URL && SB_KEY), supabaseKey: SB_KEY })],

  // Called right after a Supabase login/sign-up: moves this browser's videos, likes etc. into the account
  ['POST', /^\/api\/link$/, async ({ req, res, uid, anon, email }) => {
    if (!uid.startsWith('sb_')) throw fail(401, 'Please log in first.');
    limit(req, 'link', 30, 600e3);
    const b = await readJson(req);
    // Without the guest's secret (new-style ids) nothing is moved; the login itself still works
    const linked = !!anon && guestOwned(anon, req.headers['x-guest-key']);
    if (linked) merge(anon, uid);
    ensureUser(uid); // random default like user48213; never derived from the email address
    if (b.name) setName(uid, b.name);
    json(res, 200, { ...meOut(uid, email), guestLinked: linked });
  }],

  // Without `limit` all of the creator's videos come back, as the app expects. With ?limit=1..100 (and &before=<cursor>
  // from the X-Next-Before header) they come in pages; `likes` is always the total.
  ['GET', /^\/api\/users\/([^/]+)$/, ({ res, uid, m, url }) => {
    const u = userByName(m[1]), p = url.searchParams;
    // Across a block the profile shows no videos, and the page says why
    const iBlocked = !!uid && !!db.prepare('SELECT 1 FROM blocks WHERE blocker=? AND blocked=?').get(uid, u.uid);
    const blockedMe = !!uid && !!db.prepare('SELECT 1 FROM blocks WHERE blocker=? AND blocked=?').get(u.uid, uid);
    const args = { me: uid, owner: u.uid, now: Date.now() };
    let rows = [], likes = 0;
    if (!iBlocked && !blockedMe) {
      if (p.has('limit')) {
        const lim = Math.floor(Number(p.get('limit')));
        if (!(lim >= 1 && lim <= 100)) throw fail(400, 'limit must be 1 to 100.');
        const cur = /^(\d{1,15})_(\d{1,15})$/.exec(p.get('before') || '');
        if (p.has('before') && !cur) throw fail(400, 'Invalid cursor.');
        rows = q.byOwnerPage.all({ ...args, lim, bc: cur ? +cur[1] : 8.64e15, bid: cur ? +cur[2] : 0 });
        const last = rows[rows.length - 1];
        if (rows.length === lim && last) res.setHeader('X-Next-Before', `${last.created}_${last.id}`);
        likes = q.ownerLikes.get(args).n || 0;
      } else {
        rows = q.byOwner.all(args);
        likes = rows.reduce((s, v) => s + (v.owner === u.uid ? v.likes : 0), 0); // their own videos only
      }
    }
    const vids = outAll(rows, uid);
    json(res, 200, {
      name: u.name, fullName: u.fullname || '', bio: u.bio, links: linksOf(u), avatar: u.avatar ? '/avatars/' + u.avatar : null, me: !!uid && u.uid === uid,
      followers: countFollowers.get(u.uid).n, following: countFollowing.get(u.uid).n,
      isFollowing: !!uid && !!db.prepare('SELECT 1 FROM follows WHERE follower=? AND followee=?').get(uid, u.uid),
      likes, videos: vids, blocked: iBlocked, blockedBy: blockedMe,
    });
  }],

  // Follow / unfollow (toggle): accounts only. The (follower, followee) primary key prevents duplicates.
  ['POST', /^\/api\/users\/([^/]+)\/follow$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'follow people');
    limit(req, 'follow', 120, 3600e3, uid);
    const u = userByName(m[1]);
    if (u.uid === uid) throw fail(400, "You can't follow yourself.");
    if (blockedBetween(uid, u.uid)) throw Object.assign(fail(403, "You can't follow this account because of a block."), { blocked: true });
    const del = db.prepare('DELETE FROM follows WHERE follower=? AND followee=?').run(uid, u.uid).changes;
    if (!del) { db.prepare('INSERT INTO follows(follower,followee,created) VALUES(?,?,?)').run(uid, u.uid, Date.now()); pushFollow(uid, u.uid); }
    json(res, 200, { following: !del, followers: countFollowers.get(u.uid).n });
  }],

  // Remove someone from your followers. They aren't told and can follow again later (block to stop that).
  // Addressed by the follow row's id (from your own followers list), so followers without a username can be removed too.
  ['DELETE', /^\/api\/me\/followers\/(\d+)$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'remove followers');
    limit(req, 'follow', 120, 3600e3, uid);
    // Only a follow of you matches; anyone else's id (or an unknown one) is simply "not found"
    if (!db.prepare('DELETE FROM follows WHERE rowid=? AND followee=?').run(+m[1], uid).changes) throw fail(404, 'Follower not found.');
    json(res, 200, { removed: true, followers: countFollowers.get(uid).n });
  }],

  // ----- web push subscriptions (one per device; accounts only) -----
  ['GET', /^\/api\/push\/config$/, ({ res }) => json(res, 200, { publicKey: VAPID.pub })],
  ['GET', /^\/api\/me\/push$/, ({ res, uid }) => {
    needAccount(uid, 'use push notifications');
    json(res, 200, { devices: db.prepare('SELECT COUNT(*) n FROM push_subs WHERE uid=?').get(uid).n });
  }],
  ['POST', /^\/api\/push\/subscribe$/, async ({ req, res, uid }) => {
    needAccount(uid, 'turn on push notifications');
    limit(req, 'push-sub', 30, 3600e3, uid);
    const b = await readJson(req), keys = b && b.keys || {};
    if (!pushEndpointOk(b.endpoint)) throw fail(400, 'This push service is not supported.');
    const p256 = b64(keys.p256dh), auth = b64(keys.auth);
    let valid = !!p256 && p256.length === 65 && p256[0] === 4 && !!auth && auth.length === 16;
    if (valid) try { crypto.ECDH.convertKey(p256, 'prime256v1'); } catch { valid = false; } // must be a real P-256 point
    if (!valid) throw fail(400, 'Invalid push subscription keys.');
    const cur = db.prepare('SELECT id, uid, p256dh, auth FROM push_subs WHERE endpoint=?').get(b.endpoint);
    const k1 = p256.toString('base64url'), k2 = auth.toString('base64url');
    if (cur && cur.uid !== uid) {
      // the same browser now logged in to another account (same keys); anything else can't take over a device
      if (cur.p256dh !== k1 || cur.auth !== k2) throw fail(409, 'This device is registered to another account.');
      db.prepare('UPDATE push_subs SET uid=?, created=?, fails=0 WHERE id=?').run(uid, Date.now(), cur.id);
    } else if (cur) db.prepare('UPDATE push_subs SET p256dh=?, auth=?, fails=0 WHERE id=?').run(k1, k2, cur.id);
    else db.prepare('INSERT INTO push_subs(uid,endpoint,p256dh,auth,created) VALUES(?,?,?,?,?)').run(uid, b.endpoint, k1, k2, Date.now());
    // at most 10 devices per account: the oldest go
    db.prepare('DELETE FROM push_subs WHERE uid=? AND id NOT IN (SELECT id FROM push_subs WHERE uid=? ORDER BY created DESC, id DESC LIMIT 10)').run(uid, uid);
    json(res, 200, { ok: true, devices: db.prepare('SELECT COUNT(*) n FROM push_subs WHERE uid=?').get(uid).n });
  }],
  ['DELETE', /^\/api\/push\/subscribe$/, async ({ req, res, uid }) => {
    needAccount(uid, 'turn off push notifications');
    const b = await readJson(req);
    if (typeof b.endpoint !== 'string') throw fail(400, 'endpoint is required.');
    const n = db.prepare('DELETE FROM push_subs WHERE endpoint=? AND uid=?').run(b.endpoint, uid).changes;
    json(res, 200, { removed: n });
  }],

  // ----- collaborations -----
  // The owner invites an existing account; it shows on the video only after they accept. The owner alone edits,
  // schedules and deletes the video. A "no" is kept, so the same person can't be invited to that video again.
  ['GET', /^\/api\/videos\/(\d+)\/collabs$/, ({ res, uid, m }) => {
    const v = video(uid, +m[1]);
    if (v.owner === uid) {
      return json(res, 200, db.prepare(`SELECT u.name, u.fullname, u.avatar, c.status, c.invited, c.responded FROM collabs c JOIN users u ON u.uid=c.uid
        WHERE c.video=? ORDER BY c.invited`).all(v.id).map(c => ({ name: c.name, fullName: c.fullname || '', avatar: c.avatar ? '/avatars/' + c.avatar : null, status: c.status, invited: c.invited, responded: c.responded || null })));
    }
    seeable(uid, v.id);
    json(res, 200, withCollabs([v], uid)[0]._collabs);
  }],
  ['POST', /^\/api\/videos\/(\d+)\/collabs$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'invite collaborators');
    limit(req, 'collab', 30, 3600e3, uid);
    const v = ownVideo(uid, +m[1]), b = await readJson(req);
    if (typeof b.name !== 'string' || !b.name.trim()) throw fail(400, 'Enter a username to invite.');
    const t = userByName(b.name);
    if (t.uid === uid) throw fail(400, "You can't invite yourself.");
    if (!t.uid.startsWith('sb_')) throw fail(400, 'Only Vizo accounts can be invited.');
    if (blockedBetween(uid, t.uid)) throw Object.assign(fail(403, "You can't invite this account because of a block."), { blocked: true });
    const cur = db.prepare('SELECT status FROM collabs WHERE video=? AND uid=?').get(v.id, t.uid);
    if (cur) throw fail(409, cur.status === 'accepted' ? `@${t.name} is already a collaborator.` : cur.status === 'pending' ? `@${t.name} is already invited.` : `@${t.name} declined an invitation to this video.`);
    if (db.prepare("SELECT COUNT(*) n FROM collabs WHERE video=? AND status IN ('pending','accepted')").get(v.id).n >= MAX_COLLABS) throw fail(400, `A video can have up to ${MAX_COLLABS} collaborators (including invitations).`);
    db.prepare("INSERT INTO collabs(video,uid,status,invited) VALUES(?,?,'pending',?)").run(v.id, t.uid, Date.now());
    pushCollab(v.id, t.uid, 'invite');
    json(res, 201, { name: t.name, status: 'pending' });
  }],
  // The owner cancels an invitation or removes a collaborator (a "no" stays on record)
  ['DELETE', /^\/api\/videos\/(\d+)\/collabs\/([^/]+)$/, ({ res, uid, m }) => {
    needAccount(uid, 'change collaborators');
    const v = ownVideo(uid, +m[1]), t = userByName(m[2]);
    if (!db.prepare("DELETE FROM collabs WHERE video=? AND uid=? AND status IN ('pending','accepted')").run(v.id, t.uid).changes) throw fail(404, 'No invitation or collaboration with this account.');
    json(res, 200, { ok: true });
  }],
  // The invited person answers (only their own pending invitation)
  ['POST', /^\/api\/collabs\/(\d+)$/, async ({ req, res, uid, m }) => {
    needAccount(uid, 'answer invitations');
    limit(req, 'collab-answer', 60, 3600e3, uid);
    const b = await readJson(req);
    if (typeof b.accept !== 'boolean') throw fail(400, 'accept must be true or false.');
    const c = db.prepare("SELECT c.video, v.owner FROM collabs c JOIN videos v ON v.id=c.video WHERE c.video=? AND c.uid=? AND c.status='pending'").get(+m[1], uid);
    if (!c) throw fail(404, 'Invitation not found.');
    needNoBlock(uid, c.owner);
    const status = b.accept ? 'accepted' : 'rejected';
    db.prepare('UPDATE collabs SET status=?, responded=? WHERE video=? AND uid=?').run(status, Date.now(), c.video, uid);
    pushCollab(c.video, uid, status);
    json(res, 200, { status });
  }],
  // A collaborator leaves (the video disappears from their profile)
  ['DELETE', /^\/api\/collabs\/(\d+)$/, ({ res, uid, m }) => {
    needAccount(uid, 'leave collaborations');
    if (!db.prepare("DELETE FROM collabs WHERE video=? AND uid=? AND status='accepted'").run(+m[1], uid).changes) throw fail(404, 'You are not a collaborator on this video.');
    json(res, 200, { ok: true });
  }],

  // Who follows a user / who a user follows (newest first). Visitors who never picked a name show as "Guest".
  ['GET', /^\/api\/users\/([^/]+)\/(followers|following)$/, ({ res, uid, m }) => {
    const u = userByName(m[1]), [mine, other] = m[2] === 'followers' ? ['followee', 'follower'] : ['follower', 'followee'];
    const rows = db.prepare(`SELECT f.rowid fid, f.${other} id, x.name, x.fullname, x.avatar,
        EXISTS(SELECT 1 FROM follows g WHERE g.follower=? AND g.followee=f.${other}) isf
      FROM follows f LEFT JOIN users x ON x.uid=f.${other} WHERE f.${mine}=? AND ${notBlocked('?', 'f.' + other)}
      ORDER BY f.created DESC LIMIT 500`).all(uid, u.uid, uid, uid);
    json(res, 200, rows.map(r => ({
      name: r.name || null, fullName: r.fullname || '', avatar: r.avatar ? '/avatars/' + r.avatar : null,
      isFollowing: !!r.isf, me: !!uid && r.id === uid,
      // Only the account being followed gets the id it needs to remove a follower
      fid: m[2] === 'followers' && !!uid && u.uid === uid ? r.fid : undefined,
    })));
  }],

  // Block / unblock (accounts only). Blocking also ends follows both ways; unblocking doesn't bring them back.
  ['POST', /^\/api\/users\/([^/]+)\/block$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'block people');
    limit(req, 'block', 60, 3600e3, uid);
    const u = userByName(m[1]);
    if (u.uid === uid) throw fail(400, "You can't block yourself.");
    db.exec('BEGIN');
    try {
      db.prepare('INSERT OR IGNORE INTO blocks(blocker,blocked,created) VALUES(?,?,?)').run(uid, u.uid, Date.now());
      db.prepare('DELETE FROM follows WHERE (follower=? AND followee=?) OR (follower=? AND followee=?)').run(uid, u.uid, u.uid, uid);
      endCollabsBetween(uid, u.uid);
      // their comment no longer stays pinned on the blocker's videos
      db.prepare('UPDATE videos SET pinned=NULL WHERE owner=? AND pinned IN (SELECT id FROM comments WHERE uid=?)').run(uid, u.uid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    json(res, 200, { blocked: true });
  }],
  ['DELETE', /^\/api\/users\/([^/]+)\/block$/, ({ req, res, uid, m }) => {
    needAccount(uid, 'unblock people');
    limit(req, 'block', 60, 3600e3, uid);
    const u = userByName(m[1]);
    db.prepare('DELETE FROM blocks WHERE blocker=? AND blocked=?').run(uid, u.uid);
    json(res, 200, { blocked: false });
  }],
  ['GET', /^\/api\/blocks$/, ({ res, uid }) => {
    needAccount(uid, 'see blocked accounts');
    json(res, 200, db.prepare(`SELECT u.name, u.fullname, u.avatar, b.created FROM blocks b JOIN users u ON u.uid=b.blocked
      WHERE b.blocker=? ORDER BY b.created DESC LIMIT 500`).all(uid)
      .map(r => ({ name: r.name, fullName: r.fullname || '', avatar: r.avatar ? '/avatars/' + r.avatar : null, since: r.created })));
  }],

  // ----- admin (needs X-Admin-Key) -----
  ['GET', /^\/api\/admin\/comment-reports$/, ({ req, res }) => {
    needAdmin(req);
    const rows = db.prepare(`SELECT c.id, c.text, c.video vid, v.title, u.name, COUNT(r.uid) n, GROUP_CONCAT(r.reason, '|') reasons, MAX(r.created) last
      FROM comment_reports r JOIN comments c ON c.id=r.comment JOIN videos v ON v.id=c.video LEFT JOIN users u ON u.uid=c.uid
      GROUP BY c.id ORDER BY n DESC, last DESC LIMIT 200`).all();
    json(res, 200, rows.map(r => ({ id: r.id, text: r.text, video: r.vid, title: r.title, name: r.name, reports: r.n, last: r.last,
      reasons: r.reasons.split('|').reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {}) })));
  }],
  ['POST', /^\/api\/admin\/comments\/(\d+)\/dismiss$/, ({ req, res, m }) => {
    needAdmin(req);
    db.prepare('DELETE FROM comment_reports WHERE comment=?').run(+m[1]);
    json(res, 200, { ok: true });
  }],
  ['DELETE', /^\/api\/admin\/comments\/(\d+)$/, ({ req, res, m }) => {
    needAdmin(req);
    db.exec('BEGIN');
    let vid;
    try { vid = removeComment(+m[1]); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (!vid) throw fail(404, 'Comment not found.');
    json(res, 200, { ok: true });
  }],
  ['GET', /^\/api\/admin\/reports$/, ({ req, res }) => {
    needAdmin(req);
    // Reported videos, plus videos waiting for a safety review (uploaded without a passed safety check)
    const rows = db.prepare(`SELECT v.id, v.title, v.file, v.thumb, v.emoji, v.hidden, v.pending, v.scan, v.created, u.name, COUNT(r.uid) n,
      GROUP_CONCAT(r.reason, '|') reasons, COALESCE(MAX(r.created), v.created) last
      FROM videos v LEFT JOIN reports r ON r.video=v.id LEFT JOIN users u ON u.uid=v.owner
      WHERE v.pending=1 OR r.video IS NOT NULL
      GROUP BY v.id ORDER BY v.pending DESC, n DESC, last DESC`).all();
    json(res, 200, rows.map(r => ({
      id: r.id, title: r.title, name: r.name, emoji: r.emoji, reports: r.n, last: r.last, hidden: !!r.hidden, pending: !!r.pending, scan: r.scan || null,
      src: mediaUrl('uploads', r.file, r), thumb: mediaUrl('thumbs', r.thumb, r),
      reasons: (r.reasons ? r.reasons.split('|') : []).reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {}),
    })));
  }],
  // Keep: clear the reports and show the video again
  ['POST', /^\/api\/admin\/videos\/(\d+)\/dismiss$/, ({ req, res, m }) => {
    needAdmin(req);
    const was = db.prepare('SELECT id, owner, title, slug, created, pending FROM videos WHERE id=?').get(+m[1]);
    db.prepare('DELETE FROM reports WHERE video=?').run(+m[1]);
    db.prepare('UPDATE videos SET hidden=0, pending=0 WHERE id=?').run(+m[1]);
    if (was && was.pending) pushApproved(was);
    json(res, 200, { ok: true });
  }],
  // Hide / show a video while reviewing it (only an admin can hide videos)
  ['POST', /^\/api\/admin\/videos\/(\d+)\/hide$/, async ({ req, res, m }) => {
    needAdmin(req);
    const b = await readJson(req);
    // Showing a video also approves it if it was waiting for a safety review
    const sql = b.hidden === false ? 'UPDATE videos SET hidden=0, pending=0 WHERE id=?' : 'UPDATE videos SET hidden=1 WHERE id=?';
    const was = db.prepare('SELECT id, owner, title, slug, created, pending FROM videos WHERE id=?').get(+m[1]);
    if (!db.prepare(sql).run(+m[1]).changes) throw fail(404, 'Video not found.');
    if (b.hidden === false && was && was.pending) pushApproved(was);
    json(res, 200, { hidden: b.hidden !== false });
  }],
  ['DELETE', /^\/api\/admin\/videos\/(\d+)$/, ({ req, res, m }) => {
    needAdmin(req);
    removeVideo(+m[1]);
    json(res, 200, { ok: true });
  }],
];

// /v/<slug>: the app itself, with link-preview tags (WhatsApp, Telegram, X…) for that video
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sharePage(req, res, slug) {
  fs.readFile(path.join(PUB, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(500); return res.end('Server error'); }
    const row = q.bySlug.get(slug);
    const v = row && q.one.get({ me: '', id: row.id });
    if (v && !v.hidden && v.created <= Date.now()) {
      const proto = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0]) || (req.socket.encrypted ? 'https' : 'http');
      const base = `${proto}://${req.headers.host}`;
      const who = '@' + (v.uname || cleanName(v.handle) || 'user');
      const img = base + (v.thumb ? '/thumbs/' + v.thumb : '/apple-touch-icon.png');
      const tags = [
        `<meta property="og:type" content="video.other">`, `<meta property="og:site_name" content="Vizo">`,
        `<meta property="og:title" content="${escHtml(v.title)}">`, `<meta property="og:description" content="${escHtml(`Watch ${who} on Vizo`)}">`,
        `<meta property="og:url" content="${escHtml(base + '/v/' + slug)}">`, `<meta property="og:image" content="${escHtml(img)}">`,
        `<meta name="twitter:card" content="${v.thumb ? 'summary_large_image' : 'summary'}">`, `<link rel="canonical" href="${escHtml(base + '/v/' + slug)}">`,
      ].join('\n');
      // A function as the replacement, so `$&`, `` $` `` and friends in a title stay plain text
      const head = `<title>${escHtml(v.title)} · ${escHtml(who)} · Vizo</title>\n${tags}`;
      html = html.replace(/<title>[^<]*<\/title>/, () => head);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp(html) });
    res.end(html);
  });
}

// Content Security Policy for the app pages: scripts only from this site, the two pinned CDN packages, and the
// page's own inline scripts (by hash, read from the page itself so it always matches)
const CDN_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/ https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/';
const cspCache = new Map();
function csp(html) {
  const key = crypto.createHash('sha1').update(html).digest('base64');
  if (!cspCache.has(key)) {
    const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    if (cspCache.size > 20) cspCache.clear();
    cspCache.set(key, [
      "default-src 'self'", `script-src 'self' ${hashes.join(' ')} ${CDN_JS}`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self' https://cdn.jsdelivr.net",
      "worker-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
    ].join('; '));
  }
  return cspCache.get(key);
}
// Headers for every response
function baseHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const secure = req.socket.encrypted || (process.env.TRUST_PROXY && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim()));
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

// Range support is required: iPhone/Safari will not play video without it.
// cache: 'public' (files of public videos, avatars), 'private' (signed links), or none (app files)
function sendFile(req, res, fp, type, cache) {
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    // A video can be hidden later, so caches may keep its files for an hour, not forever
    if (cache) h['Cache-Control'] = cache === 'private' ? 'private, max-age=3600' : 'public, max-age=3600';
    else if (/^text\/html/.test(type)) {
      h['Cache-Control'] = 'no-cache'; // always fetch the latest app page
      try { h['Content-Security-Policy'] = csp(fs.readFileSync(fp, 'utf8')); } catch { res.writeHead(404); return res.end('Not found'); }
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let s = 0, e = st.size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      if (m[1] === '') s = Math.max(0, st.size - +m[2]);
      else { s = +m[1]; if (m[2]) e = Math.min(+m[2], e); }
      if (s > e) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      code = 206; h['Content-Range'] = `bytes ${s}-${e}/${st.size}`;
    }
    h['Content-Length'] = st.size ? e - s + 1 : 0;
    res.writeHead(code, h);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(fp, { start: s, end: e }).pipe(res);
  });
}

const MEDIA_OF = {
  uploads: db.prepare('SELECT mime, hidden, created FROM videos WHERE file=?'),
  thumbs: db.prepare('SELECT hidden, created FROM videos WHERE thumb=?'),
};
http.createServer(async (req, res) => {
  try {
    baseHeaders(req, res);
    if (req.url.startsWith('/sb/') && SB_URL) return proxyAuth(req, res);
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p.includes('\0')) throw fail(400, 'Bad request.');

    if (p.startsWith('/api/')) {
      // Who is asking: a logged-in Supabase user, else this browser's anonymous id.
      // 'sb_' ids can only come from a verified token, never from X-Uid.
      const h = String(req.headers['x-uid'] || '');
      const anon = /^[\w-]{8,64}$/.test(h) && !h.startsWith('sb_') ? h : '';
      let uid = anon, email = '', verified = false;
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
      if (bearer && SB_URL) {
        const u = await sbUser(bearer[1]);
        if (!u) throw fail(401, 'Your login has expired. Please log in again.');
        ({ uid, email, verified } = u);
      }
      for (const [method, re, fn] of routes) {
        const m = method === req.method && re.exec(p);
        if (m) return await fn({ req, res, uid, anon, email, verified, url, m });
      }
      throw fail(404, 'Not found.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');

    const m = /^\/(uploads|avatars|thumbs)\/([0-9a-f-]{36}(\.[a-z0-9]{2,4}))$/.exec(p);
    if (m) {
      let type = Object.keys(IMG).find(k => IMG[k] === m[3]), cache = 'public';
      if (m[1] !== 'avatars') {
        // Video files and thumbnails belong to a video; a hidden or scheduled one needs a valid signed link
        const v = MEDIA_OF[m[1]].get(m[2]);
        if (m[1] === 'uploads') type = v && v.mime;
        if (!v) type = null;
        else if (restricted(v)) {
          const e = Number(url.searchParams.get('e')), s = url.searchParams.get('s') || '';
          if (!(e * 1000 > Date.now()) || !safeEq(s, mediaSig(m[2], e))) type = null;
          cache = 'private';
        }
      }
      if (!type) { res.writeHead(404); return res.end('Not found'); }
      return sendFile(req, res, path.join(DIRS[m[1]], m[2]), type, cache);
    }
    const sm = /^\/v\/([A-Za-z0-9]{6,20})$/.exec(p);
    if (sm) return sharePage(req, res, sm[1]);
    const fp = path.join(PUB, path.normalize(p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p));
    if (!fp.startsWith(PUB + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    sendFile(req, res, fp, STATIC[path.extname(fp)] || 'application/octet-stream');
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.end();
    json(res, e.status || (e instanceof URIError ? 400 : 500), { error: e.status ? e.message : 'Something went wrong. Please try again.', ...(e.login ? { login: true } : {}), ...(e.blocked ? { blocked: true } : {}), ...(e.commentsOff ? { commentsOff: true } : {}) });
  }
}).on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already used by another app. Pick another port, e.g.:  $env:PORT=4001; npm start`);
  process.exit(1);
}).listen(PORT, () => {
  console.log(`Vizo is running: http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin  (key is in ${process.env.ADMIN_KEY ? 'ADMIN_KEY' : KEYFILE})`);
});
