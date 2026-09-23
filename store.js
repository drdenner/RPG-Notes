// store.js
// Flat data model for RPG notes, persisted to localStorage.
//
// Node shape: { id, name, notes, parentId, x, y }
//   - parentId === null means the node is a root node
//   - children are NEVER stored on the node itself, they're always derived
//     by filtering the whole list on parentId (see getChildren)
//   - notes is a small sanitized HTML string (bold text + links), edited
//     via notes-editor.js
//   - x/y are only used by the mindmap view
//
// Want to extend the data model later (e.g. tags, color, node type)? Add
// the fields here (and in seedDefaultData).

const Store = (() => {
  const STORAGE_KEY = 'rpg-notes';
  const ALLOWED_NOTE_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'A', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI']);
  const ALLOWED_URL_SCHEME = /^(https?:|mailto:)/i;

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
      notes: '<b>Welcome!</b> Click the notes button on any node to write rich text here - including <a href="https://example.com" target="_blank" rel="noopener noreferrer">links</a> that always open in a new tab.',
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

  function updateNodeNotes(id, html) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.notes = sanitizeNotes(html);
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

  // --- notes sanitizing ---
  // Keeps only a small safe allowlist of tags/attributes, so pasted or
  // imported HTML can't smuggle in scripts or other unwanted markup, and
  // forces every link to open in a new tab with a safe URL scheme.
  function sanitizeNotes(html) {
    const container = document.createElement('div');
    container.innerHTML = html || '';
    cleanNode(container);
    return container.innerHTML;
  }

  function cleanNode(node) {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        cleanNode(child);
        if (!ALLOWED_NOTE_TAGS.has(child.tagName)) {
          // unwrap instead of dropping, so the user doesn't lose their text
          while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
          child.remove();
          return;
        }
        [...child.attributes].forEach(attr => {
          if (child.tagName === 'A' && (attr.name === 'href' || attr.name === 'target' || attr.name === 'rel')) return;
          child.removeAttribute(attr.name);
        });
        if (child.tagName === 'A') {
          const href = child.getAttribute('href') || '';
          if (!ALLOWED_URL_SCHEME.test(href)) child.removeAttribute('href');
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    });
  }

  // --- export / import ---

  function exportJSON() {
    return JSON.stringify(nodes, null, 2);
  }

  function importJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) throw new Error('Invalid format: expected a list of nodes.');
    // sanitize notes on every incoming node too, in case the JSON came
    // from an untrusted file or an older export without a notes field
    nodes = parsed.map(n => ({ ...n, notes: sanitizeNotes(n.notes || '') }));
    notify();
  }

  load();

  return {
    getAll, getById, getChildren, getRoots,
    addNode, renameNode, updateNodeNotes, deleteNode, moveNode, moveNodePosition,
    save, load, subscribe, exportJSON, importJSON, sanitizeNotes
  };
})();
