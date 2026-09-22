// tree-view.js
// Nestet listevisning ("træliste") af noterne.
// Tegner <ul>/<li> rekursivt ud fra Store, og håndterer:
//   - fold ud/ind pr. node (collapsed er kun session-state, ikke gemt)
//   - inline omdøbning (klik på navn eller på omdøb-knappen)
//   - tilføj underpunkt / slet (rekursivt via Store.deleteNode)
//   - flyt node: trækkes via et lille greb (⠿), med Pointer Events så det
//     virker med både mus, pen og touch (native HTML5 drag-and-drop
//     understøttes ikke af touch-enheder, så vi bygger det selv)

const TreeView = (() => {
  let listEl = null;
  const collapsed = new Set(); // ids der p.t. er foldet sammen

  function init(container) {
    listEl = container.querySelector('#tree-list');

    container.querySelector('#tree-new-root-btn').addEventListener('click', () => {
      const node = Store.addNode('Ny rod-node', null);
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

    // greb til at trække noden hen på en anden node (flytter den, med børn)
    const grip = document.createElement('button');
    grip.className = 'tree-grip';
    grip.title = 'Træk for at flytte';
    grip.setAttribute('aria-label', 'Flyt node');
    grip.textContent = '⠿';
    row.appendChild(grip);
    attachDragHandle(grip, row, node);

    // fold ud/ind
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

    // navn - klik/tryk for at redigere inline
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tree-name';
    nameSpan.textContent = node.name;
    nameSpan.tabIndex = 0;
    nameSpan.addEventListener('click', () => startEditing(node.id));
    row.appendChild(nameSpan);

    // handlingsknapper
    const actions = document.createElement('span');
    actions.className = 'tree-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-icon';
    addBtn.title = 'Tilføj underpunkt';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      collapsed.delete(node.id);
      const child = Store.addNode('Ny node', node.id);
      render();
      startEditing(child.id);
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-icon';
    renameBtn.title = 'Omdøb';
    renameBtn.textContent = '✎';
    renameBtn.addEventListener('click', e => {
      e.stopPropagation();
      startEditing(node.id);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon btn-danger';
    delBtn.title = 'Slet';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Slet "${node.name}" og alle underpunkter?`)) {
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

  // custom drag-and-drop via Pointer Events (dækker mus, pen og touch samlet)
  function attachDragHandle(handle, row, node) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return; // kun venstre-klik/primær touch
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
          // slippet over tom plads i listen -> flyt til rod-niveau
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
