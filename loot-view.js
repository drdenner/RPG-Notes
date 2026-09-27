// loot-view.js
// The "🎲 Tables" tab: roll random magic items (see loot.js) and put them
// into a node's notes, or just look the tables up.
//
// - Pick Minor/Medium/Major and how many, then tap what to roll (or
//   "Random item" to let the tables decide). New results go on top.
// - Tap results to select them; "Add to a node…" appends the selected
//   ones to the notes of a node you pick (one line each, the name in
//   **bold**), then offers to open that node.
// - The results, tier and count are remembered on this device only
//   (localStorage), so a reload doesn't lose them - they aren't part of
//   any campaign and aren't synced to Drive.
// - "Browse the tables" shows every table as it is in the SRD, each one
//   only built the first time it's opened.

const LootView = (() => {
  const STORAGE_KEY = 'rpg-notes-loot';
  const MAX_RESULTS = 200;

  let tier = 'minor';
  let count = 1;
  let results = []; // newest first: { id, name, price, tier, category, rolls, addedTo }
  const selected = new Set();

  let onOpenNode = () => {};
  let els = {};

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      if (Loot.TIERS.includes(saved.tier)) tier = saved.tier;
      if (Number.isInteger(saved.count) && saved.count > 0) count = saved.count;
      if (Array.isArray(saved.results)) results = saved.results.filter(r => r && typeof r.name === 'string');
    } catch (e) { /* unreadable or unavailable - start empty */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tier, count, results }));
    } catch (e) { /* storage full or unavailable - just not remembered */ }
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function init(container, callbacks) {
    onOpenNode = callbacks.onOpenNode || onOpenNode;
    load();
    els = {
      tierBtns: [...container.querySelectorAll('[data-tier]')],
      countSelect: container.querySelector('#loot-count'),
      rollBtns: container.querySelector('#loot-roll-btns'),
      results: container.querySelector('#loot-results'),
      empty: container.querySelector('#loot-empty'),
      selectAllBtn: container.querySelector('#loot-select-all-btn'),
      addBtn: container.querySelector('#loot-add-btn'),
      clearBtn: container.querySelector('#loot-clear-btn'),
      message: container.querySelector('#loot-message'),
      browse: container.querySelector('#loot-browse')
    };

    els.tierBtns.forEach(btn => btn.addEventListener('click', () => {
      tier = btn.dataset.tier;
      save();
      updateControls();
    }));

    els.countSelect.value = String(count);
    if (els.countSelect.value !== String(count)) { count = 1; els.countSelect.value = '1'; }
    els.countSelect.addEventListener('change', () => { count = Number(els.countSelect.value) || 1; save(); });

    const buttons = [{ id: 'any', label: '🎲 Random item' }, ...Loot.CATEGORIES];
    buttons.forEach(c => {
      const btn = el('button', 'btn loot-roll-btn' + (c.id === 'any' ? ' btn-primary' : ''), c.label);
      btn.dataset.category = c.id;
      btn.addEventListener('click', () => rollMany(c.id));
      els.rollBtns.appendChild(btn);
    });

    els.selectAllBtn.addEventListener('click', () => {
      const all = results.length && selected.size === results.length;
      selected.clear();
      if (!all) results.forEach(r => selected.add(r.id));
      renderResults();
    });
    els.clearBtn.addEventListener('click', () => {
      const which = selected.size ? 'the selected results' : 'all results';
      if (!confirm(`Remove ${which} from this list?\n\n(Anything already added to a node stays there.)`)) return;
      results = selected.size ? results.filter(r => !selected.has(r.id)) : [];
      selected.clear();
      save();
      renderResults();
    });
    els.addBtn.addEventListener('click', openNodePicker);

    buildBrowse();
    Store.subscribeCampaignChange(updateControls);
    updateControls();
    renderResults();
  }

  function updateControls() {
    els.tierBtns.forEach(btn => {
      const active = btn.dataset.tier === tier;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    els.rollBtns.querySelectorAll('[data-category]').forEach(btn => {
      const id = btn.dataset.category;
      btn.disabled = id !== 'any' && !Loot.isAvailable(id, tier);
      btn.title = btn.disabled ? `There are no ${tier} ${btn.textContent.toLowerCase()}` : '';
    });
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const n = selected.size;
    const hasCampaign = !!Store.getCurrentCampaignId();
    els.addBtn.textContent = n ? `Add ${n} to a node…` : 'Add to a node…';
    els.addBtn.disabled = !n || !hasCampaign;
    els.addBtn.title = !hasCampaign ? 'Create or pick a campaign first' : !n ? 'Tap results to select them first' : '';
    els.clearBtn.textContent = n ? 'Remove selected' : 'Clear';
    els.clearBtn.disabled = !results.length;
    els.selectAllBtn.textContent = results.length && n === results.length ? 'Select none' : 'Select all';
    els.selectAllBtn.disabled = !results.length;
  }

  function rollMany(categoryId) {
    const fresh = [];
    for (let i = 0; i < count; i++) {
      const item = Loot.rollItem(categoryId, tier);
      item.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      fresh.push(item);
    }
    results = [...fresh.reverse(), ...results].slice(0, MAX_RESULTS);
    for (const id of selected) if (!results.some(r => r.id === id)) selected.delete(id);
    hideMessage();
    save();
    renderResults(new Set(fresh.map(r => r.id)));
  }

  function renderResults(freshIds = new Set()) {
    els.results.innerHTML = '';
    els.empty.hidden = results.length > 0;
    results.forEach(r => {
      const li = el('li', 'loot-result');
      li.classList.toggle('selected', selected.has(r.id));
      li.classList.toggle('fresh', freshIds.has(r.id));

      const row = el('div', 'loot-result-row');
      row.setAttribute('role', 'checkbox');
      row.setAttribute('aria-checked', String(selected.has(r.id)));
      row.tabIndex = 0;
      const check = el('span', 'loot-check', selected.has(r.id) ? '✓' : '');
      const main = el('div', 'loot-result-main');
      main.appendChild(el('span', 'loot-result-name', r.name));
      const meta = el('span', 'loot-result-meta', [r.tier, Loot.formatPrice(r.price)].filter(Boolean).join(' · '));
      main.appendChild(meta);
      if (r.addedTo) main.appendChild(el('span', 'loot-result-added', '✓ in ' + r.addedTo));
      row.append(check, main);
      const toggle = () => {
        if (selected.has(r.id)) selected.delete(r.id); else selected.add(r.id);
        li.classList.toggle('selected', selected.has(r.id));
        check.textContent = selected.has(r.id) ? '✓' : '';
        row.setAttribute('aria-checked', String(selected.has(r.id)));
        updateSelectionUI();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });

      // every die rolled on the way, to see how it came about
      const details = el('details', 'loot-rolls');
      details.appendChild(el('summary', null, 'Rolls'));
      const list = el('ol');
      r.rolls.forEach(text => list.appendChild(el('li', text.startsWith('  ') ? 'loot-roll-note' : null, text.trim())));
      details.appendChild(list);

      li.append(row, details);
      els.results.appendChild(li);
    });
    updateSelectionUI();
  }

  // --- "Added 3 items to "Goblin cave" - Open" ---

  function showMessage(text, nodeId) {
    els.message.innerHTML = '';
    els.message.appendChild(el('span', null, text));
    const open = el('button', 'btn', 'Open');
    open.addEventListener('click', () => { hideMessage(); onOpenNode(nodeId); });
    els.message.appendChild(open);
    els.message.hidden = false;
  }

  function hideMessage() {
    els.message.hidden = true;
  }

  // --- picking the node to add the selected results to ---

  let picker = null;

  // every node in list order, with the path to it ("Chapter 1 › Goblin cave")
  function nodesInTreeOrder() {
    const all = Store.getAll();
    const children = new Map();
    all.forEach(n => {
      const key = n.parentId || null;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    });
    const out = [];
    const walk = (parentId, path) => (children.get(parentId) || []).forEach(n => {
      out.push({ node: n, path });
      walk(n.id, [...path, n.name]);
    });
    walk(null, []);
    return out;
  }

  function buildPicker() {
    const overlay = el('div', 'notes-overlay loot-picker-overlay');
    const panel = el('div', 'notes-panel loot-picker');
    const header = el('div', 'notes-header');
    const title = el('h2', 'loot-picker-title');
    const closeBtn = el('button', 'btn-icon', '✕');
    closeBtn.title = 'Cancel';
    header.append(title, closeBtn);
    const search = el('input', 'tree-search loot-picker-search');
    search.type = 'search';
    search.placeholder = 'Find a node…';
    search.autocomplete = 'off';
    const list = el('ul', 'loot-picker-list');
    const empty = el('p', 'loot-picker-empty', 'No nodes match.');
    panel.append(header, search, list, empty);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const close = () => overlay.classList.remove('open');
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    search.addEventListener('input', () => renderPickerList());

    picker = { overlay, title, search, list, empty, close };
  }

  function openNodePicker() {
    if (!selected.size || !Store.getCurrentCampaignId()) return;
    if (!picker) buildPicker();
    const n = selected.size;
    picker.title.textContent = `Add ${n} item${n === 1 ? '' : 's'} to…`;
    picker.search.value = '';
    renderPickerList();
    picker.overlay.classList.add('open');
    // only with a mouse/keyboard - on a tablet it would pop up the keyboard
    if (window.matchMedia('(pointer: fine)').matches) picker.search.focus();
  }

  function renderPickerList() {
    const query = picker.search.value.trim().toLowerCase();
    const entries = nodesInTreeOrder().filter(({ node, path }) =>
      !query || [...path, node.name].join(' ').toLowerCase().includes(query));
    picker.list.innerHTML = '';
    picker.empty.hidden = entries.length > 0;
    picker.empty.textContent = Store.getAll().length ? 'No nodes match.' : 'This campaign has no nodes yet. Add one in 📜 Notes first.';
    entries.forEach(({ node, path }) => {
      const li = el('li');
      const btn = el('button', 'loot-picker-node');
      if (path.length) btn.appendChild(el('span', 'loot-picker-path', path.join(' › ') + ' › '));
      btn.appendChild(el('span', 'loot-picker-name', node.name));
      btn.style.paddingLeft = (12 + Math.min(path.length, 6) * 14) + 'px';
      btn.addEventListener('click', () => addSelectedTo(node.id));
      li.appendChild(btn);
      picker.list.appendChild(li);
    });
  }

  // appends one line per selected result, in the order they're listed
  function addSelectedTo(nodeId) {
    const node = Store.getById(nodeId);
    if (!node) return;
    const items = results.filter(r => selected.has(r.id));
    const lines = items.map(r => `**${r.name}**` + (r.price != null ? ` (${Loot.formatPrice(r.price)})` : ''));
    const notes = node.notes.replace(/\s+$/, '');
    Store.updateNode(nodeId, { notes: (notes ? notes + '\n' : '') + lines.join('\n') });
    items.forEach(r => { r.addedTo = node.name; });
    selected.clear();
    save();
    picker.close();
    renderResults();
    showMessage(`Added ${items.length} item${items.length === 1 ? '' : 's'} to "${node.name}".`, nodeId);
  }

  // --- browsing the tables as they are in the SRD ---

  const BROWSE_GROUPS = [
    ['Magic items', ['item']],
    ['Armor and shields', ['armorShield', 'armorType', 'shieldType', 'armorAbility', 'shieldAbility', 'specificArmor', 'specificShield']],
    ['Weapons', ['weapon', 'weaponType', 'commonMelee', 'uncommonWeapon', 'commonRanged', 'ammunition', 'meleeAbility', 'rangedAbility', 'baneFoe', 'specificWeapon']],
    ['Potions, rings, rods, staffs and wands', ['potion', 'ring', 'rod', 'staff', 'wand']],
    ['Wondrous items', ['wondrousMinor', 'wondrousMedium', 'wondrousMajor']],
    ['Scrolls', ['scrollType', 'scrollLevel',
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => 'arcaneScroll' + n),
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => 'divineScroll' + n)]]
  ];

  function rangeText(range) {
    if (!range) return '—';
    const pad = n => String(n).padStart(2, '0');
    return range[0] === range[1] ? pad(range[0]) : `${pad(range[0])}–${pad(range[1])}`;
  }

  function buildBrowse() {
    BROWSE_GROUPS.forEach(([groupTitle, ids]) => {
      els.browse.appendChild(el('h3', 'loot-browse-group', groupTitle));
      ids.forEach(id => {
        const table = Loot.tables[id];
        const details = el('details', 'loot-browse-table');
        details.appendChild(el('summary', null, table.title));
        details.addEventListener('toggle', () => {
          if (details.open && !details.querySelector('table')) details.appendChild(renderTable(table));
        });
        els.browse.appendChild(details);
      });
    });
  }

  function renderTable(table) {
    const t = el('table', 'loot-table');
    const head = el('tr');
    const columns = table.tiered ? ['Minor', 'Medium', 'Major'] : ['d%'];
    if (table.tiered && table.rows.every(r => !r.ranges.minor)) columns.shift(); // rods, staffs
    [...columns, 'Result', 'Price'].forEach(c => head.appendChild(el('th', null, c)));
    t.appendChild(head);
    table.rows.forEach(r => {
      const tr = el('tr');
      columns.forEach(c => tr.appendChild(el('td', 'loot-table-range', rangeText(table.tiered ? r.ranges[c.toLowerCase()] : r.ranges.d))));
      // scroll spell levels: [spell level, caster level]
      tr.appendChild(el('td', null, r.extra.length ? `Spell level ${r.name}, caster level ${r.extra[1]}` : r.name));
      const price = r.bonus ? `+${r.bonus} bonus` : Loot.formatPrice(r.price);
      tr.appendChild(el('td', 'loot-table-price', price));
      t.appendChild(tr);
    });
    return t;
  }

  return { init };
})();
