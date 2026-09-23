// app.js
// Glues the views together with the Store: initializes both views, makes
// sure they're always re-rendered together whenever data changes
// (regardless of which one is visible), drives tab switching, edit/view
// mode, and JSON export/import.

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

  // --- switch between List and Mindmap tabs (same underlying data) ---
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

  // --- edit/view mode ---
  const modeToggleBtn = document.getElementById('mode-toggle-btn');
  function updateModeUI(editMode) {
    document.body.classList.toggle('view-mode', !editMode);
    modeToggleBtn.textContent = editMode ? '👁 View mode' : '✎ Edit mode';
    modeToggleBtn.classList.toggle('btn-primary', !editMode);
  }
  modeToggleBtn.addEventListener('click', () => AppMode.toggle());
  AppMode.subscribe(updateModeUI);
  updateModeUI(AppMode.isEditMode());

  // --- export to a JSON file ---
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

  // --- import from a JSON file ---
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
        alert('Could not import the file: ' + e.message);
      }
      importInput.value = '';
    };
    reader.readAsText(file);
  });

  // --- Google Drive sync (optional, see setup guide in drive-sync.js) ---
  const driveDot = document.getElementById('drive-dot');
  const driveStatusText = document.getElementById('drive-status-text');
  const driveConnectBtn = document.getElementById('drive-connect-btn');
  const driveSyncBtn = document.getElementById('drive-sync-btn');
  const driveDisconnectBtn = document.getElementById('drive-disconnect-btn');

  const DRIVE_LABELS = {
    unconfigured: 'Drive: not set up',
    disconnected: 'Drive: not connected',
    connecting: 'Drive: connecting…',
    connected: 'Drive: connected',
    syncing: 'Drive: saving…',
    error: 'Drive: error'
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
      alert('Google Drive sync isn\'t set up yet.\n\nOpen drive-sync.js and follow the setup guide at the top of the file to get a Google Client ID.');
      return;
    }
    DriveSync.connect();
  });
  driveSyncBtn.addEventListener('click', () => DriveSync.syncNow());
  driveDisconnectBtn.addEventListener('click', () => DriveSync.disconnect());

  DriveSync.init(updateDriveUI);
});
