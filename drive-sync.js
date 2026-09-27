// drive-sync.js
// Optional sync of the notes via Google Drive, so you can work on the same
// data across multiple devices (e.g. pc and tablet). Uses the 'drive.file'
// scope, so the app can only see/change files it created itself - not the
// rest of your Drive.
//
// Every campaign (see store.js) is one file, "<campaign name>.json", in the
// Drive folder "RPG Notes". Files are always looked up by that name - no
// Drive file ids are remembered between sessions. Renaming a campaign
// renames its file (a rename made while not connected is remembered and
// done on the next connect; a name that's already taken on Drive is
// refused, since two campaigns sharing a file would overwrite each other).
// Deleting a campaign moves its file to Drive's trash.
//
// Newest wins: every campaign carries an "updatedAt" timestamp (set by
// Store on every change, and written into the file). Syncing a campaign
// compares the local one with the file's, and whichever is newer
// overwrites the other. That happens for the current campaign on connect
// and on every campaign switch, and for ALL campaigns on "Sync now" (which
// also fetches campaigns that only exist on Drive). In between, edits to
// the current campaign are uploaded automatically without re-checking.
//
// While connected, it also keeps a list of the campaign files on Drive, so
// the campaign dropdown can show campaigns that aren't on this device (☁)
// and fetch one when it's picked (downloadCampaign). "Remove from this
// device" (removeFromDevice) is the reverse: it syncs a campaign to Drive
// and only deletes the local copy once Drive has confirmed the latest
// version - the Drive file is kept.
//
// Every Drive operation runs through `queueSync()`, one after another, so
// e.g. a campaign switch can't run in the middle of a connect and mix up
// which campaign `fileId` belongs to.
//
// When the Google sign-in expires (after about an hour), the status shows
// "sign in again" and the user clicks Connect. Nothing is lost meanwhile:
// local edits are stamped with updatedAt, so the next sync uploads them.
// To know which campaigns those are, every local edit marks its campaign
// as "unsynced" (saved in localStorage, so it survives a reload) until
// that version has reached Drive - reconnecting syncs all of them, and
// hasUnsyncedChanges() lets the UI warn that Drive is behind.
//
// Without internet the status is "offline" (not an error): edits are
// saved on the device and marked unsynced as usual, and when the browser
// reports it's back online, everything unsynced is synced automatically.
// If the app was started offline, Google's sign-in library couldn't load -
// it's loaded then instead.
//
// ONE-TIME SETUP: see "Google Drive sync" in README.md for how to get a
// Google OAuth Client ID - it goes into CLIENT_ID below.
//
// Without a valid Client ID, the rest of the app works exactly as before -
// Drive is 100% optional, everything still saves locally in localStorage.

const DriveSync = (() => {
  const CLIENT_ID = '162521818251-4h6jcsqivhk66v0160l3u54sck8g16iq.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'RPG Notes'; // the Drive folder every campaign's file lives in
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const CONNECTED_KEY = 'rpg-notes-drive-connected'; // set on connect, cleared by Disconnect
  const UNSYNCED_KEY = 'rpg-notes-drive-unsynced'; // ids of campaigns with edits not on Drive yet
  const RENAMES_KEY = 'rpg-notes-drive-renames'; // { campaignId: name its Drive file still has } for renames not done there yet
  const UPLOAD_DEBOUNCE_MS = 10000;
  const GIS_URL = 'https://accounts.google.com/gsi/client'; // Google's sign-in library (also in index.html)

  function fileNameFor(campaignName) { return `${Store.sanitizeFileName(campaignName)}.json`; }
  function campaignNameOf(fileName) { return fileName.slice(0, -'.json'.length); }

  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  let syncedCampaignId = Store.getCurrentCampaignId(); // the campaign `fileId` belongs to
  let syncedCampaignName = Store.getCurrentCampaignName();
  let fileId = null; // its Drive file, once synced this session; null = don't upload
  let syncQueue = Promise.resolve();
  let uploadTimer = null;
  let statusCallback = () => {};
  let lastStatus = 'disconnected';
  let lastDetail = '';
  // file names of every campaign on Drive, as of the last listing (empty
  // while not connected) - see getDriveOnlyCampaigns
  let remoteFileNames = [];
  const remoteListeners = [];

  function isConfigured() {
    return !!CLIENT_ID && !CLIENT_ID.startsWith('YOUR-');
  }

  function setStatus(status, detail) {
    lastStatus = status;
    lastDetail = detail || '';
    statusCallback(lastStatus, lastDetail);
  }

  // --- campaigns with local edits that aren't on Drive yet ---

  const unsyncedIds = new Set(readUnsynced());

  function readUnsynced() {
    try {
      const ids = JSON.parse(localStorage.getItem(UNSYNCED_KEY) || '[]');
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      return [];
    }
  }

  // saves the set, and re-sends the status when it goes from empty to
  // non-empty or back, so the UI can update its warning
  function updateUnsynced(fn) {
    const had = hasUnsyncedChanges();
    fn();
    try { localStorage.setItem(UNSYNCED_KEY, JSON.stringify([...unsyncedIds])); } catch (e) { /* ignore */ }
    if (had !== hasUnsyncedChanges()) statusCallback(lastStatus, lastDetail);
  }

  // `updatedAt` is the campaign's version that just reached Drive (or came
  // from it) - if it has been edited again since, it stays unsynced
  function markSynced(campaignId, updatedAt) {
    if (unsyncedIds.has(campaignId) && Store.getUpdatedAt(campaignId) === updatedAt) {
      updateUnsynced(() => unsyncedIds.delete(campaignId));
    }
  }

  function hasUnsyncedChanges() {
    const ids = new Set(Store.listCampaigns().map(c => c.id));
    return [...unsyncedIds].some(id => ids.has(id));
  }

  // --- renames that haven't reached Drive yet ---

  const pendingRenames = readPendingRenames();

  function readPendingRenames() {
    try {
      const map = JSON.parse(localStorage.getItem(RENAMES_KEY) || '{}');
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch (e) {
      return {};
    }
  }

  function savePendingRenames() {
    try { localStorage.setItem(RENAMES_KEY, JSON.stringify(pendingRenames)); } catch (e) { /* ignore */ }
  }

  // remembers the (campaign) name the campaign's Drive file still has -
  // the first one, if it's renamed several times before the next connect
  function rememberRename(campaignId, oldName) {
    if (!(campaignId in pendingRenames)) {
      pendingRenames[campaignId] = oldName;
      savePendingRenames();
    }
  }

  // renames the campaign's Drive file from `oldName`'s file name to its
  // current name's. If that name is already taken on Drive, the Drive file
  // keeps its name and the campaign is renamed back to `oldName` here
  // instead. `id` = the file's id, if already known.
  async function renameOnDrive(campaignId, oldName, id) {
    const campaign = Store.listCampaigns().find(c => c.id === campaignId);
    if (!campaign) return;
    const oldFileName = fileNameFor(oldName);
    const newFileName = fileNameFor(campaign.name);
    if (newFileName === oldFileName) return;
    id = id || await findFile(oldFileName);
    if (!id) return;
    const clash = await findFile(newFileName);
    if (clash && clash !== id) {
      // (so the campaign-change handler doesn't treat the undo as a new rename)
      if (campaignId === syncedCampaignId) syncedCampaignName = oldName;
      Store.renameCampaign(campaignId, oldName);
      alert(`There's already a campaign called "${campaign.name}" on Google Drive, so the campaign kept its old name "${oldName}".`);
      return;
    }
    await renameFile(id, newFileName);
    setRemoteFileNames(remoteFileNames.map(n => n === oldFileName ? newFileName : n));
  }

  // renames made while not connected
  async function applyPendingRenames() {
    for (const [campaignId, oldName] of Object.entries(pendingRenames)) {
      await renameOnDrive(campaignId, oldName);
      delete pendingRenames[campaignId];
      savePendingRenames();
    }
  }

  // --- campaigns that are on Drive but not on this device ---

  function subscribeRemoteCampaigns(fn) {
    remoteListeners.push(fn);
  }

  function setRemoteFileNames(names) {
    remoteFileNames = names;
    remoteListeners.forEach(fn => fn());
  }

  // names of the campaigns on Drive that aren't on this device (computed
  // live, so a campaign that was just added/removed locally is right away)
  function getDriveOnlyCampaigns() {
    const localFileNames = new Set(Store.listCampaigns().map(c => fileNameFor(c.name)));
    return remoteFileNames.filter(n => !localFileNames.has(n)).map(campaignNameOf);
  }

  // is `name` taken by a campaign that's only on Drive? (as far as the last
  // listing knows - renameOnDrive checks Drive itself before renaming)
  function isNameOnDrive(name) {
    return getDriveOnlyCampaigns().some(n => fileNameFor(n) === fileNameFor(name));
  }

  async function refreshRemoteList() {
    setRemoteFileNames((await listCampaignFiles()).map(f => f.name));
  }

  // runs fn() after every previously queued operation has finished
  // (successfully or not), so they never run concurrently
  function queueSync(fn) {
    syncQueue = syncQueue.then(fn, fn);
    return syncQueue;
  }

  // errors from the expired sign-in / a lost connection have already set
  // the 'reauth' / 'offline' status
  function reportError(err) {
    if (err.reauth || err.offline) return;
    console.error('Drive sync failed', err);
    setStatus('error', err.message);
  }

  // --- sign-in ---

  // status: 'unconfigured' | 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error'
  //       | 'reauth' (the sign-in expired - the user has to click Connect again)
  //       | 'offline' (no internet - edits wait on the device)
  function init(onStatusChange) {
    statusCallback = onStatusChange || statusCallback;
    if (!isConfigured()) {
      setStatus('unconfigured');
      return;
    }
    waitForGis(setUpTokenClient);
  }

  function setUpTokenClient() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: onTokenResponse,
      error_callback: onTokenError // popup blocked/closed - GIS only reports these here
    });
    setStatus('disconnected');
    // connected last time? try to reconnect without asking
    if (localStorage.getItem(CONNECTED_KEY)) {
      setStatus('connecting');
      tokenClient.requestAccessToken({ prompt: '' });
    }
  }

  function waitForGis(cb, attempts = 0) {
    if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
    if (attempts > 50) {
      // most likely started without internet - loaded again when back online
      setStatus(navigator.onLine ? 'error' : 'offline', 'Could not load Google\'s sign-in library');
      return;
    }
    setTimeout(() => waitForGis(cb, attempts + 1), 100);
  }

  function loadGis() {
    const script = document.createElement('script');
    script.src = GIS_URL;
    script.async = true;
    document.head.appendChild(script);
    waitForGis(setUpTokenClient);
  }

  window.addEventListener('offline', () => {
    if (accessToken || lastStatus === 'connecting') setStatus('offline');
  });

  // back online: sync what was edited meanwhile (the sign-in usually
  // survives a short offline spell); load the sign-in library if the app
  // was started offline
  window.addEventListener('online', () => {
    if (!isConfigured()) return;
    if (accessToken) {
      setStatus('connecting');
      queueSync(() => connectCurrentCampaign());
    } else if (!tokenClient) {
      loadGis();
    } else if (localStorage.getItem(CONNECTED_KEY)) {
      setStatus('reauth'); // needs a tap (Reconnect) - browsers block the popup otherwise
    }
  });

  function connect() {
    if (!tokenClient) return;
    setStatus('connecting');
    tokenClient.requestAccessToken({ prompt: '' });
  }

  function onTokenResponse(resp) {
    if (resp.error) {
      setStatus('disconnected', resp.error);
      return;
    }
    accessToken = resp.access_token;
    localStorage.setItem(CONNECTED_KEY, '1');
    queueSync(() => connectCurrentCampaign());
  }

  function onTokenError(err) {
    const reason = (err && err.type) || 'sign-in failed';
    if (!navigator.onLine) setStatus('offline', reason);
    else setStatus(localStorage.getItem(CONNECTED_KEY) ? 'reauth' : 'disconnected', reason);
  }

  // uploads a pending change first, and remembers the choice so the next
  // page load doesn't reconnect by itself
  function disconnect() {
    localStorage.removeItem(CONNECTED_KEY);
    const hadPendingUpload = !!uploadTimer;
    clearTimeout(uploadTimer); uploadTimer = null;
    return queueSync(async () => {
      if (hadPendingUpload) await push();
      if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
      accessToken = null;
      fileId = null;
      setRemoteFileNames([]);
      setStatus('disconnected');
    });
  }

  // --- syncing ---

  async function connectCurrentCampaign() {
    fileId = null;
    try {
      await applyPendingRenames();
      if (syncedCampaignId) {
        const found = await findFile(fileNameFor(syncedCampaignName));
        fileId = await syncCampaign(syncedCampaignId, syncedCampaignName, found);
      }
      // other campaigns edited while the sign-in had expired
      for (const campaign of Store.listCampaigns()) {
        if (!unsyncedIds.has(campaign.id) || campaign.id === syncedCampaignId) continue;
        try {
          await syncCampaign(campaign.id, campaign.name, await findFile(fileNameFor(campaign.name)));
        } catch (err) {
          if (!err.unreadable) throw err; // an unreadable file is reported by "Sync now"
        }
      }
      await refreshRemoteList();
      setStatus('connected');
    } catch (err) {
      if (err.unreadable) alert(err.message + ' Syncing is paused for this campaign until the next sync.');
      reportError(err);
    }
  }

  // newest wins (see header comment) for one campaign. ISO timestamps
  // compare correctly as strings; a missing one counts as oldest, and if
  // neither side has one, Drive wins. Creates the file if `id` is null.
  // Returns the file id. An unreadable file is never overwritten - that
  // throws an error with `unreadable` set instead.
  // Every path ends with Drive and this device holding the same version,
  // which markSynced records (unless it was edited again meanwhile).
  async function syncCampaign(campaignId, campaignName, id) {
    if (!id) {
      const localAt = Store.getUpdatedAt(campaignId);
      const newId = await createFile(fileNameFor(campaignName), Store.exportJSON(campaignId));
      markSynced(campaignId, localAt);
      return newId;
    }
    const text = await downloadFile(id);
    const localAt = Store.getUpdatedAt(campaignId); // read after the download: the version compared (and uploaded) below
    if (!text.trim()) {
      await uploadFile(id, Store.exportJSON(campaignId));
      markSynced(campaignId, localAt);
      return id;
    }
    const data = parseOrNull(text);
    if (!data) throw unreadableError(campaignName, 'not valid JSON');
    const remoteTime = typeof data.updatedAt === 'string' ? data.updatedAt : '';
    const localTime = localAt || '';
    if (localTime > remoteTime) {
      await uploadFile(id, Store.exportJSON(campaignId));
      markSynced(campaignId, localAt);
    } else if (remoteTime > localTime || !localTime) {
      try {
        Store.setCampaignData(campaignId, data);
      } catch (err) {
        throw unreadableError(campaignName, err.message);
      }
      markSynced(campaignId, Store.getUpdatedAt(campaignId)); // Drive's version, now local
    } else {
      markSynced(campaignId, localAt); // equal timestamps: already in sync
    }
    return id;
  }

  function parseOrNull(text) {
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      return null;
    }
  }

  function unreadableError(campaignName, reason) {
    const err = new Error(`Could not read "${campaignName}" from Google Drive (${reason}). The Drive file was left untouched.`);
    err.unreadable = true;
    return err;
  }

  // "Sync now": newest wins for every local campaign, then adds the
  // campaigns that only exist on Drive. A file that can't be read is left
  // alone and reported. Resolves with { added, failed } (failed = names).
  function syncNow() {
    if (!accessToken) { connect(); return Promise.resolve(null); }
    clearTimeout(uploadTimer); uploadTimer = null; // the sync uploads it anyway
    return queueSync(() => doSyncAll());
  }

  async function doSyncAll() {
    setStatus('syncing');
    try {
      await applyPendingRenames(); // so every campaign is found under its current name
      const files = await listCampaignFiles();
      const failed = [];
      for (const c of Store.listCampaigns()) {
        const file = files.find(f => f.name === fileNameFor(c.name));
        try {
          const id = await syncCampaign(c.id, c.name, file ? file.id : null);
          if (c.id === syncedCampaignId) fileId = id;
        } catch (err) {
          if (!err.unreadable) throw err;
          failed.push(c.name);
        }
      }

      const localFileNames = new Set(Store.listCampaigns().map(c => fileNameFor(c.name)));
      let added = 0;
      for (const f of files) {
        if (localFileNames.has(f.name)) continue;
        try {
          Store.addCampaignFromData(campaignNameOf(f.name), parseOrNull(await downloadFile(f.id)));
          added++;
        } catch (err) {
          if (err.reauth) throw err;
          failed.push(campaignNameOf(f.name));
        }
      }

      setRemoteFileNames(files.map(f => f.name));
      setStatus('connected');
      return { added, failed };
    } catch (err) {
      reportError(err);
      throw err;
    }
  }

  // "Pull from Drive": replaces ALL local campaigns with the ones on Drive
  // (the caller confirms with the user first). A pending upload is
  // dropped - the point is that Drive wins. Resolves with
  // { campaigns, skipped } from Store.replaceAllCampaigns; the campaign
  // switch that causes is queued right behind and connects the new one.
  function pullAllFromDrive() {
    if (!accessToken) return Promise.reject(new Error('Not connected to Drive.'));
    clearTimeout(uploadTimer); uploadTimer = null;
    return queueSync(() => doPullAll());
  }

  async function doPullAll() {
    setStatus('syncing');
    try {
      const entries = [];
      const files = await listCampaignFiles();
      for (const f of files) {
        entries.push({ name: campaignNameOf(f.name), data: parseOrNull(await downloadFile(f.id)) });
      }
      const result = Store.replaceAllCampaigns(entries);
      updateUnsynced(() => unsyncedIds.clear());
      fileId = null;
      setRemoteFileNames(files.map(f => f.name));
      setStatus('connected');
      return result;
    } catch (err) {
      reportError(err);
      throw err;
    }
  }

  // fetches a campaign that's only on Drive (picked from the dropdown) onto
  // this device. Resolves with its local campaign id; the caller switches
  // to it, which syncs it as usual.
  function downloadCampaign(name) {
    if (!accessToken) return Promise.reject(new Error('Not connected to Google Drive - click Connect Drive.'));
    return queueSync(async () => {
      setStatus('syncing');
      try {
        const id = await findFile(fileNameFor(name));
        if (!id) throw new Error(`"${name}" is no longer on Google Drive.`);
        const data = parseOrNull(await downloadFile(id));
        let campaignId;
        try {
          campaignId = Store.addCampaignFromData(name, data);
        } catch (err) {
          throw unreadableError(name, err.message);
        }
        setStatus('connected');
        return campaignId;
      } catch (err) {
        reportError(err);
        throw err;
      }
    });
  }

  // "Remove from this device": makes sure Drive has the campaign's latest
  // version (newest wins, like any sync), and only then deletes the local
  // copy - without trashing the Drive file. If anything fails (offline,
  // sign-in expired, unreadable Drive file), nothing is deleted.
  function removeFromDevice(campaignId) {
    if (!accessToken) return Promise.reject(new Error('Not connected to Google Drive - click Connect Drive.'));
    if (campaignId === syncedCampaignId) { clearTimeout(uploadTimer); uploadTimer = null; } // uploaded below anyway
    return queueSync(async () => {
      if (!Store.listCampaigns().some(c => c.id === campaignId)) return;
      setStatus('syncing');
      try {
        await applyPendingRenames();
        // looked up after the renames, which can change its name back
        const campaign = Store.listCampaigns().find(c => c.id === campaignId);
        let id = await findFile(fileNameFor(campaign.name));
        // sync again if it was edited while the upload was running, so that
        // edit isn't lost when the local copy is deleted
        let before;
        do {
          before = Store.getUpdatedAt(campaignId);
          id = await syncCampaign(campaignId, campaign.name, id);
        } while (Store.getUpdatedAt(campaignId) !== before);

        if (campaignId === syncedCampaignId) fileId = null; // nothing left to upload for it
        const fileName = fileNameFor(campaign.name);
        if (!remoteFileNames.includes(fileName)) remoteFileNames = [...remoteFileNames, fileName];
        Store.deleteCampaign(campaignId, { localOnly: true });
        setRemoteFileNames(remoteFileNames); // it's now a ☁ campaign
        setStatus('connected');
      } catch (err) {
        reportError(err);
        throw err;
      }
    });
  }

  // --- automatic upload of local edits ---

  function push({ keepalive = false } = {}) {
    if (!accessToken || !fileId) return Promise.resolve();
    setStatus('syncing');
    const campaignId = syncedCampaignId;
    const uploadedAt = Store.getUpdatedAt(campaignId);
    return uploadFile(fileId, Store.exportJSON(campaignId), { keepalive })
      .then(() => { markSynced(campaignId, uploadedAt); setStatus('connected'); }, reportError);
  }

  // uploads the current campaign a short while after the last change.
  // Data that came from outside (Drive, or another tab - which uploads it
  // itself) isn't uploaded back. While Drive is in use (even with an
  // expired sign-in), every edit marks its campaign unsynced until it has
  // been uploaded.
  Store.subscribe(change => {
    if (change.external) return;
    const campaignId = Store.getCurrentCampaignId();
    if (localStorage.getItem(CONNECTED_KEY) && campaignId && !unsyncedIds.has(campaignId)) {
      updateUnsynced(() => unsyncedIds.add(campaignId));
    }
    if (!accessToken || !fileId) return;
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => {
      uploadTimer = null;
      queueSync(() => push());
    }, UPLOAD_DEBOUNCE_MS);
  });

  // the debounced upload would never reach Drive if the tab is closed (or
  // the tablet goes to sleep) within those 10 seconds - so flush it as soon
  // as the page is hidden, which browsers reliably report before unloading
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !uploadTimer) return;
    clearTimeout(uploadTimer);
    uploadTimer = null;
    queueSync(() => push({ keepalive: true }));
  });

  // --- campaign switch / rename / delete ---

  // fires when the active campaign changes OR the current one is renamed
  Store.subscribeCampaignChange(() => {
    queueSync(() => handleCampaignChange());
  });

  async function handleCampaignChange() {
    const newCampaignId = Store.getCurrentCampaignId();
    const newCampaignName = Store.getCurrentCampaignName();

    if (newCampaignId !== syncedCampaignId) {
      // upload a pending edit of the campaign we're leaving first (push()
      // still uses its id and fileId) - unless it was just deleted
      if (uploadTimer) {
        clearTimeout(uploadTimer);
        uploadTimer = null;
        if (Store.listCampaigns().some(c => c.id === syncedCampaignId)) await push();
      }
      syncedCampaignId = newCampaignId;
      syncedCampaignName = newCampaignName;
      fileId = null;
      if (!accessToken) return;
      setStatus('connecting');
      await connectCurrentCampaign();
      return;
    }

    if (newCampaignName !== syncedCampaignName) {
      const oldName = syncedCampaignName;
      syncedCampaignName = newCampaignName;
      if (!accessToken) {
        rememberRename(newCampaignId, oldName); // done on the next connect
        return;
      }
      try {
        await renameOnDrive(newCampaignId, oldName, fileId);
      } catch (err) {
        rememberRename(newCampaignId, oldName);
        reportError(err);
      }
    }
  }

  // moves a deleted campaign's file to Drive's trash (recoverable there)
  Store.subscribeCampaignDeleted((campaignId, campaignName) => {
    if (unsyncedIds.has(campaignId)) updateUnsynced(() => unsyncedIds.delete(campaignId));
    // a rename that never reached Drive: the file still has the old name
    const fileName = fileNameFor(pendingRenames[campaignId] || campaignName);
    delete pendingRenames[campaignId];
    savePendingRenames();
    queueSync(async () => {
      if (!accessToken) return;
      try {
        const id = await findFile(fileName);
        if (id) await patchFile(id, { trashed: true });
        setRemoteFileNames(remoteFileNames.filter(n => n !== fileName));
      } catch (err) {
        console.error('Could not move the campaign\'s Drive file to the trash', err);
      }
    });
  });

  // --- Drive API ---

  async function driveFetch(url, options = {}) {
    options.headers = Object.assign({ Authorization: `Bearer ${accessToken}` }, options.headers);
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      // no connection at all (fetch only rejects on network failure)
      setStatus('offline');
      const err = new Error('No internet connection. Your changes are saved on this device and uploaded when you\'re back online.');
      err.offline = true;
      throw err;
    }
    if (res.status === 401) {
      accessToken = null;
      fileId = null;
      clearTimeout(uploadTimer); uploadTimer = null;
      setRemoteFileNames([]);
      setStatus('reauth', 'The Google sign-in expired');
      const err = new Error('The Google sign-in expired - click Connect Drive.');
      err.reauth = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Drive API error (${res.status})`);
    return res;
  }

  // escapes a value for use inside '...' in a Drive search query - an
  // unescaped apostrophe (e.g. "Borin's Tavern") otherwise breaks the query
  function queryString(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
  }

  async function queryFiles(query) {
    const q = encodeURIComponent(query);
    const files = [];
    let pageToken = '';
    do {
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&pageSize=1000&orderBy=name&fields=nextPageToken,files(id,name)` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''));
      const data = await res.json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async function ensureFolder() {
    if (folderId) return folderId;
    const found = await queryFiles(`name=${queryString(FOLDER_NAME)} and mimeType='${FOLDER_MIME}' and trashed=false`);
    if (found.length) {
      folderId = found[0].id;
    } else {
      const res = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME })
      });
      folderId = (await res.json()).id;
    }
    return folderId;
  }

  async function findFile(name) {
    const folder = await ensureFolder();
    const found = await queryFiles(`name=${queryString(name)} and ${queryString(folder)} in parents and trashed=false`);
    return found.length ? found[0].id : null;
  }

  // every campaign file in the folder - not Backup snapshots or conflict
  // copies left by older versions of the app, nor a second file with a
  // name that's already taken
  async function listCampaignFiles() {
    const folder = await ensureFolder();
    const files = await queryFiles(`${queryString(folder)} in parents and trashed=false and mimeType!='${FOLDER_MIME}'`);
    const seen = new Set();
    return files.filter(f => {
      if (!f.name.endsWith('.json') || f.name.endsWith('-backup.json') || f.name.includes('-conflict-') || seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });
  }

  async function downloadFile(id) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    return res.text();
  }

  // `keepalive` lets the request outlive the page if it's being closed -
  // browsers only allow that for bodies under 64 KB, so larger campaigns
  // fall back to a normal request (which usually still completes when the
  // tab is merely hidden)
  async function uploadFile(id, body, { keepalive = false } = {}) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: keepalive && new Blob([body]).size < 60000
    });
  }

  async function createFile(name, content) {
    const metadata = { name, mimeType: 'application/json', parents: [await ensureFolder()] };
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
    return (await res.json()).id;
  }

  function renameFile(id, newName) {
    return patchFile(id, { name: newName });
  }

  function patchFile(id, metadata) {
    return driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata)
    });
  }

  return {
    init, connect, disconnect, syncNow, pullAllFromDrive, isConfigured, hasUnsyncedChanges, isNameOnDrive,
    subscribeRemoteCampaigns, getDriveOnlyCampaigns, downloadCampaign, removeFromDevice
  };
})();
