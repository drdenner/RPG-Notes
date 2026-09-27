// app.js
// Glues the views together with the Store: initializes both views, keeps
// whichever one is currently visible in sync with data changes (the other
// just gets caught up when you switch to it, see renderAll/showView),
// drives navigation between the list and a main node's mindmap, edit/view
// mode, and the Google Drive buttons.

document.addEventListener('DOMContentLoaded', () => {
  const treeContainer = document.getElementById('tree-view');
  const mindmapContainer = document.getElementById('mindmap-view');

  TreeView.init(treeContainer, { onOpenMindmap: openMindmap });
  MindmapView.init(mindmapContainer, { onBack: closeMindmap, onSwitch: switchMindmap });

  // only the visible view is actually re-rendered when data changes; the
  // other one is marked dirty and catches up the moment you switch to it
  // (see showView below) - no point doing render work for a view nobody
  // is looking at right now
  // (the mindmap needs no dirty flag: showView always re-renders it via
  // MindmapView.open)
  let activeView = 'list';
  let treeDirty = false;

  function renderAll() {
    if (activeView === 'list') {
      TreeView.render();
      return;
    }
    treeDirty = true;
    if (!Store.getById(MindmapView.getMainNodeId())) {
      route(); // its main node was deleted, or the campaign switched: back to the list
    } else {
      MindmapView.render();
    }
  }
  Store.subscribe(renderAll);
  Store.subscribeCampaignChange(renderAll);
  renderAll();

  // --- campaign switcher: multiple independent campaigns, one active at a time ---
  const campaignSelect = document.getElementById('campaign-select');
  const campaignNewBtn = document.getElementById('campaign-new-btn');
  const campaignRenameBtn = document.getElementById('campaign-rename-btn');
  const campaignDeleteBtn = document.getElementById('campaign-delete-btn');
  const campaignRemoveLocalBtn = document.getElementById('campaign-remove-local-btn');
  // dropdown values of campaigns that are only on Drive (not local campaign ids)
  const DRIVE_OPTION_PREFIX = 'drive:';
  let driveConnected = false; // kept up to date by updateDriveUI below

  function updateCampaignUI() {
    const campaigns = Store.listCampaigns();
    const currentId = Store.getCurrentCampaignId();
    const driveOnly = DriveSync.getDriveOnlyCampaigns();
    campaignSelect.innerHTML = '';
    if (campaigns.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No campaigns';
      campaignSelect.appendChild(option);
    }
    campaigns.forEach(c => {
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = c.name;
      if (c.id === currentId) option.selected = true;
      campaignSelect.appendChild(option);
    });
    // campaigns on Google Drive that aren't on this device - picking one fetches it
    if (driveOnly.length) {
      const group = document.createElement('optgroup');
      group.label = 'On Google Drive';
      driveOnly.forEach(name => {
        const option = document.createElement('option');
        option.value = DRIVE_OPTION_PREFIX + name;
        option.textContent = '☁ ' + name;
        group.appendChild(option);
      });
      campaignSelect.appendChild(group);
    }
    campaignDeleteBtn.disabled = !currentId;
    campaignRenameBtn.disabled = !currentId;
    campaignRemoveLocalBtn.hidden = !driveConnected || !currentId;
    campaignSelect.disabled = !currentId && !driveOnly.length;
    document.body.classList.toggle('no-campaign', !currentId);
  }

  campaignSelect.addEventListener('change', async () => {
    const value = campaignSelect.value;
    if (!value.startsWith(DRIVE_OPTION_PREFIX)) {
      Store.switchCampaign(value);
      return;
    }
    campaignSelect.disabled = true;
    try {
      const id = await DriveSync.downloadCampaign(value.slice(DRIVE_OPTION_PREFIX.length));
      Store.switchCampaign(id);
    } catch (err) {
      if (!err.reauth) alert('Could not get the campaign from Google Drive: ' + err.message);
    }
    updateCampaignUI(); // re-enables it, and shows the right selection after a failure
  });

  campaignNewBtn.addEventListener('click', () => {
    const name = prompt('Campaign name:');
    if (name && name.trim()) Store.createCampaign(name.trim());
  });

  campaignRenameBtn.addEventListener('click', () => {
    const name = prompt('New name:', Store.getCurrentCampaignName());
    if (name && name.trim()) Store.renameCampaign(Store.getCurrentCampaignId(), name.trim());
  });

  campaignDeleteBtn.addEventListener('click', () => {
    const name = Store.getCurrentCampaignName();
    const details = driveConnected
      ? 'It\'s deleted from this device, and its Google Drive file is moved to the Drive trash (it can be restored from there).\n\n' +
        'To only remove it from this device and keep it on Drive, use "Remove this campaign from this device" in the Drive menu instead.'
      : 'It\'s deleted from this device. This cannot be undone. (A copy on Google Drive, if there is one, isn\'t touched.)';
    if (!confirm(`Delete campaign "${name}"?\n\n${details}`)) return;
    Store.deleteCampaign(Store.getCurrentCampaignId());
  });

  // saved to Drive first; the local copy is only deleted once that worked
  campaignRemoveLocalBtn.addEventListener('click', async () => {
    const name = Store.getCurrentCampaignName();
    const ok = confirm(
      `Remove "${name}" from this device?\n\n` +
      'It\'s saved to Google Drive first and stays there. Pick it (☁) in the campaign list to get it back.'
    );
    if (!ok) return;
    campaignRemoveLocalBtn.disabled = true;
    try {
      await DriveSync.removeFromDevice(Store.getCurrentCampaignId());
    } catch (err) {
      if (!err.reauth) alert('Could not save the campaign to Google Drive, so it was NOT removed from this device.\n\n' + err.message);
    }
    campaignRemoveLocalBtn.disabled = false;
  });

  Store.subscribeCampaignChange(updateCampaignUI);
  DriveSync.subscribeRemoteCampaigns(updateCampaignUI);
  updateCampaignUI();

  // --- navigation: the list is home; a main node's mindmap is opened from
  // its 🗺 button. The open mindmap lives in the URL (#map=<id>), so the
  // browser's/tablet's back button returns to the list, and a reload stays
  // on the same mindmap. The last open one is also remembered, so reopening
  // the app (without #map in the URL) lands on it again.
  const OPEN_MINDMAP_KEY = 'rpg-notes-open-mindmap';

  function mapIdFromHash() {
    const m = location.hash.match(/^#map=(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function mapUrl(id) { return '#map=' + encodeURIComponent(id); }
  function listUrl() { return location.pathname + location.search; }

  function openMindmap(id) {
    // fromList: there's a list entry right behind this one in the history
    history.pushState({ fromList: true }, '', mapUrl(id));
    route();
  }
  function switchMindmap(id) {
    history.replaceState(history.state, '', mapUrl(id));
    route();
  }
  function closeMindmap() {
    // step back in history when we can, so the back button doesn't lead
    // into the mindmap again afterwards (popstate -> route shows the list)
    if (history.state && history.state.fromList) history.back();
    else { history.replaceState(null, '', listUrl()); route(); }
  }

  // shows whatever the URL says
  function route() {
    const id = mapIdFromHash();
    if (id && Store.getById(id)) {
      showView('mindmap', id);
    } else {
      if (id) history.replaceState(null, '', listUrl()); // node no longer exists
      showView('list');
    }
  }
  window.addEventListener('popstate', route);

  function showView(name, mapId) {
    const isList = name === 'list';
    activeView = name;
    treeContainer.classList.toggle('active', isList);
    mindmapContainer.classList.toggle('active', !isList);
    try {
      if (isList) localStorage.removeItem(OPEN_MINDMAP_KEY);
      else localStorage.setItem(OPEN_MINDMAP_KEY, mapId);
    } catch (e) { /* storage unavailable - just not remembered */ }

    // catch up the list if it missed any updates while the mindmap was
    // shown; the mindmap is rendered fresh (after being made visible, so it
    // can measure itself and center its nodes)
    if (isList && treeDirty) { TreeView.render(); treeDirty = false; }
    if (!isList) MindmapView.open(mapId);
  }

  // reopened without #map in the URL: go back to the mindmap that was open
  // last time, with the list behind it in the history
  if (!mapIdFromHash()) {
    let lastId = null;
    try { lastId = localStorage.getItem(OPEN_MINDMAP_KEY); } catch (e) { /* ignore */ }
    if (lastId && Store.getById(lastId)) {
      history.replaceState(null, '', listUrl());
      history.pushState({ fromList: true }, '', mapUrl(lastId));
    }
  }
  route();

  // --- edit/view mode ---
  // a two-button switch: the highlighted one is the current mode
  const modeEditBtn = document.getElementById('mode-edit-btn');
  const modeViewBtn = document.getElementById('mode-view-btn');
  function updateModeUI(editMode) {
    document.body.classList.toggle('view-mode', !editMode);
    modeEditBtn.classList.toggle('active', editMode);
    modeViewBtn.classList.toggle('active', !editMode);
    modeEditBtn.setAttribute('aria-pressed', String(editMode));
    modeViewBtn.setAttribute('aria-pressed', String(!editMode));
  }
  modeEditBtn.addEventListener('click', () => AppMode.setEditMode(true));
  modeViewBtn.addEventListener('click', () => AppMode.setEditMode(false));
  AppMode.subscribe(updateModeUI);
  updateModeUI(AppMode.isEditMode());

  // --- Google Drive sync (optional, see setup guide in README.md) ---
  const driveDot = document.getElementById('drive-dot');
  const driveStatusText = document.getElementById('drive-status-text');
  const driveConnectBtn = document.getElementById('drive-connect-btn');
  const driveSyncBtn = document.getElementById('drive-sync-btn');
  const drivePullBtn = document.getElementById('drive-pull-btn');
  const driveDisconnectBtn = document.getElementById('drive-disconnect-btn');
  const driveBanner = document.getElementById('drive-banner');
  const driveBannerText = document.getElementById('drive-banner-text');
  const driveMenuBtn = document.getElementById('drive-menu-btn');
  const driveMenu = document.getElementById('drive-menu');
  const driveMenuDanger = document.getElementById('drive-menu-danger');

  // the Drive buttons live in a small menu, so they don't take up the top
  // bar (and "Pull from Drive" isn't right next to everything else)
  function setDriveMenuOpen(open) {
    driveMenu.hidden = !open;
    driveMenuBtn.setAttribute('aria-expanded', String(open));
  }
  driveMenuBtn.addEventListener('click', () => setDriveMenuOpen(driveMenu.hidden));
  driveMenu.addEventListener('click', e => { if (e.target.closest('button')) setDriveMenuOpen(false); });
  document.addEventListener('pointerdown', e => {
    if (!driveMenu.hidden && !driveMenu.contains(e.target) && !driveMenuBtn.contains(e.target)) setDriveMenuOpen(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setDriveMenuOpen(false); });

  const DRIVE_LABELS = {
    unconfigured: 'Drive: not set up',
    disconnected: 'Drive: not connected',
    connecting: 'Drive: connecting…',
    connected: 'Drive: connected',
    syncing: 'Drive: syncing…',
    error: 'Drive: error',
    reauth: 'Drive: sign in again'
  };

  function updateDriveUI(status, detail) {
    driveDot.className = 'drive-dot drive-dot-' + status;
    driveStatusText.textContent = DRIVE_LABELS[status] || status;
    driveMenuBtn.title = detail || '';

    const isConnectedish = status === 'connected' || status === 'syncing';
    if (driveConnected !== isConnectedish) {
      driveConnected = isConnectedish;
      updateCampaignUI(); // shows/hides "Remove from this device"
    }
    driveConnectBtn.hidden = isConnectedish || status === 'connecting';
    driveSyncBtn.hidden = !isConnectedish;
    driveMenuDanger.hidden = !isConnectedish;
    driveDisconnectBtn.hidden = !isConnectedish;

    // the sign-in expired (about once an hour): hard to miss, one tap to
    // reconnect - a tap, because browsers block Google's sign-in popup otherwise
    driveBanner.hidden = status !== 'reauth';
    driveBannerText.textContent = DriveSync.hasUnsyncedChanges()
      ? 'Google Drive sign-in expired. Your latest changes are saved on this device, but NOT on Google Drive yet.'
      : 'Google Drive sign-in expired. New changes are saved on this device and uploaded when you reconnect.';
    driveBanner.classList.toggle('has-unsynced', DriveSync.hasUnsyncedChanges());
  }

  driveConnectBtn.addEventListener('click', () => {
    if (!DriveSync.isConfigured()) {
      alert('Google Drive sync isn\'t set up yet.\n\nSee "Google Drive sync" in README.md for how to get a Google Client ID.');
      return;
    }
    DriveSync.connect();
  });
  driveSyncBtn.addEventListener('click', async () => {
    driveSyncBtn.disabled = true;
    try {
      const result = await DriveSync.syncNow();
      if (result && (result.added || result.failed.length)) {
        let msg = 'Synced all campaigns with Google Drive.';
        if (result.added) msg += `\n\n${result.added} campaign(s) from Drive were added.`;
        if (result.failed.length) msg += `\n\nThese couldn't be read on Drive and were left untouched:\n${result.failed.join('\n')}`;
        alert(msg);
      }
    } catch (err) {
      if (!err.reauth) alert('Could not sync with Google Drive: ' + err.message);
    }
    driveSyncBtn.disabled = false;
  });
  driveDisconnectBtn.addEventListener('click', () => DriveSync.disconnect());
  document.getElementById('drive-banner-btn').addEventListener('click', () => DriveSync.connect());

  drivePullBtn.addEventListener('click', async () => {
    const ok = confirm(
      'Pull everything from Google Drive?\n\n' +
      'This DELETES ALL campaigns on this device and replaces them with the ones in the RPG Notes folder on Drive. ' +
      'Local changes that haven\'t reached Drive are lost.'
    );
    if (!ok) return;
    drivePullBtn.disabled = true;
    try {
      const { campaigns, skipped } = await DriveSync.pullAllFromDrive();
      let msg = `Pulled ${campaigns.length} campaign(s) from Google Drive.`;
      if (skipped.length) msg += `\n\nThese files couldn't be read and were skipped:\n${skipped.join('\n')}`;
      alert(msg);
    } catch (err) {
      console.error('Pull from Drive failed', err);
      alert('Could not pull from Google Drive: ' + err.message + '\n\nNothing on this device was changed.');
    }
    drivePullBtn.disabled = false;
  });

  DriveSync.init(updateDriveUI);
});
