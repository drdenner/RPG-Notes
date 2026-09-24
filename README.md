# RPG Notes

A small note-taking app for tabletop RPG campaigns. Notes are organized as a
tree of nodes (chapters, NPCs, places, ...) that you can browse either as a
nested **List** or as a freely arranged **Mindmap**. Each node has a name and
plain-text notes, where `**bold**` renders bold and URLs become links.

- Multiple independent campaigns, one active at a time
- Edit mode / view mode (view mode locks everything, for use during a session)
- Works with mouse, pen and touch, so it's usable on a tablet
- Everything is saved locally in the browser (`localStorage`)
- Export / Import of a campaign as a JSON file
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

- All files live in a Drive folder called **RPG Notes**.
- Each campaign has its own file, named after the campaign: `<name>.json`.
  It is uploaded automatically about 10 seconds after each change, or right
  away when the tab is hidden or closed.
- **Backup** writes `<name>-backup.json`, which only changes when you press
  the button.
- Renaming a campaign renames its Drive files. Deleting a campaign moves its
  Drive files to Drive's trash.
- The list of campaigns is stored per browser. To open a campaign on a new
  device, connect Drive there and create a campaign with **exactly the same
  name**. Its contents are then fetched from Drive.
- **Conflicts:** when connecting, the app checks whether the campaign changed
  locally, on Drive, or both, since the last sync. It pulls or pushes
  accordingly. If both changed, it asks which version to keep and first saves
  the other one as `<name>-conflict-drive-<time>.json` or
  `<name>-conflict-local-<time>.json` in the same folder. Once connected,
  edits are pushed without re-checking Drive, so avoid editing the same
  campaign on two devices at the same time.
- If the Drive file can't be read, it's left untouched and syncing that
  campaign is paused until the next connect.
- If the sign-in expires and can't be renewed silently, the status shows
  **Drive: sign in again**. Click **Connect Drive** to continue.
- **Disconnect Drive** uploads any pending change first, and the app won't
  reconnect automatically until you click **Connect Drive** again.

## Data format

Export files and the synced Drive files share one format. **It's a contract**:
keep it stable, so old exports and Drive files can always be loaded. The
authoritative description is at the top of `store.js`.

```json
{
  "schemaVersion": 1,
  "app": "rpg-notes",
  "exportedAt": "2026-01-01T12:00:00.000Z",
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
- The envelope with a `nodes` array is required. A bare array isn't accepted.
- Children are never stored on a node. They're derived from `parentId`.
- `notes` is plain text, never HTML. `**bold**` and URLs are only formatted
  when displayed.
- `x`/`y` are the node's position in the mindmap.
- Import repairs rather than rejects: missing fields get defaults, a
  `parentId` pointing at a missing node makes it a root, parent cycles are
  broken, duplicated ids get a fresh id. Unknown extra fields on a node are
  preserved.

### Local storage keys

| Key | Contents |
| --- | --- |
| `rpg-notes-campaigns` | List of campaigns: `[{ id, name }]` |
| `rpg-notes-current-campaign` | Id of the active campaign |
| `rpg-notes-data-<campaignId>` | That campaign's `nodes` array |
| `rpg-notes-corrupt-<campaignId>-<timestamp>` | Saved data that couldn't be read, kept aside before the campaign started over |
| `rpg-notes-edit-mode` | `"true"` / `"false"` |
| `rpg-notes-drive-*` | Drive sync state: folder/file ids, the dirty flag, last synced modifiedTime, whether you disconnected |
