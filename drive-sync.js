// drive-sync.js
// Valgfri synkronisering af noterne via én JSON-fil i brugerens eget Google
// Drive, så man kan arbejde i de samme data på flere enheder (fx pc og
// tablet). Bruger scope 'drive.file', så appen KUN kan se/ændre filer den
// selv har oprettet - ikke resten af din Drive.
//
// FØRSTEGANGSOPSÆTNING (gøres én gang, af dig):
//   1. Gå til https://console.cloud.google.com/ og opret et projekt
//   2. Under "APIs & Services" -> aktivér "Google Drive API"
//   3. Under "OAuth consent screen": vælg "External", udfyld app-navn, og
//      tilføj din egen Google-konto som "Test user" (så skal appen ikke
//      igennem Googles fulde verificering for at du selv kan bruge den)
//   4. Under "Credentials" -> "Create credentials" -> "OAuth client ID"
//      -> vælg "Web application"
//   5. Under "Authorized JavaScript origins": tilføj den/de URL'er appen
//      køres fra. Google OAuth virker IKKE med file:// eller en lokal
//      IP-adresse over http - kun https://... eller http://localhost.
//      Nemmeste løsning: host mappen et sted med https (fx GitHub Pages)
//      og åbn den SAMME URL på både pc og tablet.
//   6. Kopiér det genererede "Client ID" ind i CLIENT_ID herunder.
//
// Uden et gyldigt Client ID virker resten af appen præcis som før - Drive
// er 100% valgfrit, og alt gemmes stadig lokalt i localStorage.

const DriveSync = (() => {
  const CLIENT_ID = '162521818251-4h6jcsqivhk66v0160l3u54sck8g16iq.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'rpg-notes.json';
  const FILE_ID_KEY = 'rpg-notes-drive-file-id';
  const UPLOAD_DEBOUNCE_MS = 1500;

  let tokenClient = null;
  let accessToken = null;
  let fileId = localStorage.getItem(FILE_ID_KEY) || null;
  let uploadTimer = null;
  let refreshPromise = null;
  let suppressUpload = false;
  let statusCallback = () => {};

  function isConfigured() {
    return !!CLIENT_ID && !CLIENT_ID.startsWith('DIT-');
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
      // har vi brugt Drive før på denne enhed, så prøv en stille genforbindelse
      if (fileId) {
        tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  function waitForGis(cb, attempts = 0) {
    if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
    if (attempts > 50) { setStatus('error', 'Kunne ikke indlæse Googles loginbibliotek'); return; }
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
      // filen findes ikke længere, fx fordi der er skiftet Google-konto ->
      // glem den gemte fil-reference og prøv at finde/oprette en frisk
      if (String(err.message).includes('404') && fileId) {
        fileId = null;
        localStorage.removeItem(FILE_ID_KEY);
        try {
          await ensureFile();
          await pull();
          setStatus('connected');
          return;
        } catch (err2) {
          console.error('Drive-synkronisering fejlede', err2);
          setStatus('error', err2.message);
          return;
        }
      }
      console.error('Drive-synkronisering fejlede', err);
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
    if (fileId) return;
    const found = await findFile();
    fileId = found || await createFile();
    localStorage.setItem(FILE_ID_KEY, fileId);
  }

  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`);
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0].id : null;
  }

  async function createFile() {
    const metadata = { name: FILE_NAME, mimeType: 'application/json' };
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
    if (text.trim()) {
      suppressUpload = true;
      Store.importJSON(text);
      suppressUpload = false;
    }
  }

  // uploader automatisk til Drive et lille stykke tid efter sidste ændring
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
      console.error('Kunne ikke gemme til Drive', err);
      setStatus('error', err.message);
    }
  }

  function syncNow() {
    if (!accessToken) { connect(); return; }
    push();
  }

  async function driveFetch(url, options = {}, retried = false) {
    options.headers = Object.assign({ Authorization: `Bearer ${accessToken}` }, options.headers);
    const res = await fetch(url, options);
    if (res.status === 401 && !retried) {
      await refreshToken();
      return driveFetch(url, options, true);
    }
    if (!res.ok) throw new Error(`Drive API-fejl (${res.status})`);
    return res;
  }

  // enhver ændring i noterne (opret/omdøb/slet/flyt) skal ende i Drive
  Store.subscribe(scheduleUpload);

  return { init, connect, disconnect, syncNow, isConfigured };
})();
