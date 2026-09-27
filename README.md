# RPG Notes

A small note-taking app for tabletop RPG campaigns. Notes are organized as a
tree of nodes (chapters, NPCs, places, ...) shown as a nested **List**, where
each **main node** (a top-level node, e.g. a chapter) can be opened as a
freely arranged **Mindmap**. Each node has a name and
plain-text notes, where `**bold**` renders bold and URLs become links.

- Tabs at the left of the top bar: **Campaign** (the list and the
  mindmaps described below), **Players**, **Notes** (see below) and
  **NPCs**. Players and NPCs are empty for now. The back button returns
  from the other tabs to the campaign (to the list or the mindmap that was
  open), and the app remembers which tab was open
- **Notes** tab: loose notes for the campaign, each a title and a
  description, as cards on a board that pans and zooms like the mindmap,
  without lines between them. Tapping a note's title folds it out right
  there (and back in), so several can be open at once; which ones are
  open is remembered on the device. In edit mode, **+ New note** adds one,
  **✎** on an open note edits its title and description in the card (saved
  with **Done** or by tapping outside it), **✕** deletes it (with Undo), and
  dragging a card by its title bar moves it. The description uses the same
  `**bold**` and links as a node's notes
- Multiple independent campaigns, one active at a time
- **Edit / View** switch in the top bar (the highlighted half is the current
  mode). View mode locks everything, for use during a session
- Works with mouse, pen and touch, so it's usable on a tablet. Opening a
  node to read it doesn't bring up the on-screen keyboard; a new node opens
  with its placeholder name selected, so you can just type
- The List is the start page. **Search** above it filters to nodes whose
  name or notes match (with their parents), and which nodes are collapsed is
  remembered per campaign
- **🗺 Mindmap** next to a main node opens its mindmap: that node and
  everything under it, with lines, where tapping a node opens its notes.
  **← List** goes back, the dropdown next to it switches to another main
  node, and **Arrange** (edit mode) lays the whole mindmap out as a tidy
  tree. It zooms out to fit when opened. The browser's/tablet's back button
  also returns to the list, and the app remembers an open mindmap, so
  reloading or reopening the app lands on it again. Only the open main node
  is rendered, which keeps big campaigns fast
- New child nodes are placed on a free spot below their parent, so they
  don't pile up in the mindmap
- Move a node to a new parent by dragging its ⠿ grip in the List view (it
  gets a free spot under its new parent, and its children come along); in
  the Mindmap, dragging a node only changes its position
- In the Mindmap, one finger on empty space pans; two fingers zoom around
  the point between them and pan along (the mouse wheel zooms around the
  cursor)
- Deleting a node shows **Undo** for a few seconds (it and everything under
  it come back)
- Everything is saved locally in the browser (`localStorage`). With the app
  open in several tabs, a change in one tab shows up in the others instead
  of being overwritten
- **Works without internet** once it has been opened online (see below), and
  can be installed on a tablet's home screen
- **Backup:** the **⋯** menu next to the campaign downloads the campaign as a
  `.json` file, or imports one as a new campaign (same format as the Drive
  files, see "Data format")
- Optional sync via Google Drive, to use the same notes on several devices.
  Everything Drive-related is in the **Drive** menu at the top right. Next
  to it, **Saved to Drive 14:32** says when the current campaign last
  reached Drive; it turns **red** ("Not saved to Drive · last 14:32") when
  there are changes Drive doesn't have and can't get right now (offline,
  sign-in expired, disconnected). Right after an edit it says **Saving to
  Drive…**, since edits are uploaded about 10 seconds later

It's plain HTML, CSS and vanilla JavaScript: no build step, no dependencies
(apart from Google's sign-in library, loaded only for Drive sync).

## Running it

Serve the folder as static files, e.g. via GitHub Pages or any local web
server. Opening `index.html` directly (`file://`) works for local use, but
Google Drive sync needs `https://` or `http://localhost` (see below).

Every local file is included with a `?v=N` query string: the `.js`/`.css`
files, the manifest and the apple-touch icon in `index.html`, and the app
icons inside `manifest.webmanifest`. **After changing a file, bump its
number**, so browsers and GitHub Pages' CDN fetch the new version instead of
a cached copy. The same goes for the offline copy (below): it's keyed by
those URLs, so bumping the number is all an update needs there too - but a
file whose number *isn't* bumped is never fetched again.

## Offline and on a tablet

`sw.js` is a service worker: the first time the app is opened online (over
`https://` or `http://localhost`, not `file://`), it saves a copy of the
app's own files in the browser. After that the app starts and works without
internet, e.g. at the table with no wifi. When online, it still checks for
a new version each time it's opened (waiting at most 3 seconds before using
the saved copy), so updates arrive as usual. An update is saved
all-or-nothing: only once every file of the new version has been
downloaded does it replace the saved copy, so a download that fails
halfway (bad wifi, app closed) can't leave the offline copy broken - the
old version stays and it's tried again next time.

- **Check before going offline:** the **⋯** menu next to the campaign says
  "✓ Ready to use without internet", or why not.
- Use the address **with a `/` at the end** (e.g. `…github.io/RPG/`, or
  `…/RPG/index.html`). Browsers only let the offline copy answer for
  addresses inside the folder, and `…/RPG` without the slash isn't - online
  GitHub Pages quietly redirects it, offline it just fails. Install the app
  from the address with the slash.
- Your notes are in `localStorage` either way; the service worker only
  keeps the app itself available.
- Without internet, Drive shows **Drive: offline**. Changes are saved on the
  device and synced automatically when the connection is back. The app
  never opens Google's sign-in window without a connection (it checks that
  Google can be reached first): it can't load then, and on a tablet it
  would cover the app with an error page. It signs in again by itself once
  the connection is back.
- **Install it (Android, Chrome):** open the app's address, then the **⋮**
  menu → **Install app** (or **Add to Home screen**). It then opens from its
  own icon, full screen without the address bar (icons are in `icons/`,
  settings in `manifest.webmanifest`). Open it online once after installing,
  so the offline copy is saved.
- The app asks the browser to keep its storage permanently
  (`navigator.storage.persist()`), so Chrome doesn't clear the notes when
  the device runs low on space. Chrome grants this readily for an installed
  app.
- (On iPhone/iPad, Safari's **Share → Add to Home Screen** works too; the
  `apple-*` tags in `index.html` are for that. Installing matters more
  there, since Safari may clear a website's storage after 7 days without
  use.)

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
- While connected, the campaign dropdown also lists the campaigns that are
  on Drive but not on this device, marked **☁**. Picking one downloads it
  and opens it. Campaigns stay on the device after you switch away, as an
  offline copy.
- **⏏ Remove this campaign from this device** (in the Drive menu, only
  while connected) saves the campaign to Drive first and deletes the local copy
  only after Drive has confirmed it. If that fails (offline, sign-in
  expired), nothing is removed. The Drive file is kept, so the campaign
  shows up as **☁** in the dropdown again.
- **Sync now** syncs **every** campaign, and adds campaigns that only exist
  on Drive (e.g. created on another device).
- **Pull from Drive** (after asking for OK) deletes **all** campaigns on this
  device and replaces them with every `<name>.json` in the RPG Notes folder.
  If no file can be read, nothing is changed.
- A Drive file that can't be read is never overwritten. It's left untouched
  and reported, and old `-backup.json` / `-conflict-` files from earlier
  versions are ignored. Drive keeps older versions of every file itself
  (right-click the file, **Manage versions**).
- Renaming a campaign renames its Drive file. A rename made while not
  connected is remembered and done on the next connect. A name that's
  already used by a campaign on Drive is refused (if that's only discovered
  on the next connect, the campaign gets its old name back), since two
  campaigns sharing a file would overwrite each other.
- Deleting a campaign (✕) moves its Drive file to Drive's trash, if Drive
  is connected at the time. You can delete every campaign, which leaves the
  app empty.
- Campaign names must map to different file names, so creating "A:B" when
  "A/B" exists gives "A:B (2)". Both would otherwise become `A-B.json`.
- Nothing is created automatically: on a new device the app starts with no
  campaigns. Connect Drive and pick a **☁** campaign from the dropdown (or
  press **Sync now** / **Pull from Drive** to get them all), or create one
  with **+**.
- The Google sign-in lasts about an hour (a browser-only app can't renew it
  in the background). When it expires, a banner below the top bar says so,
  and turns red if there are changes that aren't on Drive yet. Tap
  **Reconnect** to continue. Changes made meanwhile are saved on the device,
  and reconnecting uploads every campaign that was edited in the meantime,
  not just the current one.
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
- `x`/`y` are the node's position in the mindmap. The mindmap shows one
  root node's subtree at a time, so positions only matter within that.
- Loading a file repairs rather than rejects: missing fields get defaults, a
  `parentId` pointing at a missing node makes it a root, parent cycles are
  broken, duplicated ids get a fresh id. Unknown extra fields on a node are
  preserved.
- A node with `"board": "notes"` is a note on the **Notes** tab, not part
  of the list/mindmaps: `name` is its title, `notes` its description, `x`/`y`
  its place on the board, and `parentId` is always `null` (loading a file
  makes sure of that, and a `board` that isn't a non-empty string is
  dropped). They're in the same `nodes` array so Drive sync, backups and
  Undo handle them like any node. An older version of the app keeps them
  when it saves, but shows them as main nodes in the list.

### Local storage keys

| Key | Contents |
| --- | --- |
| `rpg-notes-campaigns` | List of campaigns: `[{ id, name }]` |
| `rpg-notes-current-campaign` | Id of the active campaign |
| `rpg-notes-data-<campaignId>` | That campaign's `nodes` array |
| `rpg-notes-updated-<campaignId>` | When that campaign last changed (ISO timestamp) |
| `rpg-notes-edit-mode` | `"true"` / `"false"` |
| `rpg-notes-collapsed-<campaignId>` | Ids of the nodes collapsed in the List |
| `rpg-notes-drive-connected` | Set while Drive is connected, so the app reconnects on the next visit |
| `rpg-notes-drive-saved` | `{ campaignId: { at, version } }`: when each campaign last reached Drive, and which version. A campaign whose current `updatedAt` differs has changes Drive doesn't have |
| `rpg-notes-drive-renames` | `{ campaignId: old name }` for renames not yet done on Drive |
| `rpg-notes-open-mindmap` | Id of the main node whose mindmap is open (removed when back on the list; kept while another tab is open) |
| `rpg-notes-open-tab` | `players`, `notes` or `npcs` while that tab is open (removed on the Campaign tab) |
| `rpg-notes-board-open-<campaignId>` | Ids of the notes folded out on that campaign's Notes tab |
