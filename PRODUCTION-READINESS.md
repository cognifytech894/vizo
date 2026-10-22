# Invidora: production readiness

*Last updated: 19 October 2026. Nothing has been deployed; this describes the code in this folder.*

## Status

**Not production-ready yet.** The code-side security and reliability work is done and tested. Before going public, someone still has to do the manual steps in [section 2](#2-before-going-public-manual-steps) and accept or fix the risks in [section 5](#5-known-limits-and-remaining-risks).

| Area | State |
|---|---|
| Upload checks (type, damage, 60 s, 100 MB, quota, disk space) | Done on the server |
| Content safety | By default (`UPLOAD_REVIEW=all`) every upload waits for an admin. The browser check is only a hint. There is **no server-side nudity detection** (see 5.1) |
| Who can see what (hidden, scheduled, blocked) | Enforced on every video endpoint and on the media files |
| Login: proxy, logout, rate limits | Done |
| Browser security headers, CSP, SRI | Done |
| Backups | Scripts done and tested. **Scheduling and off-machine copies are your job** (section 4) |
| Supabase production settings | **Manual** (section 2) |
| HTTPS, domain, hosting | **Manual** |
| Replies, pins, collaborations, analytics | Done and tested (section 1) |
| Push notifications | Done; tested end to end with Edge's push service only. Needs https and a `VAPID_SUBJECT` (section 2) |
| Several video qualities | **Not built** |
| Load / penetration testing | **Not done** |

## 1. What is in place

**Uploads**
- **What the server checks:** the file itself, not just the type the browser claims:
  - MP4 / MOV / 3GP (ISO BMFF boxes) or WebM / Matroska (EBML)
  - there is a video track and at least one frame
  - the structure is complete: nothing truncated, nothing appended
- **Length:** the real duration comes from the sample tables or frames. A header that claims less than that is ignored. The limit is 60 s.
- **Stored type:** detected from the bytes. MOV files are stored as `video/quicktime`, WebM as `video/webm`.
- **Pure Node, no ffmpeg:** `lib/media.js` reads only what it needs, with bounded loops.
- **Temporary files:**
  - an upload is written under a temporary name first
  - it becomes a video only after the checks pass, and is deleted otherwise
  - temp files left by a crash are removed at the next start
- **Images:** profile photos and thumbnails must really be JPG, PNG or WebP. The file extension comes from the bytes.
- **Limits:**
  - 100 MB per file
  - 20 uploads per account per day, 30 per hour per network
  - a storage quota per account; parallel uploads reserve their space, so they can't overshoot it together
  - a free-disk floor

**Content safety**
- The browser scan (NSFWJS) only counts as a hint; it can't approve a video.
- By default (`UPLOAD_REVIEW=all`) every new upload is kept private and shows in the admin queue as "Waiting for safety review" until an admin approves or deletes it. `UPLOAD_REVIEW=unscanned` holds only uploads without a passed scan and trusts the browser, so it is for testing.

**Visibility**
- **Endpoints:** hidden, waiting-for-review and scheduled videos answer 404 to everyone except the owner. That covers like, view, comments, comment like, comment report, video report, progress and links.
- **Blocks:** blocked people get 403. You can still report someone you blocked.
- **Media files:** the files of such videos are served only through a **signed, expiring link**, which the API gives to the owner and the admin. Plain links return 404.
- **Caching:** public files are cached for 1 hour, no longer "forever", so a video hidden later doesn't stay in caches for a year.

**Login and abuse**
- **Login proxy (`/sb/auth/v1/*`):**
  - only the login endpoints the app needs
  - never the Supabase admin API or other Supabase services
  - no `..` or encoded tricks
  - only the needed headers; no cookies passed back
  - the real client IP is forwarded
- **Logout:** logging out in the app ends the cached login at once, including other sessions of the same person. A login ended some other way is accepted for at most 30 s more.
- **Login rate limits** (per network): 10 sign-ups per hour, 20 password logins per 10 minutes, 10 email/recovery requests per hour, 300 requests per 10 minutes in total.
- **Other rate limits:**
  - wrong admin keys: 20 per 10 minutes
  - per account: likes, comment likes, profile edits, photos, thumbnails, video edits and account linking
- **Memory:** the rate-limit memory is capped.

**Browser hardening**
- **CSP:**
  - scripts only from this site, the two pinned CDN packages, and the pages' own inline scripts (by hash)
  - no `unsafe-eval`, and `frame-ancestors 'none'`
- **SRI:** the CDN scripts (supabase-js, nsfwjs + model) carry integrity hashes. The browser refuses them if the CDN serves different bytes.
- **Headers:**
  - on every response: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`
  - HSTS when served over HTTPS behind the trusted proxy
- **Bad paths:** a null byte in a path gets 400, not 500 with a stack trace.
- **Share page:** titles with `$&` and similar stay literal.

**Community features**
- **Replies:** one level; the parent must be a top-level comment of the same video; blocks and comments-off apply.
- **Pins:** owner only; one per video; cleared when the comment is deleted or the owner blocks its writer.
- **Collaborations:**
  - owner-only control; at most 5 per video
  - no self, duplicate or blocked invitations, and no re-invite after a "no"
  - one video record
  - never reveals a pending, scheduled or hidden video
  - a block ends the collaboration
- **Analytics:** owner only; numbers count other people; watch reports are capped by real time; no invented history. Measured: about 0.2 s for 20,000 views + 20,000 watch rows.

**Push notifications**
- **Standard Web Push:** payloads encrypted per device (RFC 8291) and signed with the server's VAPID key (RFC 8292). No npm packages.
- **Server-side request safety:** requests go only to the known browser push services over https (Google, Mozilla, Microsoft, Apple).
- **Payloads:** a title, a short text, an app link and an opaque tag; no ids, emails, tokens or private file links.
- **Rules:** pushes follow the user's notification switches, Mute and blocks; duplicates are suppressed.
- **Device clean-up:** devices reported gone (404 / 410) or failing 5 times are removed. Logging out removes the device.

**Container**
- The Docker image runs as the unprivileged `node` user.

## 2. Before going public: manual steps

These can't be done from the code. Do them in this order.

### Supabase (dashboard of your hosted project)
1. **Email confirmation on**: Authentication → Sign In / Providers → Email → *Confirm email*. Unconfirmed accounts can't upload or report.
2. **Real email sending (SMTP)**: Authentication → Emails → SMTP settings. The built-in sender is for testing only and allows very few emails per hour, so confirmations and password resets would fail.
3. **Password rules**: at least 8 characters, letters and digits (Authentication → Policies / password strength). Turn on *leaked password protection* if your plan has it.
4. **CAPTCHA on sign-up and login** (Attack Protection → hCaptcha or Cloudflare Turnstile).
   - **The app does not send a CAPTCHA token yet**, so turning this on needs a small front-end change first.
   - Until then, rely on the rate limits (step 5 and the app's own limits).
5. **Rate limits**: Authentication → Rate Limits. Keep them on.
   - **The problem:** behind this app's login proxy, Supabase sees the **server's** IP for every user, so its per-IP limits apply to all users together.
   - **What to do:** keep its limits generous enough for that, and rely on the app's own per-network limits (section 1). See 5.4.
6. **URL configuration**: set the *Site URL* to your real address, and list only your own domain(s) under *Redirect URLs*.
7. **Secure password change** and **secure email change** on.
8. **Turn off providers you don't use.** The app uses email + password only.
9. **Never** put the `service_role` key in this app or in `.env` on the server; use only the anon key.
10. **JWT expiry**: keep 1 hour or shorter.

### Hosting
1. **HTTPS only**, behind exactly one proxy or load balancer. Set `TRUST_PROXY=1` (the number of proxies), so rate limits use the real client address and HSTS is sent.
2. `NODE_ENV=production`: the app refuses to start without the Supabase settings.
3. **`ADMIN_KEY`:** a long random value (Render's blueprint generates one).
   - Store it in a password manager.
   - Changing it later only invalidates open signed media links.
4. **A persistent disk** at `/data`, with room for `UPLOAD_QUOTA_MB` × expected accounts plus the `MIN_FREE_MB` floor.
   - An existing volume from an older image (when the app ran as root) needs `chown -R 1000:1000 /data` once.
5. **Run a single app instance.** Rate limits, the login cache and upload reservations live in memory (5.6).
6. **Check the admin page works:** open `/admin` over HTTPS and confirm the key works.
7. **Push notifications:**
   - set `VAPID_SUBJECT` to a real contact (`mailto:` or https)
   - keep the push key: either set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, or keep `/data/vapid.json` on the persistent disk, and store a copy in a password manager
   - push needs https
8. **Pin the base image** (`node:24-alpine`) to a digest if you want reproducible builds, and rebuild regularly for security patches.

### Data
1. **Set up scheduled backups and an off-machine copy** before real users arrive (section 4).
2. **Do one restore drill.**

## 3. Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 4000 | Port to listen on |
| `DATA_DIR` | `./data` | Database and media |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | none | Login (required in production) |
| `ADMIN_KEY` | generated into `data/admin-key.txt` | Admin page key; also derives the signed-media-link key |
| `TRUST_PROXY` | none | Number of proxies in front of the app |
| `UPLOAD_QUOTA_MB` | 2048 | Video storage per account |
| `MIN_FREE_MB` | 1024 | Uploads stop below this much free disk |
| `NODE_ENV` | none | `production` enforces the Supabase settings |
| `AUTH_LIMIT_SCALE` | 1 | Multiplies the login / sign-up limits. Only raise it for test servers |
| `UPLOAD_REVIEW` | `all` | `all`: every upload waits for an admin. `unscanned`: only uploads without a passed browser scan (testing only) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated into `data/vapid.json` | Push key pair (base64url P-256). Secret; changing it means every device must turn push on again |
| `VAPID_SUBJECT` | placeholder | Contact sent to push services; set a real `mailto:` or https URL |
| `PUSH_TEST_ENDPOINT_PREFIX`, `LIVE_CHECK_MS` | none / 60000 | Test servers only |

## 4. Backups

- **Commands** (details in `README.md`):
  - `npm run backup`
  - `node scripts/restore.js --verify <folder>`
  - `node scripts/restore.js --from <folder> --to <new folder>`
- **What's in a backup:**
  - a consistent database snapshot (SQLite online backup; safe while the app runs)
  - the media it refers to
  - a checksum manifest
  - **No secrets:** keep `ADMIN_KEY`, the push key (`vapid.json` or `VAPID_*`) and `.env` separately.
- **Frequency:** daily, plus before every upgrade or migration.
- **Retention:** 7 daily + 4 weekly + 3 monthly.
- **Off-machine:** copy each backup folder to storage that isn't the app's disk (another provider's object storage, or another machine). Encrypt it if that storage isn't private, because backups contain user data (emails are not stored by the app, but usernames, bios, comments and videos are).
- **Restore drill:** at least once before launch, then every few months. Restore into a new folder, start a test instance with `DATA_DIR` pointing there, and check the feed and a few videos.
- **On Render:**
  - the persistent disk has its own snapshots; treat them as extra, not as the only copy
  - run the backup command from a scheduled job or the shell, and ship the folder off the disk

## 5. Known limits and remaining risks

1. **No server-side nudity detection.**
   - **What exists:** the scan runs in the browser and is only a hint. With the default `UPLOAD_REVIEW=all` a person approves every upload, so a modified client claiming `scan=passed` gains nothing.
   - **The gap:** nothing checks the frames automatically on the server, so safety depends on the admin reviewing each video (and on reports later). With `UPLOAD_REVIEW=unscanned`, a modified client could post explicit content until someone reports it.
   - **Fix:** a server-side moderation step (a moderation API, or a queued scan in a worker) before publishing.
2. **Old guest ids** (INV-SEC-011, partly fixed): new guest ids need a secret kept in the browser before `/api/link` moves anything; ids made before that still work like a password for that guest's old data until linked (kept so nobody loses old videos).
3. **Media links of public videos are public.**
   - Anyone who has a video's link can fetch the file, including someone the owner blocked; blocks are enforced in the app, not on public files.
   - Hidden, scheduled and pending files need a signed link.
   - Caches may keep a file up to 1 hour after it is hidden.
4. **Login traffic goes through this server**, so hosted Supabase sees the server's IP (INV-SEC-006). The app's own per-network limits cover this. Alternative: let the browser talk to Supabase directly in production.
5. **CAPTCHA isn't wired into the app yet** (step 2.4).
6. **Single instance:** rate limits, the login cache and upload reservations live in memory, reset on restart, and don't work across several instances.
7. **The feed sends every video:**
   - `GET /api/videos` returns the whole feed, because search and trending work on it in the browser.
   - Paging exists for API clients (`?limit=&before=`), but the app doesn't use it yet.
   - Fine for thousands of videos; needs app-side paging before that.
8. **One admin key, shared.** There are no per-admin accounts and no audit log of admin actions.
9. **Styles and fonts:**
   - CSP still allows inline **styles** (`'unsafe-inline'` for styles only; scripts are strict).
   - Google Fonts CSS can't carry SRI, because it changes per browser.
10. **Not done:** load testing, an external penetration test, account deletion and data export, transcoding into several qualities.
11. **What the video check can't do:** it reads the container structure, not the encoded frames. A well-formed file with broken frames is accepted and simply won't play. MOV files without an `ftyp` header (very old QuickTime) are rejected.
12. **Push:**
    - only Edge's push service (Microsoft WNS) was tried end to end, and in some test runs headless Edge couldn't subscribe; Chrome, Firefox and Safari were not tried
    - pushes queued in memory are lost if the server stops
    - a scheduled video's "is live" push can be up to a minute late
13. **Analytics limits:**
    - watch time is per account, or per network for guests: people behind one network count as one guest viewer
    - watch time for videos uploaded before 19 Oct 2026 uses the length the browser reports, capped at 61 s
    - the dashboard reads a year of rows per request; very large creators would need pre-aggregated daily totals

## 6. How this was verified

Everything ran on isolated test servers with fresh or copied data folders. The real `data/` folder and the live server were not touched.

- **19 Oct 2026, new features:** `p6` (replies / pins, 65), `p7` (collaborations, 77), `p8` (analytics, 65), `p9` (push with a fake push service that verifies signatures and decrypts payloads, 57), their browser suites (26 / 20 / 23 / 16), one real end-to-end push through Edge's push service, and upgrades of an old test database. All earlier suites were re-run on the final code.
- `p4-test.js`: the pre-launch suite.
  - media checks with synthetic MP4 / WebM fixtures (no real footage)
  - parallel quota, the safety-review flow, visibility on every endpoint, signed links
  - the proxy allow-list, logout, rate limits
  - CSP / SRI (including a real browser loading and running nsfwjs under the CSP), headers, null bytes, the share page
  - global mute and its migration, paging, backup / restore
- **All earlier suites were run again.**
- **Responsive checks:** at 360, 390, 768, 1024, 1280, 1440 and 1920 px.
- **Docker:** the image was built locally. It runs as uid 1000 and can write `/data`.

`OVERVIEW.md` and `SECURITY-AUDIT-REPORT.md` have the details and counts.
