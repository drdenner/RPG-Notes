// The Locations tab: locations with descriptions, notes and linked NPCs.
const LocationsView = (() => {
  const LOCATION_BOARD = 'locations';
  const NPC_BOARD = 'npcs';

  let listEl, searchEl, emptyEl, newBtn;
  let stateFor = null;
  let openLocations = new Set();
  let openNpcs = new Set();
  let editing = null;

  function key(what) {
    return `rpg-notes-locations-${what}-${Store.getCurrentCampaignId()}`;
  }

  function loadState() {
    stateFor = Store.getCurrentCampaignId();
    const read = what => {
      try {
        const saved = JSON.parse(localStorage.getItem(key(what)) || '[]');
        return new Set(Array.isArray(saved) ? saved : []);
      } catch (e) {
        return new Set();
      }
    };
    openLocations = read('open');
    openNpcs = read('npc-open');
  }

  function saveState() {
    try {
      localStorage.setItem(key('open'), JSON.stringify([...openLocations]));
      localStorage.setItem(key('npc-open'), JSON.stringify([...openNpcs]));
    } catch (e) { /* storage unavailable - just not remembered */ }
  }

  function init(container) {
    listEl = container.querySelector('#location-list');
    searchEl = container.querySelector('#location-search');
    emptyEl = container.querySelector('#location-empty');
    newBtn = container.querySelector('#location-new-btn');

    newBtn.addEventListener('click', addLocation);
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
    if (stateFor !== Store.getCurrentCampaignId()) loadState();

    const locations = Store.getBoardNodes(LOCATION_BOARD);
    const npcs = Store.getBoardNodes(NPC_BOARD);
    const query = searchEl.value.trim().toLowerCase();
    const matches = (location, linkedNpcs) => !query || [
      location.name, location.notes, location.note || '',
      ...linkedNpcs.flatMap(npc => [npc.name, npc.notes, npc.note || ''])
    ].some(text => text.toLowerCase().includes(query));

    listEl.innerHTML = '';
    const shown = locations
      .map(location => ({
        location,
        npcs: npcs.filter(npc => npc.locationId === location.id)
          .sort((a, b) => a.name.localeCompare(b.name))
      }))
      .filter(group => matches(group.location, group.npcs))
      .sort((a, b) => a.location.name.localeCompare(b.location.name));

    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = !Store.getCurrentCampaignId() ? 'Create or pick a campaign first.'
      : locations.length ? 'No locations match.'
      : 'No locations yet.' + (AppMode.isEditMode() ? ' Tap "+ New location" to add one.' : '');

    shown.forEach(group => listEl.appendChild(renderLocation(group.location, group.npcs, !!query)));
  }

  function renderLocation(location, npcs, searching) {
    const open = searching || openLocations.has(location.id);
    const section = el('section', 'npc-group location-group' + (open ? ' open' : ''));
    const head = el('div', 'npc-group-head');
    const toggle = el('button', 'npc-group-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(
      el('span', 'npc-caret', open ? '▾' : '▸'),
      el('span', 'npc-group-name', location.name),
      el('span', 'npc-group-count', String(npcs.length))
    );
    toggle.dataset.id = location.id;
    toggle.addEventListener('click', () => {
      if (openLocations.has(location.id)) openLocations.delete(location.id);
      else openLocations.add(location.id);
      saveState();
      render();
    });
    head.appendChild(toggle);

    if (open && AppMode.isEditMode()) {
      const editBtn = el('button', 'btn-icon npc-edit', '✎');
      editBtn.title = 'Edit location';
      editBtn.addEventListener('click', () => startEditing(location.id, 'location'));
      const delBtn = el('button', 'btn-icon btn-danger npc-del', '✕');
      delBtn.title = 'Delete location';
      delBtn.addEventListener('click', () => {
        const prompt = npcs.length
          ? `Delete "${location.name}" and its ${npcs.length} NPC${npcs.length === 1 ? '' : 's'}?`
          : `Delete the location "${location.name}"?`;
        if (confirm(prompt)) Store.deleteNode(location.id);
      });
      head.append(editBtn, delBtn);
    }
    section.appendChild(head);

    if (open) {
      const body = el('div', 'location-body');
      body.appendChild(textBlock('Description', location.notes, 'No description.'));
      body.appendChild(textBlock('Note', location.note || '', 'No note.'));
      const npcHeading = el('div', 'location-npc-heading');
      npcHeading.appendChild(el('span', 'npc-label', 'NPCs'));
      if (AppMode.isEditMode()) {
        const addBtn = el('button', 'btn-icon npc-group-add', '+');
        addBtn.title = `Add NPC to ${location.name}`;
        addBtn.setAttribute('aria-label', `Add NPC to ${location.name}`);
        addBtn.addEventListener('click', () => addNpc(location.id));
        npcHeading.appendChild(addBtn);
      }
      body.appendChild(npcHeading);
      const list = el('ul', 'npc-list');
      if (npcs.length) npcs.forEach(npc => list.appendChild(renderNpc(npc)));
      else list.appendChild(el('li', 'location-no-npcs', 'No NPCs yet.'));
      body.appendChild(list);
      section.appendChild(body);
    }
    return section;
  }

  function renderNpc(npc) {
    const open = openNpcs.has(npc.id);
    const item = el('li', 'npc' + (open ? ' open' : ''));
    item.dataset.id = npc.id;
    const head = el('div', 'npc-head');
    const toggle = el('button', 'npc-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(el('span', 'npc-caret', open ? '▾' : '▸'), el('span', 'npc-name', npc.name));
    if (!open && npc.notes) toggle.appendChild(el('span', 'npc-preview', npc.notes.replace(/\*\*/g, '').split('\n')[0]));
    toggle.addEventListener('click', () => {
      if (openNpcs.has(npc.id)) openNpcs.delete(npc.id);
      else openNpcs.add(npc.id);
      saveState();
      render();
    });
    head.appendChild(toggle);

    if (open && AppMode.isEditMode()) {
      const editBtn = el('button', 'btn-icon npc-edit', '✎');
      editBtn.title = 'Edit NPC';
      editBtn.addEventListener('click', () => startEditing(npc.id, 'npc'));
      const delBtn = el('button', 'btn-icon btn-danger npc-del', '✕');
      delBtn.title = 'Delete NPC';
      delBtn.addEventListener('click', () => {
        if (confirm(`Delete the NPC "${npc.name}"?`)) Store.deleteNode(npc.id);
      });
      head.append(editBtn, delBtn);
    }
    item.appendChild(head);

    if (open) {
      const body = el('div', 'npc-body');
      body.appendChild(textBlock('Description', npc.notes, 'No description.'));
      body.appendChild(textBlock('Note', npc.note || '', 'No note.'));
      item.appendChild(body);
    }
    return item;
  }

  function textBlock(label, text, emptyText) {
    const block = el('div', 'npc-field');
    block.appendChild(el('div', 'npc-label', label));
    const value = el('div', 'npc-text');
    if (text) value.innerHTML = NotesEditor.renderNotes(text);
    else { value.textContent = emptyText; value.classList.add('npc-text-empty'); }
    block.appendChild(value);
    return block;
  }

  function addLocation() {
    if (!AppMode.isEditMode()) return;
    const location = Store.addBoardNode(LOCATION_BOARD, 'New location', 0, 0, { note: '' });
    if (!location) return;
    searchEl.value = '';
    openLocations.add(location.id);
    saveState();
    render();
    startEditing(location.id, 'location', true);
  }

  function addNpc(locationId) {
    if (!AppMode.isEditMode()) return;
    const npc = Store.addBoardNode(NPC_BOARD, 'New NPC', 0, 0, { locationId, note: '' });
    if (!npc) return;
    searchEl.value = '';
    openLocations.add(locationId);
    openNpcs.add(npc.id);
    saveState();
    render();
    startEditing(npc.id, 'npc', true);
  }

  function startEditing(id, type, isNew = false) {
    if (!AppMode.isEditMode()) return;
    if (editing) finishEditing();
    const board = type === 'location' ? LOCATION_BOARD : NPC_BOARD;
    const record = Store.getBoardNodes(board).find(node => node.id === id);
    const target = type === 'location'
      ? [...listEl.querySelectorAll('.location-group')].find(section =>
          section.querySelector('.npc-group-toggle')?.dataset.id === id)
      : listEl.querySelector(`.npc[data-id="${CSS.escape(id)}"]`);
    if (!record || !target) return;

    const form = el('div', 'npc-form');
    const field = (label, input) => {
      const wrap = el('label', 'npc-form-field');
      wrap.append(el('span', 'npc-label', label), input);
      form.appendChild(wrap);
      return input;
    };
    const title = field(type === 'location' ? 'Title' : 'Name', Object.assign(el('input', 'npc-input'), {
      type: 'text', value: record.name
    }));
    const description = field('Description', Object.assign(el('textarea', 'npc-input'), {
      rows: 4, value: record.notes
    }));
    const note = field('Note', Object.assign(el('textarea', 'npc-input'), {
      rows: 3, value: record.note || ''
    }));
    const actions = el('div', 'npc-form-actions');
    const done = el('button', 'btn btn-primary', 'Done');
    done.addEventListener('click', finishEditing);
    actions.appendChild(done);
    form.append(actions);

    target.innerHTML = '';
    target.classList.add('editing');
    target.appendChild(form);
    editing = { id, target, fields: { title, description, note } };
    target.addEventListener('focusout', e => {
      if (editing && editing.target === target && !target.contains(e.relatedTarget)) finishEditing();
    });
    target.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); finishEditing(); }
    });
    if (isNew || window.matchMedia('(pointer: fine)').matches) {
      title.focus();
      if (isNew) title.select();
    }
    target.scrollIntoView({ block: 'nearest' });
  }

  function finishEditing() {
    if (!editing) return;
    const { id, fields } = editing;
    editing = null;
    Store.updateNode(id, {
      name: fields.title.value,
      notes: fields.description.value,
      note: fields.note.value
    });
    render();
  }

  document.addEventListener('pointerdown', e => {
    if (editing && !editing.target.contains(e.target) && document.activeElement && editing.target.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  });

  return { init, show, render };
})();