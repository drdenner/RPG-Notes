// player-list.js
// The Players tab: keeps track of each player's magic items and wealth,
// e.g. to hand out treasure fairly.
//
// - Each player has a name, a list of magic items (a title and a value in
//   gp each) and a note. Their total = the items' values added up.
// - The players are nodes with board: 'players' in the campaign's node
//   list (see store.js): name, items, notes = the note. So they're
//   per campaign, and go to Drive and backups like the rest.
// - One line per player (A-Z) with their number of items and total, and the
//   party's totals at the top. Tapping a player folds them out to show
//   every item with its value, the total and the note; several can be
//   open at once, and which ones is remembered per campaign on this
//   device. "Show all" / "Hide all" folds every player out or in.
// - Edit mode: "+ New player" adds one, ✎ edits an open player right in
//   the list (name, items, note), ✕ deletes them (with Undo). The
//   edit is saved with Done, or when you tap anywhere outside it.

const PlayerList = (() => {
  const BOARD = 'players';

  let listEl, summaryEl, emptyEl, newBtn, toggleAllBtn;
  let stateFor = null; // campaign whose open state is loaded
  let openIds = new Set();
  let editing = null; // { id, row, fields } while a player is being edited

  // --- which players are folded out (per campaign, this device only) ---

  function openKey() {
    return 'rpg-notes-player-open-' + Store.getCurrentCampaignId();
  }

  function loadOpen() {
    stateFor = Store.getCurrentCampaignId();
    try {
      const saved = JSON.parse(localStorage.getItem(openKey()) || '[]');
      openIds = new Set(Array.isArray(saved) ? saved : []);
    } catch (e) {
      openIds = new Set();
    }
  }

  function saveOpen() {
    try {
      const existing = new Set(Store.getBoardNodes(BOARD).map(n => n.id));
      localStorage.setItem(openKey(), JSON.stringify([...openIds].filter(id => existing.has(id))));
    } catch (e) { /* storage unavailable - just not remembered */ }
  }

  // --- setup ---

  function init(container) {
    listEl = container.querySelector('#player-list');
    summaryEl = container.querySelector('#player-summary');
    emptyEl = container.querySelector('#player-empty');
    newBtn = container.querySelector('#player-new-btn');
    toggleAllBtn = container.querySelector('#player-toggle-all-btn');

    newBtn.addEventListener('click', addPlayer);
    toggleAllBtn.addEventListener('click', () => {
      const players = Store.getBoardNodes(BOARD);
      const allOpen = players.every(p => openIds.has(p.id));
      openIds = allOpen ? new Set() : new Set(players.map(p => p.id));
      saveOpen();
      render();
    });
    AppMode.subscribe(() => {
      if (editing) finishEditing();
      render();
    });
  }

  // called by app.js when the tab is shown
  function show() {
    render();
  }

  // --- numbers ---

  function itemsOf(player) {
    return Array.isArray(player.items) ? player.items : [];
  }

  function totalOf(player) {
    return itemsOf(player).reduce((sum, item) => sum + (item.value || 0), 0);
  }

  // 1234.5 → "1,234.5 gp"
  function gp(amount) {
    return (Math.round(amount * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' gp';
  }

  // --- render: the whole list, rebuilt (it's cheap at party sizes) ---

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    if (editing) return; // don't throw away what's being typed - finishEditing renders
    if (stateFor !== Store.getCurrentCampaignId()) loadOpen();

    // by name, so the order never changes by itself (e.g. after an Undo)
    const players = Store.getBoardNodes(BOARD).sort((a, b) => a.name.localeCompare(b.name));
    const hasCampaign = !!Store.getCurrentCampaignId();
    emptyEl.hidden = players.length > 0;
    emptyEl.textContent = !hasCampaign ? 'Create or pick a campaign first.'
      : 'No players yet.' + (AppMode.isEditMode() ? ' Tap "+ New player" to add one.' : '');
    toggleAllBtn.hidden = players.length === 0;
    toggleAllBtn.textContent = players.length && players.every(p => openIds.has(p.id)) ? 'Hide all' : 'Show all';

    // the party as a whole
    summaryEl.hidden = players.length === 0;
    summaryEl.innerHTML = '';
    const itemCount = players.reduce((sum, p) => sum + itemsOf(p).length, 0);
    summaryEl.append(
      el('span', 'player-summary-label', 'Party'),
      el('span', 'player-summary-value', `${players.length} player${players.length === 1 ? '' : 's'}`),
      el('span', 'player-summary-value', `${itemCount} item${itemCount === 1 ? '' : 's'}`),
      el('span', 'player-summary-value player-summary-total', gp(players.reduce((sum, p) => sum + totalOf(p), 0)))
    );

    listEl.innerHTML = '';
    players.forEach(player => listEl.appendChild(renderPlayer(player)));
  }

  function renderPlayer(player) {
    const open = openIds.has(player.id);
    const li = el('li', 'player' + (open ? ' open' : ''));
    li.dataset.id = player.id;
    const items = itemsOf(player);

    const head = el('div', 'player-head');
    const toggle = el('button', 'player-toggle');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.append(
      el('span', 'npc-caret', open ? '▾' : '▸'),
      el('span', 'player-name', player.name),
      el('span', 'player-count', `${items.length} item${items.length === 1 ? '' : 's'}`),
      el('span', 'player-total', gp(totalOf(player)))
    );
    toggle.addEventListener('click', () => {
      if (openIds.has(player.id)) openIds.delete(player.id); else openIds.add(player.id);
      saveOpen();
      render();
    });
    head.appendChild(toggle);
    if (open) {
      const editBtn = el('button', 'btn-icon player-edit', '✎');
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', () => startEditing(player.id));
      const delBtn = el('button', 'btn-icon btn-danger player-del', '✕');
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', () => {
        if (confirm(`Delete the player "${player.name}" and their list of items?`)) Store.deleteNode(player.id);
      });
      head.append(editBtn, delBtn);
    }
    li.appendChild(head);

    if (open) {
      const body = el('div', 'player-body');
      body.appendChild(el('div', 'npc-label', 'Magic items'));
      const table = el('table', 'player-items');
      if (items.length) {
        items.forEach(item => {
          const tr = el('tr');
          tr.append(el('td', null, item.title), el('td', 'player-gp', gp(item.value || 0)));
          table.appendChild(tr);
        });
      } else {
        const tr = el('tr');
        tr.appendChild(el('td', 'npc-text-empty', 'No magic items.'));
        table.appendChild(tr);
      }
      // the total, under the items
      const sum = el('tr', 'player-sum player-sum-total');
      sum.append(el('td', null, 'Total'), el('td', 'player-gp', gp(totalOf(player))));
      table.appendChild(sum);
      body.appendChild(table);

      const note = el('div', 'npc-field player-note');
      note.appendChild(el('div', 'npc-label', 'Note'));
      const noteText = el('div', 'npc-text');
      if (player.notes) noteText.innerHTML = NotesEditor.renderNotes(player.notes);
      else { noteText.textContent = 'No note.'; noteText.classList.add('npc-text-empty'); }
      note.appendChild(noteText);
      body.appendChild(note);
      li.appendChild(body);
    }
    return li;
  }

  // --- adding and editing ---

  function addPlayer() {
    if (!AppMode.isEditMode()) return;
    const player = Store.addBoardNode(BOARD, 'New player', 0, 0, { items: [] });
    if (!player) return;
    openIds.add(player.id);
    saveOpen();
    render();
    startEditing(player.id, { isNew: true });
  }

  // a number typed in a gp field: "" = 0; a comma counts as a decimal
  // point ("12,5"), since type="number" fields may hand it over either way
  function parseGp(text) {
    const n = parseFloat(String(text).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }

  function gpInput(value) {
    const input = el('input', 'npc-input player-gp-input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = 'any';
    input.min = '0';
    input.placeholder = '0';
    input.value = value ? String(value) : '';
    return input;
  }

  // the player's row becomes a form: name, the items (a row each), note
  function startEditing(id, { isNew = false } = {}) {
    if (!AppMode.isEditMode()) return;
    if (editing) finishEditing();
    const player = Store.getBoardNodes(BOARD).find(n => n.id === id);
    const row = listEl.querySelector(`.player[data-id="${CSS.escape(id)}"]`);
    if (!player || !row) return;

    const form = el('div', 'npc-form');
    const field = (label, input) => {
      const wrap = el('label', 'npc-form-field');
      wrap.append(el('span', 'npc-label', label), input);
      form.appendChild(wrap);
      return input;
    };
    const name = field('Name', Object.assign(el('input', 'npc-input'), {
      type: 'text', value: player.name, placeholder: 'e.g. Anna (Thorin, dwarf fighter)'
    }));

    // the items: title + value per row, ✕ removes one, "+ Add item" adds one
    const itemsBox = el('div', 'player-form-items');
    itemsBox.appendChild(el('span', 'npc-label', 'Magic items'));
    const itemRows = el('div', 'player-form-item-rows');
    const addItemRow = (item = { title: '', value: 0 }) => {
      const r = el('div', 'player-form-item');
      const title = Object.assign(el('input', 'npc-input'), { type: 'text', value: item.title, placeholder: 'e.g. Ring of protection +1' });
      const value = gpInput(item.value);
      value.setAttribute('aria-label', 'Value in gp');
      const remove = el('button', 'btn-icon btn-danger', '✕');
      remove.type = 'button';
      remove.title = 'Remove this item';
      // focus stays in the form (on "+ Add item"), so taking the focused
      // ✕ away doesn't count as leaving the form, which would end editing
      remove.addEventListener('click', () => { addItemBtn.focus(); r.remove(); });
      r.append(title, value, el('span', 'player-gp-unit', 'gp'), remove);
      itemRows.appendChild(r);
      return title;
    };
    itemsOf(player).forEach(item => addItemRow(item));
    const addItemBtn = el('button', 'btn player-add-item', '+ Add item');
    addItemBtn.type = 'button';
    addItemBtn.addEventListener('click', () => addItemRow().focus());
    itemsBox.append(itemRows, addItemBtn);
    form.appendChild(itemsBox);

    const note = field('Note', Object.assign(el('textarea', 'npc-input'), { rows: 3, value: player.notes || '' }));
    const actions = el('div', 'npc-form-actions');
    const done = el('button', 'btn btn-primary', 'Done');
    done.addEventListener('click', finishEditing);
    actions.appendChild(done);
    form.append(el('p', 'npc-hint', 'Items without a title are left out. **bold text** for bold in the note.'), actions);

    row.innerHTML = '';
    row.classList.add('editing');
    row.appendChild(form);
    editing = { id, row, fields: { name, itemRows, note } };

    // leaving the form (tapping elsewhere, another tab, ...) saves it
    // (a field that was just removed from the form doesn't count)
    row.addEventListener('focusout', e => {
      if (!e.target.isConnected) return;
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
    const items = [...fields.itemRows.querySelectorAll('.player-form-item')].map(r => {
      const [title, value] = r.querySelectorAll('input');
      return { title: title.value, value: parseGp(value.value) };
    });
    Store.updateNode(id, {
      name: fields.name.value,
      items,
      notes: fields.note.value
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
