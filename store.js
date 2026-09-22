// store.js
// Flad data-model for RPG-noter, persisteret i localStorage.
//
// Node-form: { id, name, parentId, x, y }
//   - parentId === null betyder at noden er en rod-node
//   - children findes ALDRIG på noden selv, men udledes altid ved at
//     filtrere hele listen på parentId (se getChildren)
//   - x/y bruges kun af mindmap-visningen
//
// Vil du udvide datamodellen senere (fx tags, farve, node-type), er det
// her (og i seedDefaultData) du tilføjer felterne.

const Store = (() => {
  const STORAGE_KEY = 'rpg-notes';
  let nodes = [];
  const listeners = [];

  function generateId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // gemmer og informerer alle abonnenter (views) om at data er ændret
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
        console.error('Kunne ikke læse gemte noter, starter forfra.', e);
        nodes = [];
      }
    }
    if (nodes.length === 0) {
      seedDefaultData();
    }
  }

  function seedDefaultData() {
    const root = { id: generateId(), name: 'Min Kampagne', parentId: null, x: 420, y: 80 };
    const chapter = { id: generateId(), name: 'Kapitel 1: Ankomsten', parentId: root.id, x: 260, y: 240 };
    const npc = { id: generateId(), name: 'NPC: Kroværten Borin', parentId: chapter.id, x: 140, y: 400 };
    nodes = [root, chapter, npc];
    save();
  }

  // --- abonnement, så views kan reagere på ændringer ---

  function subscribe(fn) {
    listeners.push(fn);
  }

  // --- læsning ---

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

  // er `maybeAncestorId` forfader til (eller lig med) `id`?
  function isAncestor(maybeAncestorId, id) {
    let current = nodes.find(n => n.id === id);
    while (current) {
      if (current.id === maybeAncestorId) return true;
      current = nodes.find(n => n.id === current.parentId);
    }
    return false;
  }

  // --- skrivning ---

  function addNode(name, parentId = null) {
    const parent = parentId ? nodes.find(n => n.id === parentId) : null;
    const node = {
      id: generateId(),
      name: name || 'Ny node',
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

  // sletter en node og alle dens underpunkter (rekursivt)
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
    // undgå cirkulær reference: kan ikke flytte en node ind under sit eget barn
    if (newParentId && isAncestor(id, newParentId)) return;
    node.parentId = newParentId || null;
    notify();
  }

  // opdaterer kun mindmap-position, rører ikke ved hierarkiet
  function moveNodePosition(id, x, y) {
    const node = nodes.find(n => n.id === id);
    if (!node) return;
    node.x = x;
    node.y = y;
    notify();
  }

  // --- eksport / import ---

  function exportJSON() {
    return JSON.stringify(nodes, null, 2);
  }

  function importJSON(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!Array.isArray(parsed)) throw new Error('Ugyldigt format: forventede en liste af noder.');
    nodes = parsed;
    notify();
  }

  load();

  return {
    getAll, getById, getChildren, getRoots,
    addNode, renameNode, deleteNode, moveNode, moveNodePosition,
    save, load, subscribe, exportJSON, importJSON
  };
})();
