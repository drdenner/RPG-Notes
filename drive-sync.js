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
// ONE-TIME SETUP (done once, by you):
//   1. Go to https://console.cloud.google.com/ and create a project
//   2. Under "APIs & Services" -> enable "Google Drive API"
//   3. Under "OAuth consent screen": choose "External", fill in the app
//      name, and add your own Google account as a "Test user" (so the app
//      doesn't need to go through Google's full verification for you to
//      use it yourself)
//   4. Under "Credentials" -> "Create credentials" -> "OAuth client ID"
//      -> pick "Web application"
//   5. Under "Authorized JavaScript origins": add the URL(s) the app is
//      served from. Google OAuth does NOT work with file:// or a plain
//      local IP over http - only https://... or http://localhost.
//      Easiest solution: host the folder somewhere with https (e.g.
//      GitHub Pages) and open that SAME URL on both pc and tablet.
//   6. Copy the generated "Client ID" into CLIENT_ID below.
//
// Without a valid Client ID, the rest of the app works exactly as before -
// Drive is 100% optional, everything still saves locally in localStorage.

const DriveSync = (() => {
  const CLIENT_ID = '162521818251-4h6jcsqivhk66v0160l3u54sck8g16iq.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'RPG Notes'; // the Drive folder every campaign's files live in
  const FOLDER_ID_KEY = 'rpg-notes-drive-folder-id';
  const UPLOAD_DEBOUNCE_MS = 10000;

  // the LOCAL "which Drive file id belongs to which campaign" cache is
  // keyed by the campaign's stable id (never changes), even though the
  // actual file NAME on Drive is the campaign's name (can change via rename)
  function sanitizeFileName(name) {
    return (name || 'campaign').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'campaign';
  }
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
        callback: onTokenResponse
      });
      setStatus('disconnected');
      // used Drive before on this device (for this campaign)? try a silent reconnect
      if (fileId) {
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
    setStatus('connecting');
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function disconnect() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    clearTimeout(uploadTimer);
    setStatus('disconnected');
  }

  function onTokenResponse(resp) {
    if (resp.error) {
      setStatus(fileId ? 'disconnected' : 'error', resp.error);
      return;
    }
    accessToken = resp.access_token;
    queueSync(() => connectCurrentCampaign());
  }

  async function connectCurrentCampaign() {
    try {
      await ensureFile();
      await pull();
      setStatus('connected');
    } catch (err) {
      // the file no longer exists, e.g. because a different Google account
      // was used -> forget the saved file reference and try a fresh one
      if (String(err.message).includes('404') && fileId) {
        fileId = null;
        localStorage.removeItem(fileIdKeyFor(Store.getCurrentCampaignId()));
        try {
          await ensureFile();
          await pull();
          setStatus('connected');
          return;
        } catch (err2) {
          console.error('Drive sync failed', err2);
          setStatus('error', err2.message);
          return;
        }
      }
      console.error('Drive sync failed', err);
      setStatus('error', err.message);
    }
  }

  function refreshToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = new Promise((resolve, reject) => {
      const originalCallback = tokenClient.callback;
      tokenClient.callback = resp => {
        tokenClient.callback = originalCallback;
        refreshPromise = null;
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        resolve();
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
    return refreshPromise;
  }

  async function ensureFile() {
    const campaignId = Store.getCurrentCampaignId();
    const campaignName = Store.getCurrentCampaignName();
    const folder = await ensureFolder();
    const expectedName = fileNameFor(campaignName);

    if (fileId) {
      // verify the cached file id still actually belongs to THIS campaign -
      // a stale/corrupted local cache (e.g. left over from a bug) could
      // otherwise silently sync this campaign's edits into a different
      // campaign's Drive file without any error ever being visible
      if (await fileNameMatches(fileId, expectedName)) {
        await moveFileToFolder(fileId, folder);
        return;
      }
      fileId = null; // stale reference - fall through and re-resolve below
    }

    const found = await findFileByName(expectedName, folder);
    fileId = found || await createFileByName(expectedName, folder);
    localStorage.setItem(fileIdKeyFor(campaignId), fileId);
  }

  // the backup file is separate from the main synced file and only ever
  // written by the Backup button (see backupNow) - never by auto-sync
  async function ensureBackupFile() {
    const campaignId = Store.getCurrentCampaignId();
    const campaignName = Store.getCurrentCampaignName();
    const folder = await ensureFolder();
    const expectedName = backupFileNameFor(campaignName);

    if (backupFileId) {
      if (await fileNameMatches(backupFileId, expectedName)) return backupFileId;
      backupFileId = null;
    }

    const found = await findFileByName(expectedName, folder);
    backupFileId = found || await createFileByName(expectedName, folder);
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

  async function resolveFolder() {
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
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
    let query = `name='${name}' and trashed=false`;
    if (inFolderId) query += ` and '${inFolderId}' in parents`;
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

  async function createFileByName(name, inFolderId) {
    const metadata = { name, mimeType: 'application/json', parents: [inFolderId] };
    const boundary = 'rpgnotes-boundary';
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${Store.exportJSON()}\r\n` +
      `--${boundary}--`;
    const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const data = await res.json();
    return data.id;
  }

  async function pull() {
    if (!fileId) return;
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const text = await res.text();
    if (!text.trim()) return;

    suppressUpload = true;
    try {
      Store.importJSON(text);
    } catch (err) {
      // the remote file is in a shape Store can't read (e.g. an older
      // export format) - keep the local data and overwrite the remote
      // file with it instead of failing the whole connection
      console.warn('Could not read the Drive file, overwriting it with local data instead.', err);
      suppressUpload = false;
      await push();
      return;
    }
    suppressUpload = false;
  }

  // automatically uploads to Drive a short while after the last change.
  // Queued (see header comment) so it can't fire mid-way through a
  // campaign switch and use a fileId that's about to change.
  function scheduleUpload() {
    if (suppressUpload || !accessToken || !fileId) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => queueSync(() => push()), UPLOAD_DEBOUNCE_MS);
  }

  async function push() {
    if (!accessToken || !fileId) return;
    setStatus('syncing');
    try {
      await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: Store.exportJSON()
      });
      setStatus('connected');
    } catch (err) {
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
      body: Store.exportJSON()
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
  Store.subscribe(scheduleUpload);

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
      // switched to a different campaign entirely - point at its own files
      syncedCampaignId = newCampaignId;
      syncedCampaignName = newCampaignName;
      clearTimeout(uploadTimer);
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

  return { init, connect, disconnect, syncNow, backupNow, isConfigured };
})();
