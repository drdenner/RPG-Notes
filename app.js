// app.js
// Limer views sammen med Store: initialiserer begge visninger, sørger for
// at de altid gen-tegnes samlet når data ændres (uanset hvilken der er synlig),
// styrer tab-skift, samt eksport/import af JSON.

document.addEventListener('DOMContentLoaded', () => {
  const treeContainer = document.getElementById('tree-view');
  const mindmapContainer = document.getElementById('mindmap-view');
  const tabListBtn = document.getElementById('tab-list-btn');
  const tabMindmapBtn = document.getElementById('tab-mindmap-btn');

  TreeView.init(treeContainer);
  MindmapView.init(mindmapContainer);

  function renderAll() {
    TreeView.render();
    MindmapView.render();
  }
  Store.subscribe(renderAll);
  renderAll();

  // --- tab-skift mellem Liste og Mindmap (samme underliggende data) ---
  function showView(name) {
    const isList = name === 'list';
    treeContainer.classList.toggle('active', isList);
    mindmapContainer.classList.toggle('active', !isList);
    tabListBtn.classList.toggle('active', isList);
    tabMindmapBtn.classList.toggle('active', !isList);
  }
  tabListBtn.addEventListener('click', () => showView('list'));
  tabMindmapBtn.addEventListener('click', () => showView('mindmap'));
  showView('list');

  // --- redigér/vis-tilstand ---
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  function updateModeUI(editMode) {
    document.body.classList.toggle('view-mode', !editMode);
    modeToggleBtn.textContent = editMode ? '👁 Vis-tilstand' : '✎ Redigér-tilstand';
    modeToggleBtn.classList.toggle('btn-primary', !editMode);
  }
  modeToggleBtn.addEventListener('click', () => AppMode.toggle());
  AppMode.subscribe(updateModeUI);
  updateModeUI(AppMode.isEditMode());

  // --- eksport til JSON-fil ---
  document.getElementById('export-btn').addEventListener('click', () => {
    const json = Store.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rpg-notes.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- import fra JSON-fil ---
  const importInput = document.getElementById('import-input');
  document.getElementById('import-btn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        Store.importJSON(reader.result);
      } catch (e) {
        alert('Kunne ikke importere filen: ' + e.message);
      }
      importInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- Google Drive-synkronisering (valgfri, se opsætning i drive-sync.js) ---
  const driveDot = document.getElementById('drive-dot');
  const driveStatusText = document.getElementById('drive-status-text');
  const driveConnectBtn = document.getElementById('drive-connect-btn');
  const driveSyncBtn = document.getElementById('drive-sync-btn');
  const driveDisconnectBtn = document.getElementById('drive-disconnect-btn');

  const DRIVE_LABELS = {
    unconfigured: 'Drive: ikke sat op',
    disconnected: 'Drive: ikke forbundet',
    connecting: 'Drive: forbinder…',
    connected: 'Drive: forbundet',
    syncing: 'Drive: gemmer…',
    error: 'Drive: fejl'
  };

  function updateDriveUI(status, detail) {
    driveDot.className = 'drive-dot drive-dot-' + status;
    driveStatusText.textContent = DRIVE_LABELS[status] || status;
    driveStatusText.parentElement.title = detail || '';

    const isConnectedish = status === 'connected' || status === 'syncing';
    driveConnectBtn.hidden = isConnectedish || status === 'connecting';
    driveSyncBtn.hidden = !isConnectedish;
    driveDisconnectBtn.hidden = !isConnectedish;
  }

  driveConnectBtn.addEventListener('click', () => {
    if (!DriveSync.isConfigured()) {
      alert('Google Drive-synkronisering er ikke sat op endnu.\n\nÅbn drive-sync.js og følg opsætnings-guiden øverst i filen for at få et Google Client ID.');
      return;
    }
    DriveSync.connect();
  });
  driveSyncBtn.addEventListener('click', () => DriveSync.syncNow());
  driveDisconnectBtn.addEventListener('click', () => DriveSync.disconnect());

  DriveSync.init(updateDriveUI);
});
