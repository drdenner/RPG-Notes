// drive-sync.js
// Optional sync of the notes via a single JSON file in the user's own
// Google Drive, so you can work on the same data across multiple devices
// (e.g. pc and tablet). Uses the 'drive.file' scope, so the app can only
// see/change files it created itself - not the rest of your Drive.
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
//
// There are two separate files in the Drive folder: FILE_NAME is kept in
// sync automatically on every change, while BACKUP_FILE_NAME is a manual
// snapshot that only ever changes when the Backup button calls backupNow().

const DriveSync = (() => {
  const CLIENT_ID = '162521818251-4h6jcsqivhk66v0160l3u54sck8g16iq.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'rpg-notes.json';
  const BACKUP_FILE_NAME = 'rpg-notes-backup.json'; // only ever written by the Backup button, never by auto-sync
  const FOLDER_NAME = 'RPG Notes'; // the Drive folder the file lives in - change here for a different name
  const FILE_ID_KEY = 'rpg-notes-drive-file-id';
  const BACKUP_FILE_ID_KEY = 'rpg-notes-drive-backup-file-id';
  const FOLDER_ID_KEY = 'rpg-notes-drive-folder-id';
  const UPLOAD_DEBOUNCE_MS = 10000;

  let tokenClient = null;
  let accessToken = null;
  let fileId = localStorage.getItem(FILE_ID_KEY) || null;
  let backupFileId = localStorage.getItem(BACKUP_FILE_ID_KEY) || null;
  let folderId = localStorage.getItem(FOLDER_ID_KEY) || null;
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
      // used Drive before on this device? try a silent reconnect
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

  async function onTokenResponse(resp) {
    if (resp.error) {
      setStatus(fileId ? 'disconnected' : 'error', resp.error);
      return;
    }
    accessToken = resp.access_token;
    try {
      await ensureFile();
      await pull();
      setStatus('connected');
    } catch (err) {
      // the file no longer exists, e.g. because a different Google account
      // was used -> forget the saved file reference and try a fresh one
      if (String(err.message).includes('404') && fileId) {
        fileId = null;
        localStorage.removeItem(FILE_ID_KEY);
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
    const folder = await ensureFolder();

    if (fileId) {
      // already know the file - make sure it actually lives in the folder
      // (e.g. moves an older file that was created in the root before the
      // folder existed)
      await moveFileToFolder(fileId, folder);
      return;
    }

    const foundInFolder = await findFileByName(FILE_NAME, folder);
    if (foundInFolder) {
      fileId = foundInFolder;
    } else {
      // fallback: a file created before folder support existed might still
      // be sitting somewhere else on Drive - reuse it instead of creating a
      // new one (and ending up with two copies of the notes)
      const foundAnywhere = await findFileByName(FILE_NAME, null);
      if (foundAnywhere) {
        fileId = foundAnywhere;
        await moveFileToFolder(fileId, folder);
      } else {
        fileId = await createFileByName(FILE_NAME, folder);
      }
    }
    localStorage.setItem(FILE_ID_KEY, fileId);
  }

  // the backup file is separate from the main synced file and only ever
  // written by the Backup button (see backupNow) - never by auto-sync
  async function ensureBackupFile() {
    if (backupFileId) return backupFileId;
    const folder = await ensureFolder();
    const found = await findFileByName(BACKUP_FILE_NAME, folder);
    backupFileId = found || await createFileByName(BACKUP_FILE_NAME, folder);
    localStorage.setItem(BACKUP_FILE_ID_KEY, backupFileId);
    return backupFileId;
  }

  async function ensureFolder() {
    if (folderId) return folderId;
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

  // automatically uploads to Drive a short while after the last change
  function scheduleUpload() {
    if (suppressUpload || !accessToken || !fileId) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(push, UPLOAD_DEBOUNCE_MS);
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
    push();
  }

  // writes the current notes to the separate backup file. Unlike the main
  // synced file, this one is NEVER touched by auto-sync (scheduleUpload) -
  // it only ever changes when this is called, i.e. when the Backup button
  // is pressed.
  async function backupNow() {
    if (!accessToken) { connect(); throw new Error('Not connected to Drive yet - try again once connected.'); }
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

  return { init, connect, disconnect, syncNow, backupNow, isConfigured };
})();
