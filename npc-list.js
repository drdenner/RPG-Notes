// The NPCs tab: a simple directory with an optional location for each NPC.
const NpcList = (() => {
  const NPC_BOARD = 'npcs';
  const LOCATION_BOARD = 'locations';

  let listEl, searchEl, emptyEl, newBtn;
  let editing = null;

  function init(container) {
    listEl = container.querySelector('#npc-list');
    searchEl = container.querySelector('#npc-search');
    emptyEl = container.querySelector('#npc-empty');
    newBtn = container.querySelector('#npc-new-btn');
    newBtn.addEventListener('click', addNpc);
    searchEl.addEventListener('input', render);
    AppMode.subscribe(() => {
      if (editing) finishEditing();
      render();
    });
  }

  function show() {
    render();
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function render() {
    if (editing) return;
    const locations = Store.getBoardNodes(LOCATION_BOARD);
    const locationNames = new Map(locations.map(location => [location.id, location.name]));
    const npcs = Store.getBoardNodes(NPC_BOARD);
    const query = searchEl.value.trim().toLowerCase();
    const shown = npcs
      .filter(npc => !query || [npc.name, npc.notes, locationNames.get(npc.locationId) || 'Traveling']
        .some(text => text.toLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name));

    listEl.innerHTML = '';
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = !Store.getCurrentCampaignId() ? 'Create or pick a campaign first.'
      : npcs.length ? 'No NPCs match.'
      : 'No NPCs yet.' + (AppMode.isEditMode() ? ' Tap "+ New NPC" to add one.' : '');
    shown.forEach(npc => listEl.appendChild(renderNpc(npc, locationNames)));
  }

  function renderNpc(npc, locationNames) {
    const item = el('li', 'npc-directory-item');
    item.dataset.id = npc.id;
    const head = el('div', 'npc-directory-head');
    head.appendChild(el('strong', 'npc-name', npc.name));
    head.appendChild(el('span', 'npc-directory-location', locationNames.get(npc.locationId) || 'Traveling'));
    if (AppMode.isEditMode()) {
      const editBtn = el('button', 'btn-icon npc-edit', '✎');
      editBtn.title = 'Edit NPC';
      editBtn.setAttribute('aria-label', `Edit ${npc.name}`);
      editBtn.addEventListener('click', () => startEditing(npc.id));
      const delBtn = el('button', 'btn-icon btn-danger npc-del', '✕');
      delBtn.title = 'Delete NPC';
      delBtn.setAttribute('aria-label', `Delete ${npc.name}`);
      delBtn.addEventListener('click', () => {
        if (confirm(`Delete the NPC "${npc.name}"?`)) Store.deleteNode(npc.id);
      });
      head.append(editBtn, delBtn);
    }
    item.appendChild(head);
    const description = el('div', 'npc-directory-description');
    if (npc.notes) description.innerHTML = NotesEditor.renderNotes(npc.notes);
    else { description.textContent = 'No description.'; description.classList.add('npc-text-empty'); }
    item.appendChild(description);
    return item;
  }

  function addNpc() {
    if (!AppMode.isEditMode()) return;
    const npc = Store.addBoardNode(NPC_BOARD, 'New NPC', 0, 0, { locationId: '' });
    if (!npc) return;
    searchEl.value = '';
    render();
    startEditing(npc.id, true);
  }

  function startEditing(id, isNew = false) {
    if (!AppMode.isEditMode()) return;
    if (editing) finishEditing();
    const npc = Store.getBoardNodes(NPC_BOARD).find(node => node.id === id);
    const target = [...listEl.querySelectorAll('.npc-directory-item')].find(item => item.dataset.id === id);
    if (!npc || !target) return;

    const form = el('div', 'npc-form');
    const field = (label, input) => {
      const wrap = el('label', 'npc-form-field');
      wrap.append(el('span', 'npc-label', label), input);
      form.appendChild(wrap);
      return input;
    };
    const name = field('Name', Object.assign(el('input', 'npc-input'), {
      type: 'text', value: npc.name
    }));
    const description = field('Description', Object.assign(el('textarea', 'npc-input'), {
      rows: 4, value: npc.notes
    }));
    const location = Object.assign(el('select', 'npc-input'), { name: 'locationId' });
    const traveling = el('option', '', 'Traveling / no fixed location');
    traveling.value = '';
    location.appendChild(traveling);
    Store.getBoardNodes(LOCATION_BOARD)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(place => {
        const option = el('option', '', place.name);
        option.value = place.id;
        location.appendChild(option);
      });
    location.value = npc.locationId || '';
    field('Location', location);

    const actions = el('div', 'npc-form-actions');
    const done = el('button', 'btn btn-primary', 'Done');
    done.addEventListener('click', finishEditing);
    actions.appendChild(done);
    form.append(actions);

    target.innerHTML = '';
    target.classList.add('editing');
    target.appendChild(form);
    target.dataset.id = id;
    editing = { id, target, fields: { name, description, location } };
    target.addEventListener('focusout', e => {
      if (editing && editing.target === target && !target.contains(e.relatedTarget)) finishEditing();
    });
    target.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); finishEditing(); }
    });
    if (isNew || window.matchMedia('(pointer: fine)').matches) {
      name.focus();
      if (isNew) name.select();
    }
    target.scrollIntoView({ block: 'nearest' });
  }

  function finishEditing() {
    if (!editing) return;
    const { id, fields } = editing;
    editing = null;
    Store.updateNode(id, {
      name: fields.name.value,
      notes: fields.description.value,
      locationId: fields.location.value
    });
    render();
  }

  return { init, show, render };
})();
