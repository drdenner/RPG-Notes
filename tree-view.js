// tree-view.js
// Nested list view of the notes.
// Renders <ul>/<li> recursively from Store, and handles:
//   - collapse/expand per node (collapsed state is session-only, not saved)
//   - inline renaming (click the name or the rename button)
//   - add child / delete (recursive, via Store.deleteNode)
//   - notes button (opens the rich-text panel from notes-editor.js)
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
      startEditing(node.id);
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

    // name - click/tap to edit inline
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-name';
    nameSpan.textContent = node.name;
    nameSpan.tabIndex = 0;
    nameSpan.addEventListener('click', () => {
      if (AppMode.isEditMode()) startEditing(node.id);
    });
    row.appendChild(nameSpan);

    // notes button - always visible, even in view mode (it's read-only there)
    const notesBtn = document.createElement('button');
    notesBtn.className = 'btn-icon tree-notes-btn';
    if (node.notes) notesBtn.classList.add('has-notes');
    notesBtn.title = 'Notes';
    notesBtn.textContent = '📝';
    notesBtn.addEventListener('click', e => {
      e.stopPropagation();
      NotesEditor.open(node.id);
    });
    row.appendChild(notesBtn);

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
      startEditing(child.id);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-icon';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', e => {
      e.stopPropagation();
      startEditing(node.id);
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

    actions.append(addBtn, renameBtn, delBtn);
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

  function startEditing(id) {
    const row = listEl.querySelector(`.tree-node[data-id="${id}"] > .tree-row`);
    if (!row) return;
    const nameSpan = row.querySelector('.tree-name');
    const node = Store.getById(id);

    const input = document.createElement('input');
    input.className = 'tree-name-input';
    input.type = 'text';
    input.value = node.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      Store.renameNode(id, input.value);
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = node.name; input.blur(); }
    });
  }

  return { init, render };
})();
