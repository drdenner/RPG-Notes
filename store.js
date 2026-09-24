// store.js
// Flat data model for RPG notes, persisted to localStorage. Supports
// multiple independent campaigns - each campaign has its own node list,
// its own storage key, and (via drive-sync.js) its own file on Google
// Drive. Exactly one campaign is "current" at a time; all the node
// functions below (addNode, getAll, exportJSON, etc.) always operate on
// whichever campaign is currently active.
//
// ============================================================================
// DATA FORMAT (this is the contract - keep it stable, it's what the
// Google Drive files are stored as; a rewrite of the app
// should be able to load old data just by honoring this shape)
// ============================================================================
//
// An export file (Store.exportJSON(), also what ends up in the synced
// rpg-notes-<campaignId>.json on Google Drive) looks like:
//
//   {
//     "schemaVersion": 1,
//     "app": "rpg-notes",
//     "exportedAt": "2026-01-01T12:00:00.000Z",
//     "updatedAt": "2026-01-01T11:58:00.000Z",
//     "nodes": [ <node>, <node>, ... ]
//   }
//
// "updatedAt" is when the campaign's data last changed (null if never,
// e.g. a freshly seeded or created campaign). Google Drive sync compares
// it between this device and Drive, and the newer one wins.
//
// It only ever contains ONE campaign's nodes (the currently active one) -
// campaigns are never mixed together in a single export file.
//
// Store.importJSON() requires this envelope shape (a "nodes" array) - it
// does not accept a bare array of nodes.
//
// Each <node> is a flat object:
//   {
//     "id": "string, unique, required",
//     "name": "string, required",
//     "notes": "string, required (plain text, may be empty)",
//     "parentId": "string (another node's id) or null for a root node",
//     "x": number,
//     "y": number
//   }
//   - parentId === null means the node is a root node
//   - children are NEVER stored on the node itself, they're always derived
//     by filtering the whole list on parentId (see getChildren)
//   - notes is plain text with a tiny markdown-like syntax: **bold** renders
//     bold, and any http(s)/www URL is auto-linked - see notes-editor.js
//     for the renderer. It is NEVER HTML, so it's safe to store/display as-is.
//   - x/y are only used by the mindmap view (pixel position on its canvas)
//
// importJSON() normalizes/repairs incoming nodes defensively (missing
// fields get sane defaults, a parentId pointing at a non-existent node
// becomes a root node, parent cycles are broken, and a duplicated id is
// replaced with a fresh one) rather than trusting the file blindly, since it may
// be hand-edited or come from an older/future version of the app. Unknown
// extra fields on a node are preserved, not stripped, so a future version
// of this app can add fields without older exports losing them.
//
// Want to extend the data model later (e.g. tags, color, node type)? Add
// the fields here, in seedDefaultNodes, and in the normalization step
// inside importJSON.

const Store = (() => {
  const CAMPAIGNS_KEY = 'rpg-notes-campaigns'; // [{id, name}, ...]
  const CURRENT_CAMPAIGN_KEY = 'rpg-notes-current-campaign';
  const SCHEMA_VERSION = 1;

  let campaigns = [];
  let currentCampaignId = null;
  let nodes = [];
  const dataListeners = [];        // fired on real data mutations (add/rename/delete/move/notes)
  const campaignListeners = [];    // fired when the active campaign changes (switch/create/delete)
  const campaignDeletedListeners = []; // fired with a campaign's id right after it's deleted, so drive-sync.js can clean up its Drive files

  function dataKey(campaignId) {
    return 'rpg-notes-data-' + campaignId;
  }

  function updatedAtKey(campaignId) {
    return 'rpg-notes-updated-' + campaignId;
  }

  // when the campaign's data last changed (ISO string), or null if never
  function getUpdatedAt(campaignId = currentCampaignId) {
    return localStorage.getItem(updatedAtKey(campaignId)) || null;
  }

  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // stamps the campaign as changed, saves, and notifies every subscriber
  // (views, Drive sync). importJSON passes the Drive file's own updatedAt
  // when pulling, so a pull doesn't make the local copy look newer.
  function notify(updatedAt = new Date().toISOString()) {
    if (updatedAt) trySetItem(updatedAtKey(currentCampaignId), updatedAt);
    else localStorage.removeItem(updatedAtKey(currentCampaignId));
    save();
    dataListeners.forEach(fn => fn());
  }

  // notifies subscribers that the ACTIVE campaign changed (not its data) -
  // used by drive-sync.js to know when to switch which Drive file it syncs
  function notifyCampaignChanged() {
    campaignListeners.forEach(fn => fn());
  }

  // --- persistence ---

  let storageErrorShown = false;

  function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
  }

  // localStorage.setItem that shows an error instead of throwing (e.g. when
  // storage is full) - a failed save must never crash a Store mutation.
  // The in-memory data (and Drive sync) keep working either way.
  function trySetItem(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.error('Could not save to localStorage', e);
      if (!storageErrorShown) {
        storageErrorShown = true; // don't repeat the alert on every single change
        alert(isQuotaError(e)
          ? 'This browser\'s storage for RPG Notes is full, so your latest changes are NOT saved on this device.\n\nIf Google Drive is connected, your changes are still saved there. Otherwise, delete campaigns you no longer need to free up space.'
          : 'Could not save your notes on this device: ' + e.message);
      }
      return false;
    }
  }

  function save() {
    if (trySetItem(dataKey(currentCampaignId), JSON.stringify(nodes))) storageErrorShown = false;
    saveCampaignRegistry();
  }

  function saveCampaignRegistry() {
    trySetItem(CAMPAIGNS_KEY, JSON.stringify(campaigns));
    trySetItem(CURRENT_CAMPAIGN_KEY, currentCampaignId);
  }

  function loadCampaignNodes(campaignId) {
    const raw = localStorage.getItem(dataKey(campaignId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('saved data is not a list of nodes');
      return parsed;
    } catch (e) {
      console.error('Could not read saved notes for this campaign, starting fresh.', e);
      preserveCorruptData(campaignId, raw);
      return [];
    }
  }

  // moves unreadable saved data to its own key before the campaign starts
  // over empty, so the next save() can't overwrite it. Removing the
  // original first frees its space, so the copy fits even when storage is
  // nearly full; if the copy still fails, the original is put back.
  function preserveCorruptData(campaignId, raw) {
    const backupKey = `rpg-notes-corrupt-${campaignId}-${Date.now()}`;
    localStorage.removeItem(dataKey(campaignId));
    try {
      localStorage.setItem(backupKey, raw);
      alert(`The saved notes for this campaign could not be read, so it starts out empty.\n\nThe unreadable data was kept in this browser's localStorage under the key "${backupKey}".`);
    } catch (e) {
      try { localStorage.setItem(dataKey(campaignId), raw); } catch (e2) { /* nothing more we can do */ }
      alert('The saved notes for this campaign could not be read, and there wasn\'t room to keep a copy. The campaign starts out empty - the unreadable data will be overwritten by your next change.');
    }
  }

  function load() {
    const rawCampaigns = localStorage.getItem(CAMPAIGNS_KEY);
    if (rawCampaigns) {
      try { campaigns = JSON.parse(rawCampaigns); } catch (e) { campaigns = []; }
    }

    if (!Array.isArray(campaigns) || campaigns.length === 0) {
      // no campaigns yet - start fresh with one example campaign
      const id = generateId();
      campaigns = [{ id, name: 'My Campaign' }];
      currentCampaignId = id;
      nodes = seedDefaultNodes();
      save();
      return;
    }

    currentCampaignId = localStorage.getItem(CURRENT_CAMPAIGN_KEY);
    if (!currentCampaignId || !campaigns.find(c => c.id === currentCampaignId)) {
      currentCampaignId = campaigns[0].id;
    }
    nodes = loadCampaignNodes(currentCampaignId);
  }

  function seedDefaultNodes() {
    const root = {
      id: generateId(),
      name: 'My Campaign',
      notes: 'Welcome! Click the notes button on any node to write **bold text** here - just paste a link like https://example.com and it opens in a new tab automatically.',
      parentId: null, x: 420, y: 80
    };
    const chapter = { id: generateId(), name: 'Chapter 1: The Arrival', notes: '', parentId: root.id, x: 260, y: 240 };
    const npc = { id: generateId(), name: 'NPC: Innkeeper Borin', notes: '', parentId: chapter.id, x: 140, y: 400 };
    return [root, chapter, npc];
  }

  // --- subscriptions, so views (and Drive sync) can react to changes ---

  function subscribe(fn) {
    dataListeners.push(fn);
  }

  function subscribeCampaignChange(fn) {
    campaignListeners.push(fn);
  }

  function subscribeCampaignDeleted(fn) {
    campaignDeletedListeners.push(fn);
  }

  // --- campaigns ---

  function listCampaigns() {
    return campaigns.map(c => ({ ...c }));
  }

  function getCurrentCampaignId() {
    return currentCampaignId;
  }

  function getCurrentCampaignName() {
    const c = campaigns.find(c => c.id === currentCampaignId);
    return c ? c.name : '';
  }

  // the Drive filename (without extension) a campaign name maps to - see
  // drive-sync.js. Lives here so uniqueCampaignName can check against it.
  function sanitizeFileName(name) {
    return (name || 'campaign').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'campaign';
  }

  // two campaigns whose names map to the same Drive filename (e.g. "A/B"
  // and "A:B" both become "A-B.json", see sanitizeFileName) would overwrite
  // each other there - so uniqueness is checked on the sanitized name; a
  // duplicate gets " (2)", " (3)", etc. appended automatically
  function uniqueCampaignName(desiredName, excludeId) {
    const base = (desiredName || '').trim() || 'New campaign';
    const taken = new Set(campaigns.filter(c => c.id !== excludeId).map(c => sanitizeFileName(c.name)));
    if (!taken.has(sanitizeFileName(base))) return base;
    // shortened so the suffix can't be cut off by sanitizeFileName's length
    // limit (which would make every candidate collide and loop forever)
    const stem = base.slice(0, 100);
    let n = 2;
    while (taken.has(sanitizeFileName(`${stem} (${n})`))) n++;
    return `${stem} (${n})`;
  }

  // creates a new, EMPTY campaign and switches to it
  function createCampaign(name) {
    const id = generateId();
    campaigns.push({ id, name: uniqueCampaignName(name, null) });
    currentCampaignId = id;
    nodes = [];
    save();
    notifyCampaignChanged();
    return id;
  }

  function switchCampaign(id) {
    if (id === currentCampaignId) return;
    if (!campaigns.find(c => c.id === id)) return;
    currentCampaignId = id;
    nodes = loadCampaignNodes(id);
    saveCampaignRegistry();
    notifyCampaignChanged();
  }

  function renameCampaign(id, newName) {
    const c = campaigns.find(c => c.id === id);
    if (!c) return;
    const trimmed = (newName || '').trim();
    c.name = trimmed ? uniqueCampaignName(trimmed, id) : c.name;
    saveCampaignRegistry();
    notifyCampaignChanged(); // lets the UI refresh the campaign's displayed name
  }

  // returns false (and does nothing) if this is the only campaign left -
  // there must always be at least one
  function deleteCampaign(id) {
    if (campaigns.length <= 1) return false;
    const idx = campaigns.findIndex(c => c.id === id);
    if (idx === -1) return false;

    campaigns.splice(idx, 1);
    localStorage.removeItem(dataKey(id));
    localStorage.removeItem(updatedAtKey(id));

    if (currentCampaignId === id) {
      currentCampaignId = campaigns[0].id;
      nodes = loadCampaignNodes(currentCampaignId);
    }
    saveCampaignRegistry();
    campaignDeletedListeners.forEach(fn => fn(id)); // lets drive-sync.js trash its Drive files
    notifyCampaignChanged();
    return true;
  }

  // --- reads ---

  function getAll() {
    return nodes.map(n => ({ ...n }));
  }

  function getById(id) {
    const n = nodes.find(n => n.id === id);
    return n ? { ...n } : null;
  }

  function getChildren(parentId) {
    return nodes.filter(n => n.parentId === parentId).map(n => ({ ...n }));
  }

  function getRoots() {
    return getChildren(null);
  }

  // is `maybeAncestorId` an ancestor of (or equal to) `id`?
  function isAncestor(maybeAncestorId, id) {
    let current = nodes.find(n => n.id === id);
    while (current) {
      if (current.id === maybeAncestorId) return true;
      current = nodes.find(n => n.id === current.parentId);
    }
    return false;
  }

  // --- writes ---

  function addNode(name, parentId = null) {
    const parent = parentId ? nodes.find(n => n.id === parentId) : null;
    const node = {
      id: generateId(),
      name: name || 'New node',
      notes: '',
      parentId: parent ? parent.id : null,
      x: parent ? parent.x + 120 + Math.random() * 40 : 300 + Math.random() * 200,
      y: parent ? parent.y + 100 + Math.random() * 40 : 80 + Math.random() * 200
    };
    nodes.push(node);
    notify();
    return { ...node };
  }

  // applies several changes to one node as ONE mutation (one save, one
  // render, one Drive sync scheduled) - e.g. name + notes from the editor,
  // or position + new parent from a mindmap drag. `patch` may contain any
  // of name, notes, x, y, parentId; each is validated on its own, and an
  // invalid one (e.g. a parentId that would create a cycle) is skipped
  // while the rest of the patch still applies
  function updateNode(id, patch) {
    const node = nodes.find(n => n.id === id);
    if (!node || !patch) return;
    let changed = false;

    if ('name' in patch) {
      node.name = (patch.name || '').trim() || node.name;
      changed = true;
    }
    if ('notes' in patch) {
      node.notes = typeof patch.notes === 'string' ? patch.notes : '';
      changed = true;
    }
    ['x', 'y'].forEach(key => {
      if (typeof patch[key] === 'number' && isFinite(patch[key])) {
        node[key] = patch[key];
        changed = true;
      }
    });
    if ('parentId' in patch) {
      const newParentId = patch.parentId || null;
      // avoid circular references: can't move a node under itself or its
      // own child, and the new parent has to actually exist
      const valid = !newParentId || (nodes.some(n => n.id === newParentId) && !isAncestor(id, newParentId));
      if (valid) {
        node.parentId = newParentId;
        changed = true;
      }
    }

    if (changed) notify();
  }

  function renameNode(id, newName) {
    updateNode(id, { name: newName });
  }

  function updateNodeNotes(id, text) {
    updateNode(id, { notes: text });
  }

  // deletes a node and all its children (recursively)
  function deleteNode(id) {
    const toDelete = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      nodes.forEach(n => {
        if (n.parentId && toDelete.has(n.parentId) && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          changed = true;
        }
      });
    }
    nodes = nodes.filter(n => !toDelete.has(n.id));
    notify();
  }

  // re-parents a node (with its children); see updateNode for the cycle check
  function moveNode(id, newParentId) {
    updateNode(id, { parentId: newParentId });
  }

  // updates only the mindmap position, doesn't touch the hierarchy
  function moveNodePosition(id, x, y) {
    updateNode(id, { x, y });
  }

  // --- export / import ---

  // exports the given campaign (defaults to the current one). Any other
  // campaign is read from its saved copy in localStorage, which save()
  // keeps up to date on every change - drive-sync.js needs this to flush a
  // pending upload for a campaign the user has already switched away from
  function exportJSON(campaignId) {
    const exportNodes = !campaignId || campaignId === currentCampaignId ? nodes : loadCampaignNodes(campaignId);
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      app: 'rpg-notes',
      exportedAt: new Date().toISOString(),
      updatedAt: getUpdatedAt(campaignId || currentCampaignId),
      nodes: exportNodes
    }, null, 2);
  }

  // `keepUpdatedAt` (used by Drive sync) keeps the file's updatedAt
  // instead of stamping the import as a new local change
  function importJSON(jsonString, { keepUpdatedAt = false } = {}) {
    const parsed = JSON.parse(jsonString);
    nodes = normalizeNodes(parsed);
    notify(keepUpdatedAt ? readUpdatedAt(parsed) : undefined);
  }

  function readUpdatedAt(parsed) {
    return parsed && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
  }

  // validates and repairs an export file's nodes (see the header comment);
  // throws if the file isn't in the expected shape at all
  function normalizeNodes(parsed) {
    const incoming = parsed && typeof parsed === 'object' ? parsed.nodes : undefined;
    if (!Array.isArray(incoming)) {
      throw new Error('Invalid format: expected an export file with a "nodes" array.');
    }

    incoming.forEach(n => {
      if (!n || typeof n.id !== 'string' || !n.id) {
        throw new Error('Invalid format: every node needs a non-empty string "id".');
      }
    });

    // duplicate ids would make parent/child links ambiguous: the first node
    // keeps the id (so children pointing at it stay attached), later
    // duplicates get a fresh id instead of being dropped
    const usedIds = new Set();
    const ids = incoming.map(n => {
      const id = usedIds.has(n.id) ? generateId() : n.id;
      usedIds.add(id);
      return id;
    });

    const validIds = new Set(ids);
    const imported = incoming.map((n, i) => {
      return {
        ...n, // preserve any fields a newer/older version of the app added
        id: ids[i],
        name: typeof n.name === 'string' && n.name ? n.name : 'Unnamed node',
        notes: typeof n.notes === 'string' ? n.notes : '',
        parentId: typeof n.parentId === 'string' && validIds.has(n.parentId) && n.parentId !== ids[i] ? n.parentId : null,
        x: typeof n.x === 'number' && isFinite(n.x) ? n.x : 0,
        y: typeof n.y === 'number' && isFinite(n.y) ? n.y : 0
      };
    });

    // break any longer cycles a corrupted/hand-edited file might contain
    // (A -> B -> A), so traversal can never loop forever. The link is cut
    // where the cycle closes (the node whose parent we've already visited),
    // not at the node the walk started from - otherwise a node merely
    // hanging off a cycle (C -> A, with A <-> B) would become a root while
    // the cycle itself stayed intact
    const byId = new Map(imported.map(n => [n.id, n]));
    imported.forEach(n => {
      const seen = new Set([n.id]);
      let current = n;
      while (current.parentId) {
        if (seen.has(current.parentId)) { current.parentId = null; break; }
        seen.add(current.parentId);
        current = byId.get(current.parentId);
      }
    });

    return imported;
  }

  // throws away EVERY local campaign and replaces them with `entries`
  // ([{ name, data }], data = a parsed export file) - used by Drive sync's
  // "Pull from Drive". Every entry is validated before anything is
  // deleted; unreadable ones are skipped and returned by name, and if none
  // are readable nothing changes. Deliberately does NOT fire the
  // campaign-deleted listeners, since those trash the Drive files.
  // Stays on a campaign with the same name as the current one, if any.
  function replaceAllCampaigns(entries) {
    const incoming = [];
    const skipped = [];
    entries.forEach(e => {
      try {
        incoming.push({ id: generateId(), name: e.name, nodes: normalizeNodes(e.data), updatedAt: readUpdatedAt(e.data) });
      } catch (err) {
        skipped.push(e.name);
      }
    });
    if (incoming.length === 0) throw new Error('No readable campaigns were found.');

    const previousName = getCurrentCampaignName();
    campaigns.forEach(c => {
      localStorage.removeItem(dataKey(c.id));
      localStorage.removeItem(updatedAtKey(c.id));
    });
    campaigns = incoming.map(c => ({ id: c.id, name: c.name }));
    incoming.forEach(c => {
      trySetItem(dataKey(c.id), JSON.stringify(c.nodes));
      if (c.updatedAt) trySetItem(updatedAtKey(c.id), c.updatedAt);
    });
    const current = incoming.find(c => c.name === previousName) || incoming[0];
    currentCampaignId = current.id;
    nodes = current.nodes;
    saveCampaignRegistry();
    notifyCampaignChanged();
    return { campaigns: listCampaigns(), skipped };
  }

  load();

  return {
    getAll, getById, getChildren, getRoots,
    addNode, updateNode, renameNode, updateNodeNotes, deleteNode, moveNode, moveNodePosition,
    save, load, subscribe, exportJSON, importJSON, getUpdatedAt,
    listCampaigns, getCurrentCampaignId, getCurrentCampaignName, sanitizeFileName,
    createCampaign, switchCampaign, renameCampaign, deleteCampaign, replaceAllCampaigns,
    subscribeCampaignChange, subscribeCampaignDeleted
  };
})();
