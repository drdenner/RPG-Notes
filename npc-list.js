// npc-list.js
// The NPCs tab: every NPC of the campaign, with a name, a description, a
// location and a note, listed grouped by location.
//
// - The NPCs are nodes with board: 'npcs' in the campaign's node list (see
//   store.js): name, notes = description, location, note. So they're per
//   campaign, and go to Drive and backups like the rest.
// - One group per location (A-Z, "No location" last), each can be folded
//   in; tapping an NPC folds it out to show its description and note, and
//   several can be open at once. Which groups are folded in and which NPCs
//   are open is remembered per campaign on this device.
// - Search filters on name, location, description and note, and shows
//   every matching group unfolded.
// - Edit mode: "+ New NPC" (or + on a group, for an NPC at that location)
//   adds one, ✎ edits an open NPC right in the list, ✕ deletes it (with
//   Undo). The location field suggests the locations already used, so
//   "Millbrook" doesn't also end up as "Milbrook". The edit is saved with
//   Done, or when you tap anywhere outside it.
// - Description and note are plain text with **bold** and auto-links, like
//   a node's notes (NotesEditor.renderNotes).

const NpcList = (() => {
  const BOARD = 'npcs';
  const NO_LOCATION = 'No location';

  let groupsEl, searchEl, emptyEl, newBtn, locationListEl;
  let stateFor = null; // campaign whose open/collapsed state is loaded
  let openIds = new Set();
  let collapsedLocations = new Set();
  let editing = null; // { id, row, fields } while an NPC is being edited

  // --- remembered per campaign, this device only ---

  function key(what) {
    return `rpg-notes-npc-${what}-${Store.getCurrentCampaignId()}`;
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
    openIds = read('open');
    collapsedLocations = read('collapsed');
  }

  function saveState() {
    try {
      const existing = new Set(Store.getBoardNodes(BOARD).map(n => n.id));
      localStorage.setItem(key('open'), JSON.stringify([...openIds].filter(id => existing.has(id))));
      localStorage.setItem(key('collapsed'), JSON.stringify([...collapsedLocations]));
    } catch (e) { /* storage unavailable - just not remembered */ }
  }

  // --- setup ---

  function init(container) {
    groupsEl = container.querySelector('#npc-groups');
    searchEl = container.querySelector('#npc-search');
    emptyEl = container.querySelector('#npc-empty');
    newBtn = container.querySelector('#npc-new-btn');
    locationListEl = container.querySelector('#npc-locations');

    newBtn.addEventListener('click', () => addNpc(''));
    searchEl.addEventListener('input', render);
    AppMode.subscribe(() => {
      if (editing) finishEditing();
      render();
    });
  }

  // called by app.js when the tab is shown
  function show() {
    render();
  }

  // --- render: the whole list, rebuilt (it's cheap at NPC counts) ---

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function locationOf(npc) {
    return (typeof npc.location === 'string' && npc.location.trim()) || '';
  }

  function render() {
    if (editing) return; // don't throw away what's being typed - finishEditing renders
    if (stateFor !== Store.getCurrentCampaignId()) loadState();

    const npcs = Store.getBoardNodes(BOARD);
    const locations = [...new Set(npcs.map(locationOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    // the location field's suggestions
    locationListEl.innerHTML = '';
    locations.forEach(l => locationListEl.appendChild(Object.assign(document.createElement('option'), { value: l })));

    const query = searchEl.value.trim().toLowerCase();
    const matches = npc => !query || [npc.name, locationOf(npc), npc.notes, npc.note || '']
      .some(text => text.toLowerCase().includes(query));

    groupsEl.innerHTML = '';
    const hasCampaign = !!Store.getCurrentCampaignId();
    const shown = npcs.filter(matches);
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = !hasCampaign ? 'Create or pick a campaign first.'
      : npcs.length ? 'No NPCs match.'
      : 'No NPCs yet.' + (AppMode.isEditMode() ? ' Tap "+ New NPC" to add one.' : '');

    [...locations, ''].forEach(location => {
      const inGroup = shown.filter(n => locationOf(n) === location).sort((a, b) => a.name.localeCompare(b.name));
      if (!inGroup.length) return;
      groupsEl.appendChild(renderGroup(location, inGroup, !!query));
    });
  }

  function renderGroup(location, npcs, searching) {
    const collapsed = !searching && collapsedLocations.has(location);
    const section = el('section', 'npc-group' + (collapsed ? ' collapsed' : ''));
    const head = el('div', 'npc-group-head');
    const toggle = el('button', 'npc-group-toggle');
    toggle.append(
      el('span', 'npc-caret', collapsed ? '▸' : '▾'),
      el('span', 'npc-group-name' + (location ? '' : ' npc-no-location'), location || NO_LOCATION),
      el('span', 'npc-group-count', String(npcs.length))
    );
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.addEventListener('click', () => {
      if (searching) return; // while searching every group stays unfolded
      if (collapsedLocations.has(location)) collapsedLocations.delete(location);
      else collapsedLocations.add(location);
      saveState();
      render();
    });
    const addBtn = el('button', 'btn-icon npc-group-add', '+');
    addBtn.title = location ? `New NPC in ${location}` : 'New NPC';
    addBtn.addEventListener('click', () => addNpc(location));
    head.append(toggle, addBtn);
    section.appendChild(head);

    if (!collapsed) {
      const list = el('ul', 'npc-list');
      npcs.forEach(npc => list.appendChild(renderNpc(npc)));
      section.appendChild(list);
    }
    return section;
  }

  function renderNpc(npc) {
    const open = openIds.has(npc.id);
    const li = el('li', 'npc' + (open ? ' open' : ''));
    li.dataset.id = npc.id;

    const head = el('div', 'npc-head');
    const toggle = el('button', 'npc-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(el('span', 'npc-caret', open ? '▾' : '▸'), el('span', 'npc-name', npc.name));
    // folded in: the start of the description, to tell NPCs apart at a glance
    if (!open && npc.notes) toggle.appendChild(el('span', 'npc-preview', npc.notes.replace(/\*\*/g, '').split('\n')[0]));
    toggle.addEventListener('click', () => {
      if (openIds.has(npc.id)) openIds.delete(npc.id); else openIds.add(npc.id);
      saveState();
      render();
    });
    head.appendChild(toggle);

    if (open) {
      const editBtn = el('button', 'btn-icon npc-edit', '✎');
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', () => startEditing(npc.id));
      const delBtn = el('button', 'btn-icon btn-danger npc-del', '✕');
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', () => {
        if (confirm(`Delete the NPC "${npc.name}"?`)) Store.deleteNode(npc.id);
      });
      head.append(editBtn, delBtn);
    }
    li.appendChild(head);

    if (open) {
      const body = el('div', 'npc-body');
      body.appendChild(textBlock('Description', npc.notes, 'No description.'));
      body.appendChild(textBlock('Note', npc.note || '', 'No note.'));
      li.appendChild(body);
    }
    return li;
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

  // --- adding and editing ---

  function addNpc(location) {
    if (!AppMode.isEditMode()) return;
    const npc = Store.addBoardNode(BOARD, 'New NPC', 0, 0, { location, note: '' });
    if (!npc) return;
    searchEl.value = ''; // so the new one is in view
    openIds.add(npc.id);
    collapsedLocations.delete(location);
    saveState();
    render();
    startEditing(npc.id, { isNew: true });
  }

  // the NPC's row becomes a small form: name, location, description, note
  function startEditing(id, { isNew = false } = {}) {
    if (!AppMode.isEditMode()) return;
    if (editing) finishEditing();
    const npc = Store.getBoardNodes(BOARD).find(n => n.id === id);
    const row = groupsEl.querySelector(`.npc[data-id="${CSS.escape(id)}"]`);
    if (!npc || !row) return;

    const form = el('div', 'npc-form');
    const field = (label, input) => {
      const wrap = el('label', 'npc-form-field');
      wrap.append(el('span', 'npc-label', label), input);
      form.appendChild(wrap);
      return input;
    };
    const name = field('Name', Object.assign(el('input', 'npc-input'), { type: 'text', value: npc.name }));
    const location = field('Location', Object.assign(el('input', 'npc-input'), {
      type: 'text', value: locationOf(npc), placeholder: 'e.g. Millbrook - leave empty for no location'
    }));
    location.setAttribute('list', 'npc-locations');
    location.autocomplete = 'off';
    const description = field('Description', Object.assign(el('textarea', 'npc-input'), { rows: 4, value: npc.notes }));
    const note = field('Note', Object.assign(el('textarea', 'npc-input'), { rows: 3, value: npc.note || '' }));
    const hint = el('p', 'npc-hint', '**bold text** for bold - links are detected automatically.');
    const actions = el('div', 'npc-form-actions');
    const done = el('button', 'btn btn-primary', 'Done');
    done.addEventListener('click', finishEditing);
    actions.appendChild(done);
    form.append(hint, actions);

    row.innerHTML = '';
    row.classList.add('editing');
    row.appendChild(form);
    editing = { id, row, fields: { name, location, description, note } };

    // leaving the form (tapping elsewhere, another tab, ...) saves it
    row.addEventListener('focusout', e => {
      if (editing && editing.row === row && !row.contains(e.relatedTarget)) finishEditing();
    });
    row.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); finishEditing(); }
    });

    if (isNew) {
      name.focus();
      name.select();
    } else if (window.matchMedia('(pointer: fine)').matches) {
      name.focus(); // on a tablet only when tapped, so the keyboard doesn't jump up
    }
    row.scrollIntoView({ block: 'nearest' });
  }

  function finishEditing() {
    if (!editing) return;
    const { id, fields } = editing;
    editing = null;
    Store.updateNode(id, {
      name: fields.name.value,
      location: fields.location.value,
      notes: fields.description.value,
      note: fields.note.value
    });
    render(); // also when nothing changed (then the Store didn't notify)
  }

  // tapping anywhere outside the form ends editing too - on a tablet,
  // tapping a spot that can't take focus doesn't blur the field by itself
  document.addEventListener('pointerdown', e => {
    if (editing && !editing.row.contains(e.target) && document.activeElement && editing.row.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  });

  return { init, show, render };
})();
