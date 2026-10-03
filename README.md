# RPG Notes

A small note-taking app for tabletop RPG campaigns, built around the
campaign's **locations**: a map with a pin for each place, the locations
as a nested list (regions, the cities in them, the taverns in those, ...),
a freely arranged **mindmap** per location, and the **NPCs** at each
location. Locations and NPCs have plain-text notes, where `**bold**`
renders bold and URLs become links.

- Tabs at the left of the top bar: **Map**, **Locations**, **NPCs** and
  **Players** (see below). The app remembers which tab was open, and a
  reload stays on it
- **Map** tab: the map picture, with pins on it. The picture is a fixed
  file in the app, `maps/map.jpg` (see "Changing the map" below); the pins
  belong to each campaign. In edit mode, **+ Pin** adds a pin in the
  middle of the screen, with a
  dropdown of every location (indented like the list). Picking one
  **locks** the pin: it then shows the location's name, can't be moved or
  changed by accident, and tapping it opens that location's mindmap. **🔒**
  unlocks it (edit mode): then it can be dragged by its dot, given another
  location (which locks it again), locked again as it was (**🔓**), or
  deleted (**✕**, with Undo). A pin whose location was deleted is unlocked
  and shown without a name; in view mode it's hidden. A pin is a small
  dot, so the names don't cover the map: tapping the dot shows its name
  (and 🔒 in edit mode), tapping the name opens the location's mindmap,
  and tapping the dot again or an empty spot on the map hides the name. **Show names** / **Hide names** in the bar shows every
  pin's name (in view mode too), and is
  remembered on the device. The map pans and zooms like the mindmap, and
  the pins keep their size at any zoom
- **Locations** tab: the locations as a nested list. **+ New location**
  adds a main location, **+** on a row adds a location inside it, **✕**
  deletes it with everything inside it (with Undo). The NPCs at a location
  are shown under its row; **👤+** (or tapping an NPC's name) opens the
  location's panel at its NPCs. **Search** finds locations by name, notes
  and the names of their NPCs (with their parents), and which locations
  are collapsed is remembered per campaign
- A location's **panel** (tap its name, in the list or the mindmap): its
  name and notes (saved with **Save**), and the **NPCs here**, each with
  its description. In edit mode, **👤 Add an NPC here…** moves an existing
  NPC here (it shows where each one is now) or creates a new one (**+ New
  NPC…**), and **✕** next to an NPC removes it from the location (the NPC
  is kept, without a location). NPC changes are saved right away
- **🗺 Mindmap** next to a main location opens its mindmap: that location
  and everything inside it, with lines, where tapping a node opens its
  panel and a node with NPCs shows how many (👤 2). A pin on the map opens
  the mindmap of its location (which can be any location, not just a main
  one). **← Back** returns to the list or the map, whichever it was opened
  from (so does the browser's/tablet's back button), and the dropdown next
  to it switches to another main location. It zooms out to fit when
  opened. Nodes are only placed by hand: there's no automatic layout.
  Only the open location is rendered, which keeps big campaigns fast
- **NPCs** tab: a simple list of NPC names, descriptions and locations
  (shown with their path, e.g. "Sword Coast › Waterdeep"). An NPC can be
  at any location, or **Traveling** (no location). In edit mode, **+ New
  NPC**, **✎** and **✕** add, edit or delete NPCs.
- **Players** tab: each player's magic items and wealth, e.g. to hand out
  treasure fairly. A player has a name, a list of magic items (a title and
  a value in gp each) and a note; their total is the items' values added
  up. One line per player (A-Z) shows their number of items and total,
  with the party's totals at the top. Tapping a player folds them out to
  show every item with its value, the total and the note (**Show all** / **Hide all** does every player). In edit mode,
  **+ New player** adds one, **✎** edits an open player right in the list
  (items are added with **+ Add item** and removed with their **✕**; saved
  with **Done** or by tapping outside it), and **✕** deletes a player (with
  Undo)
- Multiple independent campaigns, one active at a time
- **Edit / View** switch in the top bar (the highlighted half is the current
  mode). View mode locks everything, for use during a session
- Works with mouse, pen and touch, so it's usable on a tablet. Opening a
  location to read it doesn't bring up the on-screen keyboard; a new
  location opens with its placeholder name selected, so you can just type
- New locations are placed on a free spot below their parent in the
  mindmap, so they don't pile up
- Move a location to a new parent by dragging its ⠿ grip in the list (it
  gets a free spot under its new parent, and everything inside it comes
  along); in the mindmap, dragging a node only changes its position
- In the mindmap and on the map, one finger on empty space pans; two
  fingers zoom around the point between them and pan along (the mouse
  wheel zooms around the cursor)
- Deleting a location shows **Undo** for a few seconds (it and everything
  inside it come back, and NPCs and pins that pointed at it find it again)
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

### Changing the map

The map is `maps/map.jpg` (a placeholder until replaced). To use your own
map, replace that file (any size; a JPEG keeps it small) and bump its
`?v=N` in `index.html` (`<img id="map-image" src="maps/map.jpg?v=1">`),
then publish as usual. Because `index.html` links to it, the offline copy
(`sw.js`) saves it like the rest of the app, so it works without internet,
and it isn't stored in `localStorage`, so it doesn't use any of the
browser's ~5 MB for notes. Every campaign and device shows the same map.
Pins are stored relative to the picture's size, so a sharper or
differently sized picture of the same map keeps them in place. (To use
another file name or format, change the `src` there.)

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
- Loading a file repairs rather than rejects: missing fields get defaults, a
  `parentId` pointing at a missing node makes it a root, parent cycles are
  broken, duplicated ids get a fresh id. Unknown extra fields on a node are
  preserved.
- A node without a `board` is a **location** (the Locations tab's list and
  the mindmaps). `x`/`y` are its position in the mindmap; the mindmap
  shows one location's subtree at a time, so positions only matter within
  that.
- A node with a `board` isn't a location, and is never anyone's parent or
  child: its `parentId` is always `null` (loading a file makes sure of
  that, and a `board` that isn't a non-empty string is dropped). They're
  in the same `nodes` array so Drive sync, backups and Undo handle them
  like any node.
- `"board": "pins"` is a pin on the map: `locationId` is the id of the
  location it stands for (`""` = none picked yet), and `x`/`y` its place
  on the picture in 1/10000ths of its width/height (0-10000), so a
  replaced picture of the same map keeps the pins in place. `name` is the
  location's name when the pin was set (only used for "Deleted …").
- `"board": "npcs"` is an NPC: `name`, `notes` = description, `note` (from
  an earlier version, not shown), and `locationId`, the id of the location
  it's at (`""` or missing = traveling). `x`/`y` aren't used.
- `"board": "players"` is a player on the **Players** tab: `name`, `notes`
  = the note, and `items`, a list of `{ "title": string, "value": number }`
  (gp). Loading a file drops an `items` that isn't a list, leaves out items
  without a title, and counts an item's missing/invalid value as 0. (A
  `gold` field from an earlier version is kept, but not used.)
  Amounts are kept to the copper (2 decimals).
- `"board": "notes"` (loose notes), `"board": "locations"` (locations
  before they became the list) and `"board": "map"` (an uploaded map
  picture in `image`) come from earlier versions. They're kept, but not
  shown anywhere.

### Local storage keys

| Key | Contents |
| --- | --- |
| `rpg-notes-campaigns` | List of campaigns: `[{ id, name }]` |
| `rpg-notes-current-campaign` | Id of the active campaign |
| `rpg-notes-data-<campaignId>` | That campaign's `nodes` array |
| `rpg-notes-updated-<campaignId>` | When that campaign last changed (ISO timestamp) |
| `rpg-notes-edit-mode` | `"true"` / `"false"` |
| `rpg-notes-collapsed-<campaignId>` | Ids of the locations collapsed in the list |
| `rpg-notes-drive-connected` | Set while Drive is connected, so the app reconnects on the next visit |
| `rpg-notes-drive-saved` | `{ campaignId: { at, version } }`: when each campaign last reached Drive, and which version. A campaign whose current `updatedAt` differs has changes Drive doesn't have |
| `rpg-notes-drive-renames` | `{ campaignId: old name }` for renames not yet done on Drive |
| `rpg-notes-open-tab` | The open tab: `map`, `locations`, `npcs` or `players` |
| `rpg-notes-map-labels` | `"true"` while the Map tab shows every pin's name |
| `rpg-notes-open-mindmap` | `{ id, from }` while a location's mindmap is open: the location, and the tab it was opened from (`map` or `locations`) |
| `rpg-notes-player-open-<campaignId>` | Ids of the players folded out on that campaign's Players tab |
