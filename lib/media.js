// Checks an uploaded file on disk without external tools: is it really an MP4/MOV/3GP (ISO BMFF) or WebM/Matroska
// video, is it well formed, does it have a video track, and how long does it really play?
// Only reads what it needs (positional reads, bounded loops), so a 100 MB file never has to fit in memory.
'use strict';
const fs = require('node:fs');

class Bad extends Error {}
const bad = msg => new Bad(msg);

// Small buffered reader over a file descriptor
function reader(fd, size) {
  let buf = Buffer.alloc(0), start = 0;
  const CH = 16 * 1024;
  return {
    size,
    // bytes [pos, pos+len) — may return fewer at the end of the file
    get(pos, len) {
      if (pos < 0 || len < 0) throw bad('Bad offset.');
      if (pos >= start && pos + len <= start + buf.length) return buf.subarray(pos - start, pos - start + len);
      const want = Math.min(Math.max(len, CH), Math.max(0, size - pos));
      const b = Buffer.alloc(want);
      const n = want ? fs.readSync(fd, b, 0, want, pos) : 0;
      buf = b.subarray(0, n); start = pos;
      return buf.subarray(0, Math.min(len, n));
    },
  };
}

// ---------- ISO BMFF (mp4, m4v, mov, 3gp) ----------
const u32 = (b, o) => b.readUInt32BE(o);
const u64 = (b, o) => Number(b.readBigUInt64BE(o));
function boxes(buf, from, to, each) { // child boxes inside an in-memory buffer
  let p = from, n = 0;
  while (p + 8 <= to) {
    if (++n > 20000) throw bad('Too many boxes.');
    let sz = u32(buf, p), hdr = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (sz === 1) { if (p + 16 > to) throw bad('Truncated box.'); sz = u64(buf, p + 8); hdr = 16; }
    else if (sz === 0) sz = to - p;
    if (sz < hdr || p + sz > to) throw bad('Malformed box.');
    each(type, p + hdr, p + sz);
    p += sz;
  }
  if (p !== to && to - p >= 8) throw bad('Malformed box.');
}
const MOOV_MAX = 32 * 1024 * 1024, MOOF_MAX = 8 * 1024 * 1024;
function isoInfo(r) {
  // Top level: a chain of boxes that must exactly cover the file
  const top = [];
  let p = 0;
  while (p < r.size) {
    if (top.length > 100000) throw bad('Too many boxes.');
    const h = r.get(p, 16);
    if (h.length < 8) throw bad('Truncated file.');
    let sz = u32(h, 0), hdr = 8;
    const type = h.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) throw bad('Malformed box.');
    if (sz === 1) { if (h.length < 16) throw bad('Truncated file.'); sz = u64(h, 8); hdr = 16; }
    else if (sz === 0) sz = r.size - p;
    if (sz < hdr || p + sz > r.size) throw bad('Truncated or malformed file.');
    top.push({ type, at: p, hdr, size: sz });
    p += sz;
  }
  if (!top.length || top[0].type !== 'ftyp') throw bad('Not an MP4 or MOV file.');
  const ftyp = r.get(top[0].at + top[0].hdr, 4).toString('latin1');
  const moov = top.filter(b => b.type === 'moov');
  if (moov.length !== 1) throw bad('The video has no (or more than one) header.');
  if (moov[0].size > MOOV_MAX) throw bad('The video header is too large.');
  const mb = Buffer.from(r.get(moov[0].at, moov[0].size));
  if (mb.length !== moov[0].size) throw bad('Truncated file.');

  let mvhd = null, mehd = 0, durs = [], video = false, frames = 0;
  const tracks = new Map(); // track id → { ts, video }
  boxes(mb, moov[0].hdr, mb.length, (t, s, e) => {
    if (t === 'mvhd') {
      const v = mb[s];
      if (e - s < (v === 1 ? 32 : 20)) throw bad('Malformed header.');
      const ts = u32(mb, s + (v === 1 ? 20 : 12)), d = v === 1 ? u64(mb, s + 24) : u32(mb, s + 16);
      mvhd = { ts, d: (v === 1 ? d === 2 ** 64 - 1 : d === 0xffffffff) ? 0 : d };
    } else if (t === 'mvex') {
      boxes(mb, s, e, (t2, s2) => { if (t2 === 'mehd') mehd = mb[s2] === 1 ? u64(mb, s2 + 4) : u32(mb, s2 + 4); });
    } else if (t === 'trak') {
      let id = 0, ts = 0, md = 0, kind = '', sttsSum = 0, count = 0;
      boxes(mb, s, e, (t2, s2, e2) => {
        if (t2 === 'tkhd') id = u32(mb, s2 + (mb[s2] === 1 ? 20 : 12));
        if (t2 !== 'mdia') return;
        boxes(mb, s2, e2, (t3, s3, e3) => {
          if (t3 === 'mdhd') { const v = mb[s3]; ts = u32(mb, s3 + (v === 1 ? 20 : 12)); md = v === 1 ? u64(mb, s3 + 24) : u32(mb, s3 + 16); if (md === 0xffffffff) md = 0; }
          if (t3 === 'hdlr' && e3 - s3 >= 12) kind = mb.toString('latin1', s3 + 8, s3 + 12);
          if (t3 !== 'minf') return;
          boxes(mb, s3, e3, (t4, s4, e4) => {
            if (t4 !== 'stbl') return;
            boxes(mb, s4, e4, (t5, s5, e5) => {
              if (t5 === 'stts') { // sample durations: the real length of the track
                const n = u32(mb, s5 + 4);
                if (n > (e5 - s5 - 8) / 8) throw bad('Malformed sample table.');
                for (let i = 0; i < n; i++) { const c = u32(mb, s5 + 8 + i * 8); sttsSum += c * u32(mb, s5 + 12 + i * 8); count += c; }
              }
            });
          });
        });
      });
      tracks.set(id, { ts, video: kind === 'vide' });
      if (kind === 'vide') { video = true; frames += count; }
      if (ts) durs.push(md / ts, sttsSum / ts);
    }
  });
  if (!mvhd || !mvhd.ts) throw bad('The video header is missing.');
  if (!video) throw bad('The file has no video track.');
  durs.push(mvhd.d / mvhd.ts, mehd / mvhd.ts);

  // Fragmented MP4 (e.g. recorded in a browser): add up the sample durations in each fragment
  const moofs = top.filter(b => b.type === 'moof');
  if (moofs.length > 20000) throw bad('Too many fragments.');
  const end = new Map(); // track id → furthest decode time
  for (const f of moofs) {
    if (f.size > MOOF_MAX) throw bad('A fragment header is too large.');
    const fb = Buffer.from(r.get(f.at, f.size));
    boxes(fb, f.hdr, fb.length, (t, s, e) => {
      if (t !== 'traf') return;
      let id = 0, def = 0, base = null, sum = 0;
      boxes(fb, s, e, (t2, s2, e2) => {
        if (t2 === 'tfhd') {
          const fl = fb.readUIntBE(s2 + 1, 3); id = u32(fb, s2 + 4); let o = s2 + 8;
          if (fl & 1) o += 8; if (fl & 2) o += 4; if (fl & 8) { def = u32(fb, o); }
        } else if (t2 === 'tfdt') base = fb[s2] === 1 ? u64(fb, s2 + 4) : u32(fb, s2 + 4);
        else if (t2 === 'trun') {
          const fl = fb.readUIntBE(s2 + 1, 3), n = u32(fb, s2 + 4); let o = s2 + 8;
          if (fl & 1) o += 4; if (fl & 4) o += 4;
          const per = ((fl & 0x100) ? 4 : 0) + ((fl & 0x200) ? 4 : 0) + ((fl & 0x400) ? 4 : 0) + ((fl & 0x800) ? 4 : 0);
          if (o + n * per > e2) throw bad('Malformed fragment.');
          for (let i = 0; i < n; i++, o += per) sum += (fl & 0x100) ? u32(fb, o) : def;
          const tr = tracks.get(id); if (tr && tr.video) frames += n;
        }
      });
      const prev = end.get(id) || 0;
      end.set(id, Math.max(prev, (base ?? prev) + sum));
    });
  }
  for (const [id, t] of end) { const tr = tracks.get(id); if (tr && tr.ts) durs.push(t / tr.ts); }
  if (!frames) throw bad('The video has no frames.');
  const duration = Math.max(...durs.filter(Number.isFinite));
  const brand = ftyp.trim();
  const mime = brand === 'qt' ? 'video/quicktime' : /^3g/.test(brand) ? 'video/3gpp' : 'video/mp4';
  return { mime, duration };
}

// ---------- EBML (WebM / Matroska) ----------
function vint(r, p, isId) {
  const b0 = r.get(p, 1)[0];
  if (b0 === undefined) throw bad('Truncated file.');
  let len = 1, m = 0x80;
  while (len <= 8 && !(b0 & m)) { len++; m >>= 1; }
  if (len > 8 || (isId && len > 4)) throw bad('Malformed element.');
  const b = r.get(p, len);
  if (b.length < len) throw bad('Truncated file.');
  let v = isId ? b0 : (b0 & (m - 1)), allOnes = (b0 & (m - 1)) === m - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[i]; if (b[i] !== 0xff) allOnes = false; }
  return { v, len, unknown: !isId && allOnes };
}
const EBML = 0x1a45dfa3, SEGMENT = 0x18538067, CLUSTER = 0x1f43b675;
// Masters we step into (their children are read in the same flat loop); everything else is skipped by size
const ENTER = new Set([SEGMENT, CLUSTER, 0x1549a966 /* Info */, 0x1654ae6b /* Tracks */, 0xae /* TrackEntry */, 0xa0 /* BlockGroup */]);
function ebmlInfo(r) {
  let p = 0;
  // EBML header with DocType
  const h = vint(r, 0, true); if (h.v !== EBML) throw bad('Not a WebM file.');
  const hs = vint(r, h.len, false); if (hs.unknown || hs.v > 4096) throw bad('Malformed header.');
  let doc = '', q = h.len + hs.len; const hend = q + hs.v;
  while (q < hend) {
    const id = vint(r, q, true), sz = vint(r, q + id.len, false), d = q + id.len + sz.len;
    if (sz.unknown || d + sz.v > hend) throw bad('Malformed header.');
    if (id.v === 0x4282) doc = r.get(d, sz.v).toString('latin1').replace(/\0+$/, '');
    q = d + sz.v;
  }
  if (doc !== 'webm' && doc !== 'matroska') throw bad('Not a WebM file.');
  p = hend;
  let scale = 1e6, declared = 0, cluster = 0, maxT = 0, blocks = 0, n = 0, segEnd = r.size, seg = false;
  let trackNo = 0, trackType = 0; const videoTracks = new Set(); let tracksSeen = false;
  const endTrack = () => { if (trackNo && trackType === 1) videoTracks.add(trackNo); trackNo = 0; trackType = 0; };
  while (p < segEnd) {
    if (++n > 3e6) throw bad('Too many elements.');
    const id = vint(r, p, true), sz = vint(r, p + id.len, false), d = p + id.len + sz.len;
    if (id.v === SEGMENT) { if (seg) throw bad('Malformed file.'); seg = true; if (!sz.unknown) { if (d + sz.v > r.size) throw bad('Truncated file.'); segEnd = d + sz.v; } p = d; continue; }
    if (!seg) throw bad('Malformed file.');
    if (ENTER.has(id.v)) {
      if (id.v === 0xae) { endTrack(); tracksSeen = true; }
      if (id.v === CLUSTER) endTrack();
      if (!sz.unknown && d + sz.v > segEnd) throw bad('Truncated file.');
      p = d; continue;
    }
    if (sz.unknown) throw bad('Malformed element.');
    if (d + sz.v > segEnd) throw bad('Truncated file.');
    const num = () => { if (sz.v > 8) throw bad('Malformed element.'); const b = r.get(d, sz.v); let v = 0; for (const x of b) v = v * 256 + x; return v; };
    switch (id.v) {
      case 0x2ad7b1: scale = num() || 1e6; break; // TimecodeScale
      case 0x4489: { const b = r.get(d, sz.v); declared = sz.v === 8 ? b.readDoubleBE(0) : sz.v === 4 ? b.readFloatBE(0) : 0; break; } // Duration
      case 0xd7: trackNo = num(); break; // TrackNumber
      case 0x83: trackType = num(); break; // TrackType (1 = video)
      case 0xe7: endTrack(); cluster = num(); break; // Cluster Timecode
      case 0xa3: case 0xa1: { // SimpleBlock / Block: track number, then a signed 16-bit time relative to the cluster
        endTrack();
        const tn = vint(r, d, false), rel = r.get(d + tn.len, 2);
        if (rel.length < 2 || tn.len + 3 > sz.v) throw bad('Malformed block.');
        if (videoTracks.has(tn.v)) blocks++;
        maxT = Math.max(maxT, cluster + rel.readInt16BE(0));
        break;
      }
    }
    p = d + sz.v;
  }
  endTrack();
  if (!seg) throw bad('Malformed file.');
  if (!tracksSeen || !videoTracks.size) throw bad('The file has no video track.');
  if (!blocks) throw bad('The video has no frames.');
  const duration = Math.max(Number.isFinite(declared) ? declared : 0, maxT) * scale / 1e9;
  return { mime: 'video/webm', duration };
}

// Returns { mime, ext, duration } or throws Bad with a short reason
function probeVideo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 32) throw bad('The file is too small to be a video.');
    const r = reader(fd, size), head = r.get(0, 12);
    let info;
    if (head.readUInt32BE(0) === EBML) info = ebmlInfo(r);
    else if (head.toString('latin1', 4, 8) === 'ftyp') info = isoInfo(r);
    else throw bad('This file is not a supported video (MP4, MOV or WebM).');
    if (!Number.isFinite(info.duration) || info.duration < 0) throw bad('Could not read how long the video is.');
    const ext = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/3gpp': '.3gp', 'video/webm': '.webm' }[info.mime];
    return { ...info, ext };
  } catch (e) {
    if (e instanceof Bad) throw e;
    throw bad('The video file is damaged or not supported.'); // RangeError from a short read, etc.
  } finally { fs.closeSync(fd); }
}

// Images (profile photos, thumbnails): the first bytes must match the type
function imageType(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(12), n = fs.readSync(fd, b, 0, 12, 0);
    if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (n >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (n >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  } finally { fs.closeSync(fd); }
}

module.exports = { probeVideo, imageType, Bad };
