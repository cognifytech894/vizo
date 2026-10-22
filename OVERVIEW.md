# Vizo: Project Overview

*Updated: 22 October 2026. This describes the code in `D:\Invidora` as it is now.*

> **Status:** the latest automated test results are in section 5; what is still needed, including the steps before a public launch, is in section 7.

Vizo (renamed from Invidora on 22 Oct 2026; the project folder, database and internal names still say invidora) is a short-video sharing app, like Reels or Shorts:
- **Watching:** a vertical feed.
- **Uploading:** clips up to 60 seconds, now or on a schedule.
- **Sharing:** every video has its own link.
- **People:** like, comment and reply, follow, remove followers and block.
- **Creators:** collaborate on videos, pin a comment, and an analytics dashboard.
- **Notifications:** in the app, and optional push notifications on each device.
- **Your videos:** watch history, and "Continue watching" picks up where you stopped.

It runs as one small Node.js server with a SQLite database. Login is handled by Supabase.

---

## 1. Run it on your computer

| Step | Command / action |
|---|---|
| 1 | Start **Docker Desktop** |
| 2 | In `D:\Invidora`, run `npx supabase start` (login; once after every PC restart) |
| 3 | In `D:\Invidora`, run `npm start` |
| 4 | Open **http://localhost:4000** (phone on the same Wi-Fi: **http://&lt;this PC's Wi-Fi IP&gt;:4000**, e.g. http://192.168.3.170:4000; find it with `ipconfig`) |
| Admin | **http://localhost:4000/admin**. The key is in `data\admin-key.txt` |

- **Node.js:** needs 22.13 or newer. Nothing to install with npm.
- **If Supabase is not running:** watching still works, but everything that needs an account is refused.
- **After changing `server.js`:** restart the server (Ctrl + C, then `npm start`). Changes in `public/` only need a page refresh; if an old version still shows, press **Ctrl + F5** (on a phone, refresh the page).
- **Database upgrades:** these run automatically when the server starts. They only add columns and tables, and are safe to run again. One-time data changes are recorded in `schema_migrations` and never run twice.
- **Internet for the upload safety check:** its model (about 6 MB) loads from the jsDelivr CDN the first time a logged-in user opens Upload.
- **Backups:** `npm run backup` writes a checked copy to `backups\`.

**Ports on this PC**

| Port | What runs there |
|---|---|
| 4000 | Vizo app |
| 56321–56329 | Vizo's own Supabase (login only) |
| 3000 | Finora, a different project. Don't use it for Vizo |
| 55321… | The vidora project's Supabase. Its containers are stopped |

---

## 2. Guest vs logged-in

| | Guest (not logged in) | Logged-in account |
|---|---|---|
| Watch the feed, open links, search, share | ✅ | ✅ |
| See anyone's Followers / Following lists | ✅ | ✅ |
| Like videos, comment, reply, like comments | ❌ "Log in required" sheet | ✅ |
| Follow / unfollow | ❌ "Log in required" sheet | ✅ |
| Report a video or a comment | ❌ "Log in required" sheet | ✅ (confirmed email) |
| Upload (incl. scheduling and description) | ❌ the Upload page shows a log-in card | ✅ (confirmed email) |
| Block / unblock people | ❌ | ✅ |
| Collaborate on videos, pin a comment on your video | ❌ | ✅ |
| Push notifications | ❌ | ✅ (needs https or localhost) |
| Profile page | only the **Log in / Create an account** buttons (no Settings gear) | full profile + **Settings gear** |
| Edit profile, edit own comments | ❌ | ✅ |
| Notifications (menu, badge, Mute) | hidden | ✅ |
| Dashboard | hidden | ✅ |
| Watch history, Continue watching | ❌ (nothing is saved) | ✅ |
| Settings page, Theme choice, Data saver | ❌ (theme follows the device) | ✅ |

The server enforces every ❌ itself, so calling the API directly doesn't get around it. When a guest logs in, that browser's earlier guest data moves into the account.

---

## 3. What users can do

### Opening the app
- **Splash:** the **vizo** logo on a dark purple background with a magenta glow (top left) and an orange glow (bottom right). It stays at least 1.6 s, then fades once the videos have loaded (at most about 5 s).

### Feed
- **Tabs:** **For you** (everyone else's videos, never your own) and **Following**. Newest first.
- **Phones:** the video fills the screen edge to edge, down to the bottom menu bar.
- **Computers:** the ˄ ˅ buttons sit on the left of the video.
- **Moving between videos:** swipe on a phone; on a computer use the mouse wheel, ↑ ↓ / Page Up Page Down keys or ˄ ˅.
- **Playback:**
  - tap to play or pause, double-tap to like (never unlikes; guests get the log-in sheet)
  - **Space** plays / pauses, **M** toggles sound, **L** likes, **?** shows the shortcuts
  - a play / pause button appears when you reach it with **Tab**
- **Action buttons** (on the video, bottom right):
  - ♥ like
  - 💬 comments
  - ↗ share
  - 🔇 sound
  - ✎ edit (only on your own video; in the profile player also 🗑 delete)
  - ⚑ report (other people's videos)
  - **⋯** clean view: hides everything except sound and ⋯ (remembered on this device)
- **Caption:** creator photo and @name, a **Follow** button, "with @…" for accepted collaborators, title, 👁 views · upload date, #tags.
- **Resume** (logged in): a video you stopped part-way starts where you left it ("Resumed at 0:23"). It needs at least 3 s watched, and is skipped if you stopped within 2 s of the end.
- **Loading:**
  - only the video on screen loads, plus a little of the next one
  - after 7 s a "Slow connection — still loading…" hint appears
  - a broken video shows "Couldn't play this video" with **Try again**
  - every video exists in **one quality** (the uploaded file)
- **Address bar:** in the feed it follows the video you're watching (`/v/<link-id>`), and the tab title becomes "title · @name · Vizo". `/?u=<name>` opens a profile.
- **Never in the feed:** your own videos, not-yet-live (scheduled) videos, and videos an admin hid. Blocked accounts: see Blocking.

### Comments
- **Description first:** the creator's description is pinned at the top, then the comments.
- **Order:** the pinned comment first, then most-liked, then newest.
- **Replies:** one level. **Reply** under any comment (answering a reply starts with @name and is filed under the same comment); **View N replies / Hide replies** opens them, oldest first.
- **Pin:** the video's owner pins one top-level comment ("Pinned by the creator"); pinning another replaces it.
  - **Unpinned automatically** when the comment is deleted, or when the owner blocks its writer.
  - **A reported pinned comment** stays pinned until an admin keeps or deletes it.
- **Like a comment:** ♥ with a count. Tap again to unlike.
- **Length:** 300 characters; a "N/300" counter shows from 240. Replies count as comments for the rate limits.
- **Edit:** only the writer, inline (marked "· edited").
- **Delete:** the writer, or the video's owner (asks first). Deleting a comment also deletes its replies.
- **Report a comment:** ⚑ next to someone else's comment.
  - **Who:** accounts with a confirmed email, once per person.
  - **Where it goes:** the admin queue; nothing is hidden or deleted automatically.
- **Comments off:** at the top of the comments panel the owner sees "Comments are on." with **Turn comments off** (or "Comments are off. Only you can see them." with **Turn comments on**); also "Allow comments" in Edit.
  - **For others:** nobody can post, reply, edit or like, and they see "Comments are turned off for this video" (the pin is hidden too).
  - **For the owner:** they still see the old comments.
- **Guests** can read comments and see "Log in to like and join the conversation".
- **Where it opens:**
  - **Phones:** a sheet from the bottom.
  - **900–1199 px:** a popup in the middle (up to 480 px wide).
  - **Computers (1200 px and wider):** a panel on the right of the video (feed, profile player or profile page). It follows the video you scroll to.
  - **Closing:** X, Esc, or tapping outside a sheet or popup.

### Video links & sharing
- **Link:** every video has a short permanent link: `/v/aB3dE9xKq2Z`. Old `?v=9` links still work.
- **Share sheet:** Copy (works on plain http too), WhatsApp, Telegram, X, Facebook, and More (the device's own share menu, only where the browser has one).
- **Link previews:** title, creator and thumbnail. They show for others once the site is online on https.
- **Links that don't open for others:** hidden or scheduled videos, and videos across a block.

### Search (Explore)
- **Continue watching** (logged in):
  - your part-watched videos, with a progress bar
  - ✕ removes one from the row ("Removed from Continue watching"); it stays in History
  - opening one resumes it
- **🔥 Trending videos:** the top 8, ranked #1, #2, #3… by likes + views × 3 + comments × 5, divided by an age factor so newer videos get extra weight.
- **Trending hashtags:** the top 12, each with its video count. Tapping one searches for it.
- **Explore grid:** "N videos", sorted by the same score; a Featured tile first when there are more than 2 videos. Tiles show the thumbnail and never download the video file.
- **Searching:** runs in the browser over the For you feed, so only creators with a video there can be found (never yourself).
  - **Matches:** creators by @username or full name; videos by title, creator, #tag or mood.
  - **Results:** a "Creators" block (with Follow) and a "Videos" block.
  - **Nothing found:** `No results for "…"`, a hint and **Clear search**. Esc clears the box.

### Upload (confirmed accounts)
- **Limits** (exact numbers in section 4): video length and size, uploads per day, storage per account. Two uploads at the same time can't go over the storage together.
- **The server checks the file itself:**
  - **Type:** it must really be a supported video with a video track. The type is read from the bytes, not from the file name. (The upload box says "MP4, MOV or WebM"; 3GP and MKV are accepted too.)
  - **Damage:** cut-off or padded files are refused.
  - **Length:** the real length is checked, not the one the browser reports.
  - **If refused:** the message says why, e.g. "This file is not a supported video" or "This video is 75 seconds long…".
  - **Leftovers:** nothing is kept from a refused upload.
- **Choosing a file:** drag & drop or pick one; a preview shows duration, size and **Change**. The title is pre-filled from the file name, and a thumbnail is taken from about 1 s in.
- **Safety check:** runs in the browser (how it scans: section 4).
  - **While checking:** "Checking your video… N%"; then "Safety check passed".
  - **If nudity or sexual content is found:** "This video can't be posted" and the video is **blocked**.
  - **If the check can't run** (no internet): you are told that you can still post, but the video stays private until it is reviewed.
- **Admin review** (server setting `UPLOAD_REVIEW`):
  - **`all` (default):** every new video waits for an admin, whatever the browser check said. After posting you see "Video sent for review"; the video shows "Under review" on your profile and is in nobody's feed until an admin approves it.
  - **`unscanned`:** only videos whose browser check didn't pass wait; the rest go live at once. This trusts the browser, so it is meant for local testing.
- **Details:**
  - title (70 characters)
  - description (500 characters, line breaks kept)
  - filter (Warm, Cool, Black & white, Vintage, Vivid)
  - up to 5 hashtags
- **When to post:** **Post now** or **Schedule** (1 minute to 60 days ahead; the picker starts at the next quarter hour at least 1 h ahead). The button reads **Post video** or **Schedule video**.
- **While uploading:**
  - Post shows "Uploading… N%"
  - a progress box with **Cancel**
  - a small "Uploading… N%" pill on other pages
  - if it fails: an "Upload failed" card with **Retry**
- **Afterwards:** "Video sent for review" (or, in `unscanned` mode, "Your video is live! 🎉" / "Video scheduled") with **View**. The card closes after 7 s; if the tab is in the background, a system notification is shown.

### Scheduled videos
- **Until the time:**
  - only the owner sees the video, on their profile
  - its ⋯ menu shows "Goes live …"
- **When the time passes** (and once an admin has approved it): the video appears everywhere and the "is live" notification is shown.

### Profile (logged in)
- **Phones:** the page is full screen, with the cover reaching the top and sides.
- **Settings gear:** on the cover, top-right (phones and computers). It opens a menu:
  - **Edit profile:**
    - username (unique, 3–24 letters, numbers, _ or .)
    - full name (optional, 50 characters)
    - bio (120 characters)
    - social links (200 characters each)
    - photo, with **Remove photo** (asks first)
  - **History:** your Watch history page.
  - **Settings:** notification types, push, blocked accounts, Data saver.
  - **Theme** (sub-menu): **Light / Dark / Auto (device setting)**. The current choice is ticked. It applies to the app straight away and is saved in this browser (the admin page always follows the device).
  - **Log out** (asks first): signs out and goes back to the feed as a guest.
  - **Closing:** tap outside, press Esc or Tab, or pick an item. ↑ ↓ Home End move between items.
- **Header:**
  - photo (📷 to change it)
  - **full name** on top, with @username below it
  - bio ("Vizo creator" when empty)
  - **social links:** Instagram, YouTube, X, Facebook and **Website**
    - **What you can type:** a full link or just a handle (Website: a link or a plain address like `example.com`)
    - **Check:** each social box only accepts its own site; Website accepts any site with a real domain ending (e.g. `.com`, `.in`)
    - **Saved as:** a clean https link (`http://` is changed to `https://`)
    - **Shown as:** an icon with the site name; Website shows its address without `https://` and `www.` (e.g. 🌐 example.com). Links open in a new tab
- **Stats:** Videos · Followers · Following. Tap Followers or Following to see the people.
- **My videos:** every video you posted, including scheduled ones, plus public videos you collaborate on (credited to their owner).
  - **Tap a video:** it plays right on the profile, with your other videos above and below. Back or Esc returns.
  - **⋯ on each tile:** posted date (or "Goes live …"), **Edit details**, **Collaborators**, **Delete video** (asks first). On a collaboration: "Collaboration with @owner" and **Leave collaboration** (asks first).
  - **Badges:** Scheduled, Under review, Hidden. A video that is both scheduled and under review shows only **Scheduled**.
- **Never shown:** your email address.

### Profile (guest)
- **What it shows:** a "Welcome to Vizo" card with two buttons, **Log in** and **Create an account**.
  - **Log in:** opens the log-in form (email, password).
  - **Create an account:** opens the sign-up form (optional username and full name, email, password).
  - **Each form stands alone:** there is no Sign up / Log in switch on it. To change, use **← Back**, which returns to the two buttons. Opening Profile again always starts at the two buttons.
  - **Log in / Create an account elsewhere** (the "Log in required" sheet, the Upload page) opens the matching form directly.
- **No Settings gear** (if Supabase login isn't set up at all, the gear shows with Settings, Theme and "Log in or sign up").

### Creator pages
- **Contents:**
  - photo, full name and @username, bio, social links
  - stats: Videos · Followers · Following · **Likes** (total on their videos; Followers / Following can be tapped)
  - **Follow / ✓ Following** (hidden when there is a block either way)
  - their videos and public collaborations, which play on the page (scheduled ones are hidden)
- **⋯ menu:** **Block @name** (asks first) or **Unblock @name**.

### Collaborations
- **Invite:** ⋯ on your video → **Collaborators** → a username. Up to 5 people (invited or accepted) per video; only existing accounts.
- **Answer:** the invited person gets a notification with **Accept / Decline**. Statuses: Pending, Accepted, Declined.
- **After accepting:** the video shows "with @name", appears on their profile too, and stays **one video** (one set of views, likes and comments).
- **The owner keeps control:** only the owner edits, schedules, pins, invites or deletes. The owner can cancel an invitation or remove a collaborator; a collaborator can leave.
- **Not allowed:** inviting yourself, the same person twice, someone across a block, or someone who already declined that video.
- **Visibility:** a collaboration never shows a video that is waiting for review, scheduled or hidden; it appears on the collaborator's profile only once it is public.

### Followers / Following lists
- **Each row:**
  - photo, full name, @username
  - **Follow / ✓ Following** (or "You")
  - tap a person to open their profile
- **Order:** newest first. People without a username show as "Guest".
- **Where it opens:** a panel on the right on computers (1200 px and wider), a bottom sheet on phones.
- **Remove a follower:** only in your own Followers list (logged in). Every row, "Guest" ones too, has **Remove**.
  - you confirm first; the row disappears and your Followers count goes down
  - they aren't told, and they can follow you again. To stop that, block them

### Blocking
- **Where:** ⋯ on a creator page. Your blocked accounts are listed in **Settings**, with Unblock.
- **Both ways:**
  - no following, liking or commenting between you
  - you don't see each other's videos (feed, search, profile, links), comments, or each other in Followers / Following lists
  - their activity is left out of your notifications
- **On their profile:**
  - you see "You blocked @name…" with **Unblock**
  - they see "You can't see @name's videos or interact with this account"
- **What happens to existing things:**
  - follows and collaborations between you end, and don't come back when you unblock
  - their pinned comment on your videos is unpinned
  - nothing else is deleted
  - you can still report their content

### Watch history and Continue watching (logged in)
- **History** (gear → History):
  - **Order:** videos you watched (after 2 s), newest first.
  - **Each item:** title, creator, when you watched it, and how far you got.
  - **Paging:** 20 at a time, with **Load more**.
  - **Removing:** **✕** removes one, **Clear all** removes everything, including Continue watching (asks first).
  - **Unavailable videos:** hidden, private or blocked videos show as "Video unavailable"; deleted ones disappear.
- **Watching again** moves a video to the top; it is still one view.
- **Your place is saved:**
  - **When:** about every 10 s, and when you pause, scroll away, switch tab or leave. Each save also moves the video to the top of History
  - **Views:** saving your place never adds a view
- **Finished:** you reached the end, or at most 5% (or 1.5 s, whichever is more) was left. Finished videos leave Continue watching but stay in History.

### Settings page (gear → Settings)
- **Notifications:** switches for **New followers**, **Comments**, **Replies**, **Collaborations**, **Likes** and **Your videos going live**.
  - **Default:** all on.
  - **Saving:** each switch saves right away.
  - **While a type is off:** activity of that type is never shown, even after you switch it back on. Older notifications stay.
- **Push notifications:** a "Push notifications on this device" switch.
  - **Asking:** the browser asks for permission when the switch is turned on, or the first time you post a video (for the "upload finished" notice).
  - **What is pushed:** new followers, comments, replies, collaboration invitations and answers, a video approved, a scheduled video going live. Likes stay in the app only.
  - **Rules:** pushes follow the switches above, Mute and blocks; the same event isn't pushed twice (remembered 30 days); a follow, and a collaboration invitation, is pushed at most once a day.
  - **Tapping one** opens the video (if it is public), the person's profile, or Notifications.
  - **Blocked in the browser:** turning the switch on shows how to allow notifications in the browser's site settings. Incognito / private windows always block them.
  - **On plain http** (e.g. a phone on Wi-Fi) it explains that push needs https; it works on localhost and online with https.
  - **Logging out** turns push off for that device.
- **Blocked accounts:** list with **Unblock**.
- **Data saver:** "Use less data": the next video isn't preloaded. It is stored in this browser, and is always on while the browser itself asks to save data.

### Notifications (logged in)
- **Where:** below Search on a computer; in the bottom bar on a phone.
- **Badge:** the unread count (up to "9+"), updated every minute; it clears when you open the page.
- **What appears:**
  - new followers (with **Follow back**)
  - comments on your videos
  - replies to your comments (a reply to your own comment on your own video shows once, as a reply)
  - collaboration invitations (with **Accept / Decline**) and answers to yours
  - likes on your videos
  - "Your video … is live"
- **Groups:** New and Earlier ("All activity" when nothing is unread).
- **Mute notifications / Unmute notifications:** a button at the top of the page.
  - **Mute:** a separate setting. Nothing new shows while muted, even after unmuting.
  - **Your Settings choices stay as they are.**
  - **Unmute:** brings back exactly your previous choices. For example, if Likes was off before muting, it is still off.
- **Left out:** types you switched off in Settings.

### Dashboard (logged in)
- **Where:** the sidebar on a computer; the row under the profile card on a phone.
- **Time range:** 24 hours · 7 days · 28 days (default) · 365 days. The range is remembered.
- **Tiles for the chosen range (10):** Videos posted, Views, Unique viewers, New followers, Likes, Comments, Engagement rate, Avg watch time, Completion rate, Total watch time.
- **"What these numbers mean"** (on the page):
  - **Views:** people who started one of your videos (after 2 s); each account, or for guests each network, counts once per video
  - **Unique viewers:** different accounts (guests: networks) who started at least one of your videos in the period
  - **New followers:** people who followed you in the period and still follow you
  - **Engagement rate:** likes + comments per 100 views in the period ("No views yet" when there are none)
  - **Avg watch time:** time watched per viewer per video in the period (their plays added up)
  - **Completion rate:** share of those viewers who reached the end (or the last 5%)
- **Watch time and completion** are recorded from the day this version first started on the database (19 Oct 2026 here; the page says "Recorded since …"); older plays were never measured and are not estimated. Old videos have no stored length.
- **No chart:** the Views / Watch time / … chart with Daily / Weekly and "Show as table" was removed on 22 Oct 2026.
- **Best this period:** your 5 most-viewed videos in the range.
- **Your videos:** a table of your videos (published, plus "Under review" / "Hidden"; not scheduled) with views, likes, comments, avg watch, completion, views in its first 7 days, all-time views and publication date. Sorted by views by default, sortable, 10 per page with Previous / Next; on phones it scrolls inside its own box.
- **All time (4 tiles):** Total likes, Total views, Followers, Videos (+ N scheduled); then the Top 10 by views.
- **How it counts:** other people only (your own views, likes, comments and watching never count), except **Total likes** and the **Top 10**, which use the video's raw counts and include your own like and views; a collaboration counts for the video's owner; views recorded before views had a date appear in totals only.

### Admin page (`/admin`, needs the admin key)
- **Key:** kept only for this browser tab.
- **Summary cards:** Reported videos, Waiting for review (only when there are some), Hidden from feed, Total reports. A **Refresh** button reloads.
- **Waiting for safety review:**
  - every new video (or, in `unscanned` mode, those without a passed check)
  - listed first, with a "Waiting for safety review" pill and a note saying whether the uploader's browser check passed ("a hint only; watch it yourself") or did not run
  - **Keep video** or **Show in feed** approves one, and it goes live
  - **Delete video** removes it
  - the admin can play it first
- **Reported videos:**
  - reasons, and a "Visible in feed" / "Hidden from feed" pill
  - **Hide from feed / Show in feed**: the owner still sees a hidden video, marked "Under review"
  - **Keep video**: clears the reports and shows the video
  - **Delete video**: removes the video
- **Reported comments:**
  - **Keep comment**: clears the reports
  - **Delete comment**: removes the comment
- **Confirmations:** Keep and Delete always ask first; Hide / Show doesn't.
- **Lock:** forgets the key and goes back to the key form ("Dashboard locked").
- **Reports never hide or delete anything by themselves.**
- **Wrong keys:** too many wrong keys from one network are refused for a while (limit in section 4).

### Look and feel
- **Design:**
  - charcoal dark theme and white light theme
  - Poppins and Inter fonts
  - shared buttons, chips, dialogs and loading skeletons
  - the brand gradient (orange → pink → magenta → violet) only on main actions; pink-magenta accent
- **Phones:**
  - there is no top bar
  - bottom bar: Feed · Search · Upload · Notifications (logged in) · Profile
  - touch targets are at least 44 px
  - long names and titles wrap
- **Computers:**
  - **Sidebar:** vizo logo, Upload, Feed, Search, Notifications, Dashboard, Profile.
  - **Placement:** the sidebar and the content sit together in the middle.
  - **Grids:** 3 columns in Search and Profile (2 below 600 px).
  - **Side panels** (comments, follower lists): on screens narrower than about 1,450–1,550 px the content slides left to make room.
- **No sideways scrolling:** checked at 360, 390, 768, 1024, 1280, 1440 and 1920 px.
- **Accessibility:**
  - **Contrast:** text meets WCAG AA in both themes.
  - **Skip links:** "Skip to main content" and "Skip to navigation".
  - **Keyboard:**
    - only the video on screen can be reached with Tab
    - shortcuts never fire while typing or inside a panel or menu
    - Esc closes the player, menus and panels, and returns focus
  - **Focus rings:** visible focus rings, white with a dark halo on video.
  - **Notification badge:** screen readers hear "Notifications, N unread".

---

## 4. How it is built

```
Browser (public/index.html)
   │  REST calls to /api/...           Supabase login calls to /sb/auth/v1/... (allow-listed)
   │  from cdn.jsdelivr.net, SRI-checked: supabase-js 2.45.4 (login) and nsfwjs 4.2.1 (safety check, runs in the browser)
   ▼                                        │
server.js  (Node.js, no npm packages) ─────┘──► Supabase Auth (Docker, port 56321)
   │
   ├── data/invidora.db   SQLite database
   ├── data/uploads/      video files
   ├── data/avatars/      profile photos
   └── data/thumbs/       video thumbnails
```

- **One server:** it serves the app, `/v/<link-id>` pages with preview tags, the API and video streaming, and passes login calls to Supabase.
- **Upload checks:** `lib/media.js` reads the uploaded file's structure (MP4/MOV boxes, WebM elements) to find its real type and length. No ffmpeg or other tools are needed.
- **Private video files:** the files of hidden, waiting-for-review and scheduled videos are only served through a signed link that expires (24–30 hours). The app gives that link to the owner and the admin. Public videos keep normal links.
- **Database tables:**
  - `users`
  - `videos` (incl. `slug`, `description`, `hidden`, `size`, `comments_off`, `pending` = waiting for safety review, `scan` = the browser check's result, `pinned`, `duration`)
  - `likes`, `comments` (incl. `parent` for replies), `comment_likes`, `follows`, `views`
  - `reports`, `comment_reports`
  - `blocks`
  - `notif_prefs`, `notif_mutes` (type `all` = Mute notifications)
  - `watch_history`
  - `collabs` (video, invited account, status, invited / answered times)
  - `watch` (watch time: video, viewer, clock hour, seconds, furthest point, completed)
  - `push_subs` (push devices per account), `push_log` (which pushes were sent, to avoid duplicates; entries older than 30 days are removed every 6 hours)
  - indexes for the dashboard on views, likes, comments, follows and videos by time
  - `schema_migrations` (one-time data changes that already ran)
- **Scheduled videos:** keep their publish time in `videos.created`.
- **Guest views:** stored as a keyed hash of the network, not the IP address.
- **Safety check:** runs in the browser with the open-source NSFWJS model.
  - **What it scans:** 4 to 12 frames (about one every 2 s), each checked whole and, for videos that aren't square, also as its centre square. It stops early after 2 bad frames.
  - **How the server treats it:** only as a hint shown to the admin; it can't approve a video (see Admin review in section 3).

### Project files

| File / folder | Purpose |
|---|---|
| `server.js` | Whole backend |
| `lib/media.js` | Checks uploaded videos and images (real type, damage, length) |
| `package.json` | `npm start`, `npm run backup`, `npm run restore`; needs Node 22.13+ |
| `scripts/backup.js`, `scripts/restore.js` | Backup and restore (`npm run backup` / `npm run restore`) |
| `backups/` | Created by the first `npm run backup` (`backups/invidora-<time>`); not in git, not in Docker |
| `public/index.html` | The app (design and code) |
| `public/admin.html` | Admin page |
| `public/sw.js` | Service worker: shows push notifications and opens their link (no caching) |
| `public/icon.svg`, `public/apple-touch-icon.png` | App icon (white play ring on a dark purple tile) and phone icon. The vizo wordmark itself is built into `public/index.html` |
| `vizo-logo.svg` | Full vizo logo (white z and o, for dark backgrounds). `invidora-logo.svg` and `invidora-logo-old.svg` are the old Invidora logos |
| `data/` | **All user data. Back this up.** It also holds `admin-key.txt` and `vapid.json` (push key, made on first start), which backups leave out on purpose. `data/backup-2026-10-18-before-phase2-3/` is a full copy taken before the 18 Oct upgrade |
| `.env` | Supabase URL and public key |
| `supabase/` | Local Supabase settings |
| `Dockerfile`, `.dockerignore`, `render.yaml` | Setup for putting it online |
| `.gitignore`, `.vscode/` | Git ignore list, editor settings |
| `README.md` | How to run and deploy (incl. the Supabase security settings and backups) |
| `PRODUCTION-READINESS.md` | What is done, the manual steps before going public, and the remaining risks |
| `SECURITY-AUDIT-REPORT.md` | Security audit (17 Oct 2026) and the status of each fix |
| `invidora.html` | The very first single-file version (backup) |

### Limits and rules

| Item | Limit |
|---|---|
| Video | 60 sec (1 s rounding allowed), 100 MB; MP4 / MOV / 3GP / WebM (Matroska is accepted and stored as WebM) with a video track, checked by the server |
| Thumbnail | 1 MB; JPG, PNG or WebP |
| Uploads | 20 per day per account, 30 per hour per network |
| Storage | 2 GB of video per account (`UPLOAD_QUOTA_MB`); uploads stop below 1 GB free disk (`MIN_FREE_MB`) |
| Profile photo | 2 MB (made 320×320 in the browser) |
| View calls | 600 per hour per network |
| Video edits | 120 per 10 min per network |
| Comments | 30 per 10 min per account, 40 per 10 min per network; edits 60 per 10 min per account |
| Comment list | 300 top-level comments and 3,000 replies per video |
| Follows + removing followers | 120 per hour per account, together |
| Collaborations | 30 invitations per hour, 60 answers per hour per account |
| Pins | 60 changes per 10 min per account |
| Watch-time reports | 900 per 10 min per network; each counts at most 15 s and never more than the time that really passed |
| Push devices | 10 per account (oldest dropped); 30 subscribe calls per hour; send queue 1,000 (oldest dropped) |
| Notifications | newest 80 shown; settings saves 60 per 10 min per account |
| Blocks / unblocks | 60 per hour per account; blocked list shows 500 |
| Video reports | 20 per hour per account, 60 per hour per network |
| Comment reports | 20 per hour per account, 60 per hour per network |
| Saving your place | max 400 per 10 min |
| Follower / following list | newest 500 |
| Likes / comment likes | 300 per 10 min per account each |
| Profile edits / photos / thumbnails | 60 per 10 min / 30 per hour / 60 per hour per account |
| Sign-ups / password logins (per network) | 10 per hour / 20 per 10 min; email and recovery requests 10 per hour; verify 30 per 10 min; all login calls together 300 per 10 min (all scaled by `AUTH_LIMIT_SCALE`) |
| Linking guest data (`/api/link`) | 30 per 10 min per network |
| Wrong admin keys | 20 per 10 min per network |

### API summary

| Area | Endpoints |
|---|---|
| Feed | `GET /api/videos` (`?feed=following`). Optional paging: `?limit=1–100&before=<cursor>`, next cursor in the `X-Next-Before` header |
| Videos | `POST /api/videos` (`publishAt`, `description`) · `GET /api/videos/s/:linkId` · `PATCH` (incl. `description`, `commentsOff`) / `DELETE /api/videos/:id` · `POST …/thumb` · `…/like` · `…/view` · `…/report` · `…/progress` |
| Comments | `GET` / `POST /api/videos/:id/comments` (`parent` for a reply; the list nests `replies`, has `pinned`) · `POST /api/videos/:id/pin` (`{comment: id | null}`) · `PATCH` / `DELETE /api/comments/:id` · `POST /api/comments/:id/like` · `POST /api/comments/:id/report` |
| Profile | `GET` / `POST /api/me` (incl. `fullName`, `links`) · `POST` / `DELETE /api/me/avatar` · `POST /api/link` (sends `X-Guest-Key` for new guest ids; answers `guestLinked`) |
| Creators | `GET /api/users/:name` (same optional paging as the feed, for the videos; `likes` stays the total) · `…/followers` · `…/following` · `POST …/follow` · `DELETE /api/me/followers/:fid` (remove a follower; `fid` comes from your own `…/followers` list) · `POST` / `DELETE …/block` · `GET /api/blocks` |
| Notifications | `GET /api/notifications` · `POST /api/notifications/seen` · `GET` / `POST /api/me/notification-prefs` (`{follow, comment, reply, collab, like, upload, muted}`) |
| History | `GET /api/history` (`?limit=1–50&before=<time>`, answers `{items, next}`) · `GET /api/history/continue` · `DELETE /api/history` · `DELETE /api/history/:id` · `DELETE /api/history/:id/progress` |
| Dashboard | `GET /api/dashboard?range=1\|7\|28\|365&tz=…` (still accepts `group=hour\|day\|week\|month` and returns chart `buckets`, which the app no longer shows) · `GET /api/dashboard/videos?range=…&sort=views\|likes\|comments\|watch\|completion\|first7\|total\|published&page=&limit=1–50` · `POST /api/videos/:id/watch` (`{seconds, position, duration, ended}`) |
| Collaborations | `GET` / `POST /api/videos/:id/collabs` · `DELETE /api/videos/:id/collabs/:name` · `POST /api/collabs/:videoId` (`{accept}`) · `DELETE /api/collabs/:videoId` (leave) |
| Push | `GET /api/push/config` (public key) · `GET /api/me/push` · `POST` / `DELETE /api/push/subscribe` |
| Admin | `GET /api/admin/reports` (reported + waiting for review; `pending`) · `POST /api/admin/videos/:id/hide` (`{hidden:false}` shows it, and approves a pending one) · `…/dismiss` · `DELETE /api/admin/videos/:id` · `GET /api/admin/comment-reports` · `POST /api/admin/comments/:id/dismiss` · `DELETE /api/admin/comments/:id` |
| Video fields | Video objects include `pending` and `collabs` (accepted collaborators). `src` / `thumb` of a hidden or scheduled video are signed links (for the owner and the admin) |
| Config | `GET /api/config` (`{login, supabaseKey}`; also the Render health check) |
| Pages | `/` app · `/v/:linkId` · `/admin` |

---

## 5. Testing

The automated tests run in headless Edge through Chrome DevTools, only on empty test servers or a test copy of the data (own data folder and port), never on the real `data/` folder or the server on port 4000. Latest full run: **19 Oct 2026, on the current code**, plus the re-runs noted below. The p3 test now expects the two new notification types.

| Suite | Result | Covers |
|---|---|---|
| API (`e2e.js`) | 56 passed | accounts, uploads, edits, likes, comments, follows, reports, admin Hide/Keep, guest restrictions |
| Browser UI (`ui.js`) | 81 passed | the main screens at phone and desktop sizes |
| Dashboard + scheduling / ranges | 34 / 24 passed† | numbers, scheduled videos going live, 24 h–365 days |
| Notifications / links / full name / account | 27 / 22 / 22 / 14 passed | |
| Comment likes / upload % | 17 / 6 passed | |
| Feature suites | 30 / 15 / 14 / 13 / 9 passed | profile player, side panels, follower lists, tile ⋯ menu |
| Accessibility (`a11y-test.js`) | 43 passed | contrast at 7 widths in both themes, keyboard, skip links, badge, admin |
| Security fixes (`p2-test.js`) | 57 passed | guest limits, quota, free disk, spoofed headers, reports, views, default username, fails closed, upgrade |
| Community & UX (`p3-test.js`) | 131 passed | blocking, comment controls, notification settings, history, continue watching, keyboard, responsive, data saving |
| Settings menu (`menu-test.js`) | 48 passed | gear (accounts only), menu items, theme, Mute, full-screen phone layout |
| Browser XSS check | 9 passed | no script ran anywhere |
| Pre-launch (`p4-test.js`) | 162 passed | file checks, quota, review can't be bypassed with `scan=passed`, nothing leaks before approval, visibility on every endpoint, signed links, login proxy, logout, rate limits, headers / CSP / SRI, Mute, feed paging, backup / restore |
| Responsive check (`p4-resp.js`) | 14 passed | admin review item and the upload message at 360–1920 px |
| Followers, guest proofs, paging (`p5-test.js`) | 59 passed | remove follower (who may, 401 / 404 cases, counts, no `fid` leaks, limit), guest-link proofs (forged / missing / mismatched / reused keys), creator-video paging, token cache |
| Replies + pins (`p6-test.js` / browser `p6-ui.js`) | 65 / 26 passed | nesting and bad parents, edit / like / report / cascade delete, blocks, comments off, hidden videos, pin rules, reply notifications without duplicates, limits, upgrade of an old database; phone sheet + desktop panel |
| Collaborations (`p7-test.js` / `p7-ui.js`) | 77 / 20 passed | invite / answer / cancel / remove / leave rules, spam limits, one video record, review / schedule / hidden never bypassed, blocks, owner-only control, notifications, upgrade; invite on desktop, accept on a phone |
| Analytics (`p8-test.js` / `p8-ui.js`) | 65 / 23 passed | watch-report checks and caps, every metric against hand-counted data, grouping and time zones, per-video table (sort, paging, ownership, bad input), 20,000-row load (≈0.2 s), upgrade; real watch time from the player with a video recorded in the browser |
| Push (`p9-test.js` / `p9-ui.js`) | 57 / 16 passed | a local fake push service checks every VAPID signature and decrypts every payload; devices, ownership, privacy of payloads, settings / mute / blocks, duplicates, gone (410) and failing devices, limits; the switch, blocked permission, https message, logout |
| Real push end to end (`p9-e2e.js`) | 6 passed once; not every run* | Edge subscribes with Microsoft's push service, a follow is pushed and the service worker shows it |
| Security probe (`sec-test-quick.js`) | 44 passed, 1 failed‡ | the original audit checks |

\* Depends on the browser's own push service: in some runs headless Edge couldn't subscribe (the app then says so and stays off).
† Its tile check now expects the 14 analytics tiles (it expected 8). Its hover-tooltip check failed once and passed on the re-run.
‡ **AUTH-2** sends a fake `sb_…` id in `X-Uid`. The server ignores it and answers 401, while the test expects 400. The protection works; only the expected code differs.

**Not checked yet:**
- **Safety check:** not tried with real explicit videos; it was only tested with a fake model result.
- **Real push on other browsers:** only Edge's push service was used; delivery through Chrome, Firefox or Safari wasn't tried.
- **Guest proof in a real browser:** the login flow with a new guest id was checked through the API and the app's own hashing code, but not by clicking through log-in in a browser.
- **Hands-on accessibility:** not tried with a screen reader, on a real phone, or at 200% zoom.

---

## 6. Security

See `SECURITY-AUDIT-REPORT.md` for the full audit and the status of each item.

**In place:**
- **Accounts:** the server checks login tokens itself, and fake account ids are ignored.
- **Ownership:** nobody can change another user's videos, comments or profile.
- **Admin:** a strong random key protects every admin action.
- **Abuse limits:**
  - **Rate limits:** they use the address the trusted proxy added, not `X-Forwarded-For` values the client sends.
  - **Storage:** per-account quota, and a free-disk check.
- **Injection:** all SQL is parameterised, and no XSS was found.
- **Files:** private files (`data/`, `.env`, the admin key) can't be downloaded.
- **Privacy:**
  - new usernames are random, never taken from the email
  - emails are never shown to others
- **Fails closed:** without Supabase settings, account actions are refused, and in production the server won't start.
- **Uploads:** images must really be images, and temp files are used, so nothing half-written is ever served.
- **Private videos:** hidden, scheduled and pending videos answer 404 to others on like, view, reading comments, comment like, reports, progress and links. (Exception, still open: posting a comment checks blocks and comments-off first, so it can answer 403 instead.)
- **Login:**
  - logging out in the app ends the session here at once
  - a login that ends in some other way (for example "log out everywhere" in another app) is still accepted for at most 30 s
  - the login proxy allows only the needed Supabase login endpoints and headers
- **Guest data:** guest ids come with a secret that stays in the browser; `/api/link` moves a guest's data only when that secret is sent.
- **Push:**
  - the server only sends to the known browser push services over https, never to an address a client makes up (the test-only `PUSH_TEST_ENDPOINT_PREFIX` setting turns this off; never set it in production)
  - payloads are encrypted for the device and signed (VAPID); they hold only a title, a short text, an app link and an opaque tag — no ids, emails, tokens or private file links
  - a device can't be taken over by another account
- **Collaborations and analytics:** only the owner sees invitation statuses and their own numbers; collaborators never see the owner's analytics.
- **Browser:**
  - CSP (scripts only from this site, the page's own inline scripts by hash, and the two pinned CDN packages)
  - SRI hashes on CDN scripts
  - `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Resource-Policy: same-origin` on every response
  - HSTS (180 days, incl. subdomains) when the request came over https
- **Smaller items:**
  - `/%00` → 400
  - `$` in share titles is safe
  - the container runs as a normal user
  - the rate-limit memory is capped

**Still open:**
- **No server-side nudity detection:** content is checked by the browser (a hint) and by the admin who approves each video.
- **Old guest ids (011, partly fixed):** ids made before the guest secret existed have none, so the id alone still works like a password for that guest's old data until it is linked. Kept on purpose, so nobody loses old videos.
- **Login proxy (006, reduced):** logins go through this server, so hosted Supabase sees the server's address; the app applies its own per-network limits.
- **Public video files:** a public video's file link works for anyone who has it (blocks apply inside the app). Caches may keep a file up to 1 hour after it is hidden.
- **CAPTCHA:** not wired into the app yet.
- **One admin key:** no per-admin accounts and no audit log.
- **In-memory state:** rate limits and the login cache are in memory, which is fine for one server, not for several.
- **Fonts and styles:** Google Fonts can't carry SRI, and CSP still allows inline styles.
- **Push keys:** `data/vapid.json` (or `VAPID_*` settings) is a secret kept out of backups; if it is lost, devices have to turn push on again.
- **Push after a restart:** pushes waiting in the in-memory queue are lost if the server stops.
- **Not done yet:** load testing and an outside penetration test.

---

## 7. Not done yet / next steps

| Item | What is needed |
|---|---|
| **Rebuild the Docker image** | The last local build is older than the current code |
| **Put it online** (also for link previews and WhatsApp sharing) | GitHub + Render (paid disk) + a free supabase.com project. Steps are in `README.md` and `PRODUCTION-READINESS.md` |
| **Production settings** | Supabase dashboard: email confirmation, SMTP, password rules, CAPTCHA, rate limits, redirect URLs. Server: HTTPS with `TRUST_PROXY=1` (the Dockerfile sets it; outside Docker it is off), a strong `ADMIN_KEY`, a real `VAPID_SUBJECT` (default is a placeholder address), disk permissions (`PRODUCTION-READINESS.md`). Other settings: `PORT`, `DATA_DIR`, `NODE_ENV`, `AUTH_LIMIT_SCALE`, `LIVE_CHECK_MS` |
| **Backups on a schedule + off this machine** | The scripts exist; scheduling them and copying them elsewhere is manual |
| **App-side feed paging** | The API supports it (`?limit=&before=`); the app still loads the whole feed |
| **Security items** | Everything under "Still open" in section 6 (moderation, CAPTCHA, admin accounts, …); roadmap in `SECURITY-AUDIT-REPORT.md` |
| **Several video qualities (360p / 720p / Auto)** | Not built (skipped this round; FFmpeg isn't installed). Needs FFmpeg, a background worker with a job queue, storage for renditions in the quota, and access rules on every rendition |
| **Guest watch history** | Not built; history is for accounts only |
| **Change a scheduled time** | Not built; delete and re-upload |
| **Dashboard Top 10 per range** | Not built; it is all-time (per range there is already "Best this period" and the Your videos table) |
| **Mood** | Half-built: the upload form never sends a mood, so every video is stored as "Comedy", and search matches it (searching "comedy" finds every video). The mood filter UI is unused code. Fix or remove |
| **Notification texts** | The Mute hint says activity "won't show here until you unmute", but activity during a mute never shows. The upload asks for notification permission, separately from the push switch |
| **Side panel on smaller laptops** | Could open over the content instead of sliding it left |
| **UI/UX audit, remaining phases** | Shorter splash, tablet layout, deferred supabase-js, dialog focus, type scale |
| **Google login / phone OTP, password reset email** | Need Supabase providers / SMTP, once online |
| **Collaborations in the Following feed** | A followed creator's collaborations don't show in Following yet (they do on their profile) |
| **Background music, video compression** | Not built |
