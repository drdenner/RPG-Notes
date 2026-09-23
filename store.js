// store.js
// Flat data model for RPG notes, persisted to localStorage.
//
// ============================================================================
// DATA FORMAT (this is the contract - keep it stable, it's what Export,
// Import and Google Drive sync all read and write; a rewrite of the app
// should be able to load old data just by honoring this shape)
// ============================================================================
//
// An export file (Store.exportJSON(), also what ends up in the synced
// rpg-notes.json on Google Drive) looks like:
//
//   {
//     "schemaVersion": 1,
//     "app": "rpg-notes",
//     "exportedAt": "2026-01-01T12:00:00.000Z",
//     "nodes": [ <node>, <node>, ... ]
//   }
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
// becomes a root node) rather than trusting the file blindly, since it may
// be hand-edited or come from an older/future version of the app. Unknown
// extra fields on a node are preserved, not stripped, so a future version
// of this app can add fields without older exports losing them.
//
// Want to extend the data model later (e.g. tags, color, node type)? Add
// the fields here, in seedDefaultData, and in the normalization step inside
// importJSON.

const Store = (() => {
  const STORAGE_KEY = 'rpg-notes';
  const SCHEMA_VERSION = 1;

  let nodes = [];
  const listeners = [];

  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // saves and notifies every subscriber (views) that data changed
  function notify() {
    save();
    listeners.forEach(fn => fn());
  }

  // --- persistence ---

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
  }

  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        nodes = JSON.parse(raw);
      } catch (e) {
        console.error('Could not read saved notes, starting fresh.', e);
        nodes = [];
      }
    }
    if (nodes.length === 0) {
      seedDefaultData();
    }
  }

  function seedDefaultData() {
    const root = {
      id: generateId(),
      name: 'My Campaign',
      notes: 'Welcome! Click the notes button on any node to write **bold text** here - just paste a link like https://example.com and it opens in a new tab automatically.',
      parentId: null, x: 420, y: 80
    };
    const chapter = { id: generateId(), name: 'Chapter 1: The Arrival', notes: '', parentId: root.id, x: 260, y: 240 };
    const npc = { id: generateId(), name: 'NPC: Innkeeper Borin', notes: '', parentId: chapter.id, x: 140, y: 400 };
    nodes = [root, chapter, npc];
    save();
  }

  // --- subscriptions, so views can react to changes ---

  function subscribe(fn) {
    listeners.push(fn);
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

  function renameNode(id, newName) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.name = (newName || '').trim() || node.name;
    notify();
  }

  function updateNodeNotes(id, text) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.notes = typeof text === 'string' ? text : '';
    notify();
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

  function moveNode(id, newParentId) {
    if (id === newParentId) return;
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    // avoid circular references: can't move a node under its own child
    if (newParentId && isAncestor(id, newParentId)) return;
    node.parentId = newParentId || null;
    notify();
  }

  // updates only the mindmap position, doesn't touch the hierarchy
  function moveNodePosition(id, x, y) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.x = x;
    node.y = y;
    notify();
  }

  // --- export / import ---

  function exportJSON() {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      app: 'rpg-notes',
      exportedAt: new Date().toISOString(),
      nodes
    }, null, 2);
  }

  function importJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    const incoming = parsed && typeof parsed === 'object' ? parsed.nodes : undefined;
    if (!Array.isArray(incoming)) {
      throw new Error('Invalid format: expected an export file with a "nodes" array.');
    }

    const validIds = new Set(incoming.map(n => n && n.id).filter(Boolean));
    nodes = incoming.map(n => {
      if (!n || typeof n.id !== 'string' || !n.id) {
        throw new Error('Invalid format: every node needs a non-empty string "id".');
      }
      return {
        ...n, // preserve any fields a newer/older version of the app added
        name: typeof n.name === 'string' && n.name ? n.name : 'Unnamed node',
        notes: typeof n.notes === 'string' ? n.notes : '',
        parentId: typeof n.parentId === 'string' && validIds.has(n.parentId) && n.parentId !== n.id ? n.parentId : null,
        x: typeof n.x === 'number' && isFinite(n.x) ? n.x : 0,
        y: typeof n.y === 'number' && isFinite(n.y) ? n.y : 0
      };
    });

    // break any longer cycles a corrupted/hand-edited file might contain
    // (A -> B -> A), so traversal can never loop forever
    const byId = new Map(nodes.map(n => [n.id, n]));
    nodes.forEach(n => {
      const seen = new Set();
      let current = n;
      while (current.parentId) {
        if (seen.has(current.parentId)) { n.parentId = null; break; }
        seen.add(current.parentId);
        current = byId.get(current.parentId);
      }
    });

    notify();
  }

  load();

  return {
    getAll, getById, getChildren, getRoots,
    addNode, renameNode, updateNodeNotes, deleteNode, moveNode, moveNodePosition,
    save, load, subscribe, exportJSON, importJSON
  };
})();
