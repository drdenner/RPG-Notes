// drive-sync.js
// Optional sync of the notes via Google Drive, so you can work on the same
// data across multiple devices (e.g. pc and tablet). Uses the 'drive.file'
// scope, so the app can only see/change files it created itself - not the
// rest of your Drive.
//
// Each campaign (see store.js) gets its own pair of files in the same
// Drive folder, named after the campaign: "<name>.json" is kept in sync
// automatically on every change, "<name>-backup.json" only ever changes
// when the Backup button calls backupNow(). Renaming a campaign renames
// its Drive files to match. Switching the active campaign switches which
// pair of files this module talks to (see the Store.subscribeCampaignChange
// hook near the bottom) - campaigns never share or mix data on Drive, same
// as they never do locally.
//
// Every operation that touches which-campaign-is-synced (the initial
// connect, a campaign switch, a rename) runs through `queueSync()`, which
// chains them one after another instead of letting them run concurrently.
// Without that, switching to a new campaign while the previous campaign's
// initial connect was still in flight could let the two overwrite each
// other's `fileId`/`folderId` state and end up syncing the wrong campaign's
// edits into the wrong Drive file.
//
// Because those operations run later than the Store change that queued
// them, Store's "current" campaign may already be a different one by the
// time they run. So everything in here works on `syncedCampaignId` (the
// campaign `fileId` belongs to) and exports that campaign's data
// explicitly via Store.exportJSON(syncedCampaignId) - never just whatever
// Store happens to have loaded right now.
//
// Newest wins: every campaign carries an "updatedAt" timestamp (set by
// Store on every change, and written into the JSON file). On connect,
// syncOnConnect() compares the local one with the Drive file's: whichever
// is newer overwrites the other. Once connected, edits are pushed
// automatically without re-checking Drive.
//
// ONE-TIME SETUP: see "Google Drive sync" in README.md for how to get a
// Google OAuth Client ID - it goes into CLIENT_ID below.
//
// Without a valid Client ID, the rest of the app works exactly as before -
// Drive is 100% optional, everything still saves locally in localStorage.

const DriveSync = (() => {
  const CLIENT_ID = '162521818251-4h6jcsqivhk66v0160l3u54sck8g16iq.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'RPG Notes'; // the Drive folder every campaign's files live in
  const FOLDER_ID_KEY = 'rpg-notes-drive-folder-id';
  const DISCONNECTED_KEY = 'rpg-notes-drive-disconnected'; // set by Disconnect, cleared by Connect
  const UPLOAD_DEBOUNCE_MS = 10000;

  // the LOCAL "which Drive file id belongs to which campaign" cache is
  // keyed by the campaign's stable id (never changes), even though the
  // actual file NAME on Drive is the campaign's name (can change via rename).
  // Store owns sanitizeFileName so it can keep sanitized names unique.
  const sanitizeFileName = Store.sanitizeFileName;
  function fileNameFor(campaignName) { return `${sanitizeFileName(campaignName)}.json`; }
  function backupFileNameFor(campaignName) { return `${sanitizeFileName(campaignName)}-backup.json`; }
  function fileIdKeyFor(campaignId) { return 'rpg-notes-drive-file-id-' + campaignId; }
  function backupFileIdKeyFor(campaignId) { return 'rpg-notes-drive-backup-file-id-' + campaignId; }

  let tokenClient = null;
  let accessToken = null;
  let syncedCampaignId = Store.getCurrentCampaignId();
  let syncedCampaignName = Store.getCurrentCampaignName();
  let fileId = localStorage.getItem(fileIdKeyFor(syncedCampaignId)) || null;
  let backupFileId = localStorage.getItem(backupFileIdKeyFor(syncedCampaignId)) || null;
  let folderId = localStorage.getItem(FOLDER_ID_KEY) || null;
  let folderPromise = null; // memoizes an in-flight ensureFolder() call so concurrent callers share it
  let syncQueue = Promise.resolve(); // serializes connect/switch/rename operations, see header comment
  let uploadTimer = null;
  let refreshPromise = null;
  let pendingRefresh = null; // { resolve, reject, timer } while refreshToken() waits on GIS
  const REFRESH_TIMEOUT_MS = 20000;
  let suppressUpload = false;
  let statusCallback = () => {};

  function isConfigured() {
    return !!CLIENT_ID && !CLIENT_ID.startsWith('YOUR-');
  }

  function setStatus(status, detail) {
    statusCallback(status, detail || '');
  }

  // runs fn() after every previously queued sync operation has finished
  // (successfully or not), so overlapping calls never run concurrently
  function queueSync(fn) {
    syncQueue = syncQueue.then(fn, fn);
    return syncQueue;
  }

  // status: 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error'
  //       | 'reauth' (the token expired and couldn't be renewed silently - the
  //         user has to click Connect again)
  function init(onStatusChange) {
    statusCallback = onStatusChange || statusCallback;
    if (!isConfigured()) {
      setStatus('unconfigured');
      return;
    }
    waitForGis(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: onTokenResponse,
        // popup blocked/closed etc. - GIS ONLY reports these here, never
        // via `callback`, so without this a pending refresh would hang
        error_callback: onTokenError
      });
      setStatus('disconnected');
      // used Drive before on this device (for this campaign)? try a silent
      // reconnect - unless the user deliberately disconnected last time
      if (fileId && localStorage.getItem(DISCONNECTED_KEY) !== '1') {
        tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  function waitForGis(cb, attempts = 0) {
    if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
    if (attempts > 50) { setStatus('error', 'Could not load Google\'s sign-in library'); return; }
    setTimeout(() => waitForGis(cb, attempts + 1), 100);
  }

  function connect() {
    if (!tokenClient) return;
    localStorage.removeItem(DISCONNECTED_KEY);
    setStatus('connecting');
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  // flushes a still-pending debounced upload first (queued, so it runs
  // before the token is revoked), and remembers the choice so the next
  // page load doesn't silently reconnect
  function disconnect() {
    localStorage.setItem(DISCONNECTED_KEY, '1');
    const hadPendingUpload = !!uploadTimer;
    clearTimeout(uploadTimer); uploadTimer = null;
    return queueSync(async () => {
      if (hadPendingUpload) await push();
      if (accessToken) {
        google.accounts.oauth2.revoke(accessToken, () => {});
      }
      accessToken = null;
      setStatus('disconnected');
    });
  }

  function onTokenResponse(resp) {
    if (pendingRefresh) {
      if (resp.error) settleRefresh(new Error(resp.error));
      else { accessToken = resp.access_token; settleRefresh(null); }
      return;
    }
    if (resp.error) {
      setStatus(fileId ? 'disconnected' : 'error', resp.error);
      return;
    }
    accessToken = resp.access_token;
    queueSync(() => connectCurrentCampaign());
  }

  function onTokenError(err) {
    const reason = (err && err.type) || 'token request failed';
    if (pendingRefresh) { settleRefresh(new Error(reason)); return; }
    // the silent reconnect on page load, or the user closed the Connect popup
    setStatus(fileId ? 'reauth' : 'disconnected', reason);
  }

  // true for errors caused by the token not being renewable silently -
  // the 'reauth' status has already been set, so callers shouldn't
  // overwrite it with a generic 'error'
  function isReauthError(err) {
    return !!(err && err.reauth);
  }

  async function connectCurrentCampaign() {
    try {
      await syncOnConnect();
      setStatus('connected');
    } catch (err) {
      if (isReauthError(err)) return;
      // the file no longer exists, e.g. because a different Google account
      // was used -> forget the saved file reference and try a fresh one
      if (String(err.message).includes('404') && fileId) {
        fileId = null;
        localStorage.removeItem(fileIdKeyFor(syncedCampaignId));
        try {
          await syncOnConnect();
          setStatus('connected');
          return;
        } catch (err2) {
          if (isReauthError(err2)) return;
          console.error('Drive sync failed', err2);
          setStatus('error', err2.message);
          return;
        }
      }
      console.error('Drive sync failed', err);
      setStatus('error', err.message);
    }
  }

  // newest wins (see header comment). ISO timestamps compare correctly as
  // strings; a missing one counts as oldest. If neither side has one (e.g.
  // a fresh campaign on a new device), Drive wins.
  async function syncOnConnect() {
    if (await ensureFile()) return; // just created from local data - already equal
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const text = await res.text();
    if (!text.trim()) { await uploadCurrent(); return; }
    const remoteTime = readUpdatedAt(text);
    const localTime = Store.getUpdatedAt(syncedCampaignId) || '';
    // an unreadable Drive file is never overwritten - importRemote reports
    // it and pauses syncing instead
    if (remoteTime === null) importRemote(text);
    else if (localTime > remoteTime) await uploadCurrent();
    else if (remoteTime > localTime || !localTime) importRemote(text);
  }

  // the file's updatedAt, '' if it has none, or null if it isn't valid JSON
  function readUpdatedAt(text) {
    try {
      const t = JSON.parse(text).updatedAt;
      return typeof t === 'string' ? t : '';
    } catch (err) {
      return null;
    }
  }

  // tries to renew an expired token without user interaction. This often
  // runs from a timer (the debounced upload), where the browser may block
  // the popup - so it ALWAYS settles: via callback, error_callback, or the
  // timeout below. It runs inside syncQueue, so a promise that never
  // settled would hang every later sync operation forever. On failure it
  // drops the token and asks the user to reconnect by clicking.
  function refreshToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => settleRefresh(new Error('token refresh timed out')), REFRESH_TIMEOUT_MS);
      pendingRefresh = { resolve, reject, timer };
      tokenClient.requestAccessToken({ prompt: '' });
    });
    return refreshPromise;
  }

  function settleRefresh(err) {
    const pending = pendingRefresh;
    if (!pending) return;
    pendingRefresh = null;
    refreshPromise = null;
    clearTimeout(pending.timer);
    if (!err) { pending.resolve(); return; }
    console.warn('Could not renew the Drive token silently', err);
    accessToken = null;
    clearTimeout(uploadTimer); uploadTimer = null;
    setStatus('reauth', err.message);
    err.reauth = true;
    pending.reject(err);
  }

  // returns true if it had to create a new file (from the local data)
  async function ensureFile() {
    const campaignId = syncedCampaignId;
    const campaignName = syncedCampaignName;
    const folder = await ensureFolder();
    const expectedName = fileNameFor(campaignName);

    if (fileId) {
      // verify the cached file id still actually belongs to THIS campaign -
      // a stale/corrupted local cache (e.g. left over from a bug) could
      // otherwise silently sync this campaign's edits into a different
      // campaign's Drive file without any error ever being visible
      if (await fileNameMatches(fileId, expectedName)) {
        await moveFileToFolder(fileId, folder);
        return false;
      }
      fileId = null; // stale reference - fall through and re-resolve below
    }

    const found = await findFileByName(expectedName, folder);
    fileId = found || await createFileByName(expectedName, folder, Store.exportJSON(campaignId));
    localStorage.setItem(fileIdKeyFor(campaignId), fileId);
    return !found;
  }

  // the backup file is separate from the main synced file and only ever
  // written by the Backup button (see backupNow) - never by auto-sync
  async function ensureBackupFile() {
    const campaignId = syncedCampaignId;
    const campaignName = syncedCampaignName;
    const folder = await ensureFolder();
    const expectedName = backupFileNameFor(campaignName);

    if (backupFileId) {
      if (await fileNameMatches(backupFileId, expectedName)) return backupFileId;
      backupFileId = null;
    }

    const found = await findFileByName(expectedName, folder);
    backupFileId = found || await createFileByName(expectedName, folder, Store.exportJSON(campaignId));
    localStorage.setItem(backupFileIdKeyFor(campaignId), backupFileId);
    return backupFileId;
  }

  // true if the given Drive file id's current name matches what we expect
  // for the active campaign; false (never throws) if it's a mismatch, was
  // deleted, or anything else went wrong reading it - all treated the same
  // way by the caller: forget the cached id and re-resolve from scratch
  async function fileNameMatches(id, expectedName) {
    try {
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,trashed`);
      const data = await res.json();
      return !data.trashed && data.name === expectedName;
    } catch (err) {
      return false;
    }
  }

  // memoized so concurrent callers (e.g. an in-flight connect racing a
  // campaign switch) share the same lookup/creation instead of each
  // independently deciding the folder doesn't exist yet and creating a
  // duplicate
  function ensureFolder() {
    if (folderId) return Promise.resolve(folderId);
    if (!folderPromise) folderPromise = resolveFolder().finally(() => { folderPromise = null; });
    return folderPromise;
  }

  // escapes a value for use inside '...' in a Drive search query - an
  // unescaped apostrophe (e.g. "Borin's Tavern") otherwise breaks the query
  function queryString(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
  }

  async function resolveFolder() {
    const q = encodeURIComponent(`name=${queryString(FOLDER_NAME)} and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      folderId = data.files[0].id;
    } else {
      const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
      });
      const created = await createRes.json();
      folderId = created.id;
    }
    localStorage.setItem(FOLDER_ID_KEY, folderId);
    return folderId;
  }

  async function findFileByName(name, inFolderId) {
    let query = `name=${queryString(name)} and trashed=false`;
    if (inFolderId) query += ` and ${queryString(inFolderId)} in parents`;
    const q = encodeURIComponent(query);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0].id : null;
  }

  async function moveFileToFolder(id, targetFolderId) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=parents`);
    const data = await res.json();
    const currentParents = data.parents || [];
    if (currentParents.includes(targetFolderId)) return; // already in the folder
    const params = new URLSearchParams({ addParents: targetFolderId, fields: 'id,parents' });
    if (currentParents.length > 0) params.set('removeParents', currentParents.join(','));
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?${params.toString()}`, { method: 'PATCH' });
  }

  async function renameDriveFile(id, newName) {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
  }

  async function createFileByName(name, inFolderId, content) {
    const metadata = { name, mimeType: 'application/json', parents: [inFolderId] };
    const boundary = 'rpgnotes-boundary';
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const data = await res.json();
    return data.id;
  }

  // replaces the local data with the Drive file's contents
  function importRemote(text) {
    // Store already moved on to another campaign - importing now would put
    // this file's data into the wrong campaign. The switch that caused this
    // is queued right behind us and will connect the right file.
    if (Store.getCurrentCampaignId() !== syncedCampaignId) return;

    suppressUpload = true;
    try {
      Store.importJSON(text, { keepUpdatedAt: true });
    } catch (err) {
      // the remote file is in a shape Store can't read (corrupted, hand-
      // edited, from a newer version...). It may still hold data worth
      // rescuing, so NEVER overwrite it automatically: keep the local data,
      // leave the file alone, and pause syncing this campaign (forgetting
      // fileId in memory only, so nothing can upload over it this session;
      // the next connect tries again)
      fileId = null;
      clearTimeout(uploadTimer); uploadTimer = null;
      const msg = `Could not read "${syncedCampaignName}" from Google Drive (${err.message}). ` +
        'The Drive file was left untouched and syncing is paused for this campaign. Your local notes are unchanged.';
      alert(msg);
      throw new Error(msg);
    } finally {
      suppressUpload = false;
    }
  }

  // Store has already stamped the change with a new updatedAt, so even if
  // this upload never happens (offline, token expired), the next connect
  // sees the local copy as newer and pushes it
  function onLocalChange() {
    if (suppressUpload) return; // the change came from importRemote() itself
    scheduleUpload();
  }

  // automatically uploads to Drive a short while after the last change.
  // Queued (see header comment) so it can't fire mid-way through a
  // campaign switch and use a fileId that's about to change.
  function scheduleUpload() {
    if (suppressUpload || !accessToken || !fileId) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadTimer = null; // no longer pending once it has fired
      queueSync(() => push());
    }, UPLOAD_DEBOUNCE_MS);
  }

  // the debounced upload would never reach Drive if the tab is closed (or
  // the tablet goes to sleep) within those 10 seconds - so flush it as soon
  // as the page is hidden, which browsers reliably report before unloading
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !uploadTimer) return;
    clearTimeout(uploadTimer);
    uploadTimer = null;
    queueSync(() => push({ keepalive: true }));
  });

  // uploads the synced campaign; throws on failure (push() below is the status-reporting wrapper).
  // `keepalive` lets the request outlive the page if it's being closed -
  // browsers only allow that for bodies under 64 KB, so larger campaigns
  // fall back to a normal request (which usually still completes when the
  // tab is merely hidden)
  async function uploadCurrent({ keepalive = false } = {}) {
    const body = Store.exportJSON(syncedCampaignId);
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: keepalive && new Blob([body]).size < 60000
    });
  }

  async function push(options) {
    if (!accessToken || !fileId) return;
    setStatus('syncing');
    try {
      await uploadCurrent(options);
      setStatus('connected');
    } catch (err) {
      if (isReauthError(err)) return;
      console.error('Could not save to Drive', err);
      setStatus('error', err.message);
    }
  }

  function syncNow() {
    if (!accessToken) { connect(); return; }
    queueSync(() => push());
  }

  // writes the current notes to the separate backup file. Unlike the main
  // synced file, this one is NEVER touched by auto-sync (scheduleUpload) -
  // it only ever changes when this is called, i.e. when the Backup button
  // is pressed. Queued (see header comment) so it can't run while a
  // campaign switch is still in flight and read a stale backupFileId.
  function backupNow() {
    if (!accessToken) {
      connect();
      return Promise.reject(new Error('Not connected to Drive yet - try again once connected.'));
    }
    return queueSync(() => doBackup());
  }

  async function doBackup() {
    const id = await ensureBackupFile();
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: Store.exportJSON(syncedCampaignId)
    });
  }

  async function driveFetch(url, options = {}, retried = false) {
    options.headers = Object.assign({ Authorization: `Bearer ${accessToken}` }, options.headers);
    const res = await fetch(url, options);
    if (res.status === 401 && !retried) {
      await refreshToken();
      return driveFetch(url, options, true);
    }
    if (!res.ok) throw new Error(`Drive API error (${res.status})`);
    return res;
  }

  // any change to the notes (create/rename/delete/move) should end up in Drive
  Store.subscribe(onLocalChange);

  // fires when the active campaign changes OR the current campaign is
  // renamed. Queued so it can never run concurrently with the initial
  // connect or another switch/rename still in progress (see header comment).
  Store.subscribeCampaignChange(() => {
    queueSync(() => handleCampaignChange());
  });

  async function handleCampaignChange() {
    const newCampaignId = Store.getCurrentCampaignId();
    const newCampaignName = Store.getCurrentCampaignName();

    if (newCampaignId !== syncedCampaignId) {
      // switched to a different campaign entirely - point at its own files.
      // First flush any still-pending debounced upload for the campaign
      // we're leaving (uses the OLD fileId and syncedCampaignId, before
      // they're reassigned below - push() exports that campaign's saved
      // data, not the one Store has already switched to), so a quick switch
      // right after an edit doesn't just cancel it and leave that edit
      // stuck locally, never reaching Drive.
      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
        // (skipped if the campaign we're leaving was just deleted - its
        // saved data is gone and its Drive file has been trashed)
        const stillExists = Store.listCampaigns().some(c => c.id === syncedCampaignId);
        if (accessToken && fileId && stillExists) {
          try {
            await push();
          } catch (err) {
            console.error('Could not save pending changes before switching campaigns', err);
          }
        }
      }

      syncedCampaignId = newCampaignId;
      syncedCampaignName = newCampaignName;
      fileId = localStorage.getItem(fileIdKeyFor(newCampaignId)) || null;
      backupFileId = localStorage.getItem(backupFileIdKeyFor(newCampaignId)) || null;
      if (!accessToken) return; // not connected - nothing to sync right now
      setStatus('connecting');
      await connectCurrentCampaign();
      return;
    }

    if (newCampaignName !== syncedCampaignName) {
      // same campaign, just renamed - rename its Drive files to match
      syncedCampaignName = newCampaignName;
      if (!accessToken) return;
      try {
        if (fileId) await renameDriveFile(fileId, fileNameFor(newCampaignName));
        if (backupFileId) await renameDriveFile(backupFileId, backupFileNameFor(newCampaignName));
      } catch (err) {
        console.error('Could not rename the Drive file', err);
      }
    }
  }

  // a deleted campaign's Drive files would otherwise be orphaned forever -
  // move them to Drive's trash (not a permanent delete, so it's still
  // recoverable there if this was a mistake) and forget the local
  // references. Queued so it can't race a connect/switch still in flight.
  Store.subscribeCampaignDeleted(deletedCampaignId => {
    queueSync(() => trashCampaignFiles(deletedCampaignId));
  });

  async function trashCampaignFiles(campaignId) {
    const fId = localStorage.getItem(fileIdKeyFor(campaignId));
    const bId = localStorage.getItem(backupFileIdKeyFor(campaignId));
    localStorage.removeItem(fileIdKeyFor(campaignId));
    localStorage.removeItem(backupFileIdKeyFor(campaignId));
    if (!accessToken) return; // not connected - nothing we can do on the Drive side right now
    try {
      if (fId) await trashDriveFile(fId);
      if (bId) await trashDriveFile(bId);
    } catch (err) {
      console.error('Could not remove this campaign\'s Drive files', err);
    }
  }

  async function trashDriveFile(id) {
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  }

  return { init, connect, disconnect, syncNow, backupNow, isConfigured };
})();
