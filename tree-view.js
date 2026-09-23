// tree-view.js
// Nested list view of the notes.
// Renders <ul>/<li> recursively from Store, and handles:
//   - collapse/expand per node (collapsed state is session-only, not saved)
//   - clicking a node's name opens it (NotesEditor - rename and notes both
//     live there, there's no separate rename/notes button)
//   - add child / delete (recursive, via Store.deleteNode)
//   - move node: dragged via a small grip (⠿), using Pointer Events so it
//     works with mouse, pen and touch alike (native HTML5 drag-and-drop
//     isn't supported on touch devices, so we build it ourselves)

const TreeView = (() => {
  let listEl = null;
  const collapsed = new Set(); // ids that are currently collapsed

  function init(container) {
    listEl = container.querySelector('#tree-list');

    container.querySelector('#tree-new-root-btn').addEventListener('click', () => {
      const node = Store.addNode('New root node', null);
      render();
      NotesEditor.open(node.id);
    });
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    Store.getRoots().forEach(node => listEl.appendChild(buildNodeEl(node)));
  }

  function buildNodeEl(node) {
    const children = Store.getChildren(node.id);
    const li = document.createElement('li');
    li.className = 'tree-node';
    li.dataset.id = node.id;

    const row = document.createElement('div');
    row.className = 'tree-row';

    // grip to drag the node onto another node (moves it, with its children)
    const grip = document.createElement('button');
    grip.className = 'tree-grip';
    grip.title = 'Drag to move';
    grip.setAttribute('aria-label', 'Move node');
    grip.textContent = '⠿';
    row.appendChild(grip);
    attachDragHandle(grip, row, node);

    // collapse/expand
    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle';
    if (children.length > 0) {
      toggle.textContent = collapsed.has(node.id) ? '▶' : '▼';
      toggle.addEventListener('click', () => {
        if (collapsed.has(node.id)) collapsed.delete(node.id);
        else collapsed.add(node.id);
        render();
      });
    } else {
      toggle.classList.add('tree-toggle-empty');
      toggle.disabled = true;
    }
    row.appendChild(toggle);

    // name - click/tap opens the node (rename + notes live in that panel)
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-name';
    if (node.notes) nameSpan.classList.add('has-notes');
    nameSpan.textContent = node.name;
    nameSpan.tabIndex = 0;
    nameSpan.addEventListener('click', () => NotesEditor.open(node.id));
    row.appendChild(nameSpan);

    // action buttons
    const actions = document.createElement('span');
    actions.className = 'tree-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-icon';
    addBtn.title = 'Add child node';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      collapsed.delete(node.id);
      const child = Store.addNode('New node', node.id);
      render();
      NotesEditor.open(child.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon btn-danger';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete "${node.name}" and all its children?`)) {
        Store.deleteNode(node.id);
      }
    });

    actions.append(addBtn, delBtn);
    row.appendChild(actions);

    li.appendChild(row);

    if (children.length > 0 && !collapsed.has(node.id)) {
      const childList = document.createElement('ul');
      childList.className = 'tree-children';
      children.forEach(child => childList.appendChild(buildNodeEl(child)));
      li.appendChild(childList);
    }

    return li;
  }

  // custom drag-and-drop via Pointer Events (covers mouse, pen and touch)
  function attachDragHandle(handle, row, node) {
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
          if (targetLi && targetLi.dataset.id !== node.id) {
            Store.moveNode(node.id, targetLi.dataset.id);
          }
        } else if (ev.type === 'pointerup') {
          // dropped on empty space in the list -> move to root level
          const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);
          if (elUnder && (elUnder === listEl || listEl.contains(elUnder)) && !elUnder.closest('.tree-row')) {
            Store.moveNode(node.id, null);
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
