# Invidora

Watch. Share. Shine. A short video sharing platform.

## Run on your computer

1. Start Docker Desktop.
2. Start login (Supabase), once per computer restart:
   ```
   npx supabase start
   ```
3. Start the app:
   ```
   npm start
   ```
4. Open http://localhost:4000 (phone on the same Wi-Fi: `http://<your-PC-IP>:4000`).

Requires Node.js 22.13 or newer. No `npm install` needed. If Supabase is not running, watching still works, but everything that needs an account (upload, follow, like, comment, report) is refused.

## Features

- Vertical video feed with "For you" and "Following" tabs
- Upload videos (60 sec, 100 MB) with filters and automatic thumbnails. The server checks every file itself: it must really be an MP4 / MOV / 3GP / WebM with a video track, undamaged, and at most 60 seconds long
- Safety review: by default every new video waits for an admin to approve it ("Waiting for safety review" on the admin page). The browser also scans for nudity before posting and blocks obvious cases; the server treats that scan only as a hint
- Like (button or double-tap), comments with one level of replies, views, share links
- The video's owner can pin one comment
- Collaborations: invite other creators to a video; after they accept, it shows on both profiles (still one video, owned and controlled by its owner)
- Creator pages with follow, bio and profile photo
- Edit or delete your own videos
- Report videos (accounts only). Reports never hide a video by themselves; an admin hides, keeps or deletes it
- Accounts with email + password (Supabase). Guests can watch, search and share. Uploading, following, liking, commenting and reporting need an account
- Block / unblock people (both ways: no follows, likes or comments between you, and you don't see each other's videos or comments)
- Video owners can turn comments off; comments can be reported to the admin queue
- Settings: choose which notification types you get, push notifications on/off per device, manage blocked accounts, Data saver
- Push notifications (opt-in): followers, comments, replies, collaborations, approvals and scheduled videos going live. They need https (or localhost)
- Creator dashboard: views, unique viewers, engagement, watch time and completion (recorded since 19 Oct 2026), trends by day / week / month, and a per-video table
- Watch history and Continue watching (resume where you stopped); accounts only
- Keyboard friendly (Tab, play/pause button, `?` for the shortcuts list); 44 px touch targets on phones
- One quality per video (the uploaded file). Several qualities need a transcoding step (FFmpeg + a background worker), which isn't built

## Admin

Open http://localhost:4000/admin. The admin key is printed when the server starts and is saved in `data/admin-key.txt` (or set `ADMIN_KEY`).

## Files

- `server.js`: the whole backend
- `lib/media.js`: reads uploaded video and image files to check their real type and length (no external tools)
- `scripts/backup.js`, `scripts/restore.js`: backup and restore (see below)
- `PRODUCTION-READINESS.md`: what is done and what you still have to do before going public
- `public/index.html`: the app; `public/admin.html`: admin page; `public/sw.js`: service worker for push notifications
- `data/`: created automatically. Database (`invidora.db`), `uploads/`, `avatars/`, `thumbs/`, admin key, push key (`vapid.json`). **Back this up.**
- `.env`: Supabase URL and public key
- `supabase/`: local Supabase settings (ports 56321–56329, login only)

## Settings (environment variables or `.env`)

- `PORT`: default 4000
- `DATA_DIR`: where data is stored, default `./data`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`: login. Leave empty to turn login off
- `ADMIN_KEY`: admin page key
- `TRUST_PROXY`: the **number** of proxies in front of the app (Render/Docker: `1`). Rate limits then use the address the proxy added, not what the client wrote in `X-Forwarded-For`. Leave unset when the app is reached directly
- `UPLOAD_QUOTA_MB`: video storage per account, default 2048
- `MIN_FREE_MB`: uploads stop while the disk has less than this free, default 1024
- `NODE_ENV=production`: the server refuses to start without `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- `UPLOAD_REVIEW`: `all` (default) = every new video waits for an admin; `unscanned` = only videos whose browser check didn't pass wait. `unscanned` trusts the browser, so use it only for testing
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: the push key pair (base64url, P-256). If unset, a pair is made once and kept in `data/vapid.json`. Keep the private key secret and don't change it later, or every device has to turn push on again
- `VAPID_SUBJECT`: a contact for push services, `mailto:you@example.com` or an https URL (default is a placeholder; set it in production)
- `PUSH_TEST_ENDPOINT_PREFIX`, `LIVE_CHECK_MS`: **test servers only** (a local fake push service; how often scheduled videos are checked, default 60000 ms)
- `AUTH_LIMIT_SCALE`: multiplies the login / sign-up rate limits (default 1 = 10 sign-ups per hour and 20 password logins per 10 minutes per network). Only raise it for test servers

## Backup and restore

```
npm run backup                                   # → backups/invidora-<date>-<time>/
node scripts/backup.js --out D:\somewhere\new-folder
node scripts/restore.js --verify <backup folder> # check a backup (writes nothing)
node scripts/restore.js --from <backup folder> --to <new data folder>
```

- Safe while the app is running: the database is copied with SQLite's online backup, so it is consistent.
- A backup has the database, the videos, thumbnails and profile photos it refers to, and a `manifest.json` with a checksum of every file. It never overwrites an existing folder.
- **Not included on purpose:** `data/admin-key.txt`, `data/vapid.json` (push key) and `.env`. Keep those in a password manager. The database in a backup includes the new tables (collaborations, watch time, push devices).
- Restore only goes into a **new** folder (never over the live data). Then stop the app and start it with `DATA_DIR=<new folder>`.
- **How often:** at least once a day, and before every upgrade. Keep 7 daily and 4 weekly backups.
- **Keep a copy off this machine** (another disk, or cloud storage). A backup on the same disk doesn't survive a disk failure.

## Put it online

1. Create a free project at supabase.com. Copy its Project URL and anon public key. In Authentication → URL Configuration, set the Site URL to your app's address.
2. Push this folder to GitHub.
3. On render.com choose New → Blueprint and pick the repo (uses `render.yaml` + `Dockerfile`). Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
4. The admin key is under the service's Environment tab. For push, add `VAPID_SUBJECT`; the push keys are made on the persistent disk the first time (or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` yourself and keep them in a password manager). Push works only over https.
5. **Supabase security settings** (Supabase dashboard → Authentication). These can't be set from this code; do them before launch:
   - **Email confirmation on** (Sign In / Providers → Email → "Confirm email"). Unconfirmed accounts can't upload or report.
   - **Password rules:** at least 8 characters, with letters + digits (Auth → Policies / Password security).
   - **Secure password change** and **CAPTCHA** on sign-up (Attack Protection → hCaptcha or Turnstile).
   - Keep the rate limits on (Auth → Rate Limits).
   - Never put the **service_role** key in this app; only the anon key.

The Dockerfile also works on any host that runs Docker and gives a persistent volume at `/data`. The container runs as the unprivileged `node` user (uid 1000), so `/data` must be writable by it: a new volume is set up automatically; for a volume created by an older version run `chown -R 1000:1000 /data` once.

Before going public, read `PRODUCTION-READINESS.md`.
