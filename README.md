# RPG Notes

A small note-taking app for tabletop RPG campaigns. Notes are organized as a
tree of nodes (chapters, NPCs, places, ...) that you can browse either as a
nested **List** or as a freely arranged **Mindmap**. Each node has a name and
plain-text notes, where `**bold**` renders bold and URLs become links.

- Multiple independent campaigns, one active at a time
- Edit mode / view mode (view mode locks everything, for use during a session)
- Works with mouse, pen and touch, so it's usable on a tablet
- The Mindmap shows one level at a time: the root nodes, or the node you're
  in (highlighted) with lines out to its direct children. Tap a child to go
  into it, and use the ← button or the breadcrumb at the top to go back up.
  Tapping the highlighted node, its 📝 button, or its name in the breadcrumb
  opens its notes, and "▸ 3" means a node has 3 children. Only the current
  level is rendered, which keeps big campaigns fast
- Move a node to a new parent by dragging its ⠿ grip in the List view; in the
  Mindmap, dragging a node only changes its position
- Everything is saved locally in the browser (`localStorage`)
- Optional sync via Google Drive, to use the same notes on several devices

It's plain HTML, CSS and vanilla JavaScript: no build step, no dependencies
(apart from Google's sign-in library, loaded only for Drive sync).

## Running it

Serve the folder as static files, e.g. via GitHub Pages or any local web
server. Opening `index.html` directly (`file://`) works for local use, but
Google Drive sync needs `https://` or `http://localhost` (see below).

Every local `.js`/`.css` file is included in `index.html` with a `?v=N`
query string. **After changing a file, bump its number**, so browsers and
GitHub Pages' CDN fetch the new version instead of a cached copy.

## Google Drive sync

Drive sync is optional. Without it, the app works the same and saves only
locally. It uses the `drive.file` scope, so the app can only see and change
files it created itself, never the rest of your Drive.

### One-time setup

1. Go to <https://console.cloud.google.com/> and create a project.
2. Under **APIs & Services**, enable **Google Drive API**.
3. Under **OAuth consent screen**, choose **External**, fill in the app name,
   and add your own Google account as a **Test user**. Then the app doesn't
   need to go through Google's full verification for you to use it yourself.
4. Under **Credentials** → **Create credentials** → **OAuth client ID**,
   pick **Web application**.
5. Under **Authorized JavaScript origins**, add the URL(s) the app is served
   from. Google OAuth does **not** work with `file://` or a plain local IP
   over http, only `https://...` or `http://localhost`. Easiest: host the
   folder with https (e.g. GitHub Pages) and open that **same URL** on every
   device.
6. Copy the generated **Client ID** into `CLIENT_ID` at the top of
   `drive-sync.js` (and bump its `?v=N` in `index.html`).

### How it syncs

- All files live in a Drive folder called **RPG Notes**. Each campaign is one
  file, named after the campaign: `<name>.json`. The app always finds the file
  by that name.
- **Newest wins:** every change stamps the campaign with `updatedAt`, which
  is saved in the file too. When syncing a campaign, the app compares the
  local `updatedAt` with the file's, and the newer one overwrites the other.
  If neither has one, Drive wins. Timestamps come from each device's own
  clock, so keep device clocks roughly right.
- The current campaign is synced when you connect and when you switch
  campaign. After that, each change is uploaded about 10 seconds later (or
  right away when the tab is hidden or closed), without re-checking Drive.
  So avoid editing the same campaign on two devices at the same time.
- **Sync now** syncs **every** campaign, and adds campaigns that only exist
  on Drive (e.g. created on another device).
- **Pull from Drive** (after asking for OK) deletes **all** campaigns on this
  device and replaces them with every `<name>.json` in the RPG Notes folder.
  If no file can be read, nothing is changed.
- A Drive file that can't be read is never overwritten. It's left untouched
  and reported, and old `-backup.json` / `-conflict-` files from earlier
  versions are ignored. Drive keeps older versions of every file itself
  (right-click the file, **Manage versions**).
- Renaming a campaign renames its Drive file. Deleting a campaign moves its
  Drive file to Drive's trash. You can delete every campaign, which leaves
  the app empty.
- Campaign names must map to different file names, so creating "A:B" when
  "A/B" exists gives "A:B (2)". Both would otherwise become `A-B.json`.
- Nothing is created automatically: on a new device the app starts with no
  campaigns. Connect Drive and press **Sync now** (or **Pull from Drive**),
  or create one with **+**.
- The Google sign-in lasts about an hour. When it expires, the status shows
  **Drive: sign in again**. Click **Connect Drive** to continue. Changes made
  meanwhile are uploaded at the next sync, since they're newer.
- **Disconnect Drive** uploads any pending change first, and the app won't
  reconnect automatically until you click **Connect Drive** again.

## Data format

The Drive files use this format. **It's a contract**: keep it stable, so old
Drive files can always be loaded. The
authoritative description is at the top of `store.js`.

```json
{
  "schemaVersion": 1,
  "app": "rpg-notes",
  "exportedAt": "2026-01-01T12:00:00.000Z",
  "updatedAt": "2026-01-01T11:58:00.000Z",
  "nodes": [
    {
      "id": "string, unique, required",
      "name": "string, required",
      "notes": "string, required (plain text, may be empty)",
      "parentId": "another node's id, or null for a root node",
      "x": 0,
      "y": 0
    }
  ]
}
```

- A file always contains **one** campaign's nodes.
- `updatedAt` is when the campaign last changed (`null` if never). Drive sync
  uses it to decide which copy is newest. Older files without it count as
  oldest.
- The envelope with a `nodes` array is required. A bare array isn't accepted.
- Children are never stored on a node. They're derived from `parentId`.
- `notes` is plain text, never HTML. `**bold**` and URLs are only formatted
  when displayed.
- `x`/`y` are the node's position in the mindmap. The mindmap only shows
  a node and its children at a time, so positions only matter relative to a
  node's parent and siblings.
- Loading a file repairs rather than rejects: missing fields get defaults, a
  `parentId` pointing at a missing node makes it a root, parent cycles are
  broken, duplicated ids get a fresh id. Unknown extra fields on a node are
  preserved.

### Local storage keys

| Key | Contents |
| --- | --- |
| `rpg-notes-campaigns` | List of campaigns: `[{ id, name }]` |
| `rpg-notes-current-campaign` | Id of the active campaign |
| `rpg-notes-data-<campaignId>` | That campaign's `nodes` array |
| `rpg-notes-updated-<campaignId>` | When that campaign last changed (ISO timestamp) |
| `rpg-notes-edit-mode` | `"true"` / `"false"` |
| `rpg-notes-drive-connected` | Set while Drive is connected, so the app reconnects on the next visit |
