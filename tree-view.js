// tree-view.js
// Nested list view of the notes.
// Renders <ul>/<li> from Store, and handles:
//   - collapse/expand per node (collapsed state is session-only, not saved)
//   - clicking a node's name opens it (NotesEditor - rename and notes both
//     live there, there's no separate rename/notes button)
//   - add child / delete (recursive, via Store.deleteNode)
//   - move node: dragged via a small grip (⠿), using Pointer Events so it
//     works with mouse, pen and touch alike (native HTML5 drag-and-drop
//     isn't supported on touch devices, so we build it ourselves)
//
// render() is incremental, the same idea as mindmap-view.js: `entries`
// (keyed by node id) tracks each node's <li> across renders, so a rename,
// a notes edit, or moving one node never tears down and rebuilds the
// whole tree - only the row(s) that actually changed, plus reconciling
// each affected level's child order (reconcileLevel below, a small keyed
// list diff: reuse/reposition existing <li>s, create new ones, drop
// leftovers - the same technique virtual-DOM libraries use for lists).

const TreeView = (() => {
  let listEl = null;
  const collapsed = new Set(); // ids that are currently collapsed
  const entries = new Map();   // node id -> { li, row, toggle, nameSpan, childUl, cached }

  function init(container) {
    listEl = container.querySelector('#tree-list');

    container.querySelector('#tree-new-root-btn').addEventListener('click', () => {
      const node = Store.addNode('New root node', null);
      NotesEditor.open(node.id);
    });
  }

  function render() {
    if (!listEl) return;

    const allNodes = Store.getAll();
    const nodeById = new Map(allNodes.map(n => [n.id, n]));

    // group once (O(n)) instead of the old approach of calling
    // Store.getChildren() per node (an O(n) scan each), which made a full
    // render O(n^2) for no reason
    const childrenByParent = new Map();
    allNodes.forEach(n => {
      const key = n.parentId || null;
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(n);
    });

    // drop entries for nodes that no longer exist; reconcileLevel below
    // handles removing/repositioning the ones that just moved elsewhere
    entries.forEach((entry, id) => {
      if (!nodeById.has(id)) {
        entry.li.remove();
        entries.delete(id);
      }
    });

    reconcileLevel(listEl, childrenByParent.get(null) || [], childrenByParent);
  }

  // keeps `containerUl`'s <li> children matching `desiredNodes`, in order:
  // reuse+reposition existing entries, create missing ones, remove leftovers
  function reconcileLevel(containerUl, desiredNodes, childrenByParent) {
    const existing = new Map();
    [...containerUl.children].forEach(li => existing.set(li.dataset.id, li));

    let cursor = containerUl.firstChild;
    desiredNodes.forEach(node => {
      let entry = entries.get(node.id);
      if (entry) {
        existing.delete(node.id);
        updateNodeRow(entry, node);
      } else {
        entry = createNodeEntry(node);
      }
      if (entry.li !== cursor) containerUl.insertBefore(entry.li, cursor);
      cursor = entry.li.nextSibling;

      const childNodes = childrenByParent.get(node.id) || [];
      updateToggle(entry, childNodes.length);

      if (childNodes.length > 0 && !collapsed.has(node.id)) {
        if (!entry.childUl) {
          entry.childUl = document.createElement('ul');
          entry.childUl.className = 'tree-children';
          entry.li.appendChild(entry.childUl);
        }
        reconcileLevel(entry.childUl, childNodes, childrenByParent);
      } else if (entry.childUl) {
        entry.childUl.remove();
        entry.childUl = null;
      }
    });

    // whatever's left either belongs to a deleted node (already removed
    // above) or was moved to a different parent - either way it doesn't
    // belong in THIS list anymore. Safe to remove even if it's mid-move:
    // the other reconcileLevel call for its new parent still holds the
    // same `entries` reference and will re-attach it via insertBefore.
    existing.forEach(li => li.remove());
  }

  function createNodeEntry(node) {
    const entry = { cached: node, childUl: null };

    const li = document.createElement('li');
    li.className = 'tree-node';
    li.dataset.id = node.id;
    entry.li = li;

    const row = document.createElement('div');
    row.className = 'tree-row';

    // grip to drag the node onto another node (moves it, with its children)
    const grip = document.createElement('button');
    grip.className = 'tree-grip';
    grip.title = 'Drag to move';
    grip.setAttribute('aria-label', 'Move node');
    grip.textContent = '⠿';
    row.appendChild(grip);
    attachDragHandle(grip, row, entry);

    // collapse/expand
    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle';
    toggle.addEventListener('click', () => {
      const id = entry.cached.id;
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      render();
    });
    row.appendChild(toggle);
    entry.toggle = toggle;

    // name - click/tap opens the node (rename + notes live in that panel)
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-name';
    if (node.notes) nameSpan.classList.add('has-notes');
    nameSpan.textContent = node.name;
    nameSpan.tabIndex = 0;
    nameSpan.addEventListener('click', () => NotesEditor.open(entry.cached.id));
    row.appendChild(nameSpan);
    entry.nameSpan = nameSpan;

    // action buttons
    const actions = document.createElement('span');
    actions.className = 'tree-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-icon';
    addBtn.title = 'Add child node';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      collapsed.delete(entry.cached.id);
      const child = Store.addNode('New node', entry.cached.id);
      NotesEditor.open(child.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon btn-danger';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete "${entry.cached.name}" and all its children?`)) {
        Store.deleteNode(entry.cached.id);
      }
    });

    actions.append(addBtn, delBtn);
    row.appendChild(actions);
    li.appendChild(row);
    entry.row = row;

    entries.set(node.id, entry);
    return entry;
  }

  function updateNodeRow(entry, node) {
    const prev = entry.cached;
    if (prev.name !== node.name) entry.nameSpan.textContent = node.name;
    if (!!prev.notes !== !!node.notes) entry.nameSpan.classList.toggle('has-notes', !!node.notes);
    entry.cached = node;
  }

  function updateToggle(entry, childCount) {
    const toggle = entry.toggle;
    if (childCount > 0) {
      toggle.disabled = false;
      toggle.classList.remove('tree-toggle-empty');
      toggle.textContent = collapsed.has(entry.cached.id) ? '▶' : '▼';
    } else {
      toggle.disabled = true;
      toggle.classList.add('tree-toggle-empty');
      toggle.textContent = '';
    }
  }

  // custom drag-and-drop via Pointer Events (covers mouse, pen and touch)
  function attachDragHandle(handle, row, entry) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return; // left click / primary touch only
      e.preventDefault();
      row.classList.add('dragging');
      let currentTargetRow = null;

      function onMove(ev) {
        const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetRow = elUnder && elUnder.closest('.tree-row');
        if (currentTargetRow && currentTargetRow !== targetRow) {
          currentTargetRow.classList.remove('drop-target');
          currentTargetRow = null;
        }
        if (targetRow && targetRow !== row) {
          targetRow.classList.add('drop-target');
          currentTargetRow = targetRow;
        }
      }

      function finish(ev) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        row.classList.remove('dragging');

        if (currentTargetRow) {
          currentTargetRow.classList.remove('drop-target');
          const targetLi = currentTargetRow.closest('.tree-node');
          if (targetLi && targetLi.dataset.id !== entry.cached.id) {
            Store.moveNode(entry.cached.id, targetLi.dataset.id);
          }
        } else if (ev.type === 'pointerup') {
          // dropped on empty space in the list -> move to root level
          const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);
          if (elUnder && (elUnder === listEl || listEl.contains(elUnder)) && !elUnder.closest('.tree-row')) {
            Store.moveNode(entry.cached.id, null);
          }
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  return { init, render };
})();
