// notes-board.js
// The Notes tab: loose notes (a title and a description) as cards on a
// board you can pan and zoom, like the mindmap - but without lines between
// them, and a note isn't opened in a panel: tapping its title folds it out
// right where it is, so several can be open side by side. Tapping the
// title again folds it back in.
//
// - The notes are nodes with board: 'notes' in the campaign's node list
//   (see store.js): name = title, notes = description, x/y = place on the
//   board. So they're per campaign, and go to Drive and backups like the
//   rest.
// - Which notes are folded out is remembered per campaign on this device.
// - Edit mode: "+ New note" adds one (folded out, title ready to type),
//   ✎ on an open note edits its title and description right in the card,
//   ✕ deletes it (with Undo, like any node), and dragging a card by its
//   title bar moves it. The edit is saved with Done, or when you tap
//   anywhere outside the card.
// - The description is plain text with **bold** and auto-links, the same
//   as a node's notes (NotesEditor.renderNotes).
// - Panning (one finger / mouse on empty board), pinch-zoom (two fingers)
//   and wheel-zoom work as in the mindmap.

const NotesBoard = (() => {
  const BOARD = 'notes';
  const MOVE_THRESHOLD = 5; // px, before a tap on a title bar counts as a drag

  let canvasEl, worldEl, newBtn, emptyEl;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let centeredFor = null; // campaign the view was last centered for
  let topZ = 1; // the card touched last is drawn on top

  // note id -> { div, titleEl, titleInput, textEl, textarea, cached, editing }
  const entries = new Map();
  let openIds = new Set();

  // --- which notes are folded out (per campaign, this device only) ---

  function openKey() {
    return 'rpg-notes-board-open-' + Store.getCurrentCampaignId();
  }

  function loadOpen() {
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
    canvasEl = container.querySelector('#board-canvas');
    worldEl = container.querySelector('#board-world');
    newBtn = container.querySelector('#board-new-btn');
    emptyEl = container.querySelector('#board-empty');

    newBtn.addEventListener('click', addNote);

    canvasEl.addEventListener('wheel', e => {
      if (e.target.closest('.board-card-body')) return; // scrolls a long description instead
      e.preventDefault();
      const p = toCanvas(e.clientX, e.clientY);
      zoomAround(p, zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });
    canvasEl.addEventListener('pointerdown', onCanvasPointerDown);

    Store.subscribeCampaignChange(() => {
      entries.forEach((entry, id) => removeEntry(id));
      loadOpen();
    });
    // switching to view mode saves a note being edited (the ✎/✕ buttons and
    // "+ New note" are hidden by style.css)
    AppMode.subscribe(() => {
      entries.forEach(entry => { if (entry.editing) finishEditing(entry); });
      render();
    });
    loadOpen();
    applyTransform();
  }

  // called by app.js when the tab is shown (visible, so it can measure)
  function show() {
    render();
    if (centeredFor !== Store.getCurrentCampaignId()) {
      centeredFor = Store.getCurrentCampaignId();
      centerView();
    }
  }

  // --- pan and zoom (the same gestures as the mindmap) ---

  const activePointers = new Map(); // pointerId -> {x, y}
  let panPointerId = null;
  let panStart = null;
  let pinchStart = null;

  function clampZoom(z) {
    return Math.min(2.5, Math.max(0.3, z));
  }

  function toCanvas(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // zooms to `newZoom`, keeping the world point under canvas point `p` in place
  function zoomAround(p, newZoom) {
    const worldX = (p.x - panX) / zoom;
    const worldY = (p.y - panY) / zoom;
    zoom = clampZoom(newZoom);
    panX = p.x - worldX * zoom;
    panY = p.y - worldY * zoom;
    applyTransform();
  }

  function onCanvasPointerDown(e) {
    if (e.target !== canvasEl && e.target !== worldEl) return; // only on the empty board
    // tapping the board also ends editing a card (it loses focus); keep that
    // working on touch screens, where tapping a non-focusable spot doesn't blur
    if (document.activeElement && worldEl.contains(document.activeElement)) document.activeElement.blur();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 1) {
      panPointerId = e.pointerId;
      panStart = { x: e.clientX, y: e.clientY, panX, panY };
      document.addEventListener('pointermove', onCanvasPointerMove);
      document.addEventListener('pointerup', onCanvasPointerUp);
      document.addEventListener('pointercancel', onCanvasPointerUp);
    } else if (activePointers.size === 2) {
      panPointerId = null;
      const [a, b] = [...activePointers.values()];
      const mid = toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom, worldX: (mid.x - panX) / zoom, worldY: (mid.y - panY) / zoom };
    }
  }

  function onCanvasPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2 && pinchStart) {
      const [a, b] = [...activePointers.values()];
      const mid = toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
      zoom = clampZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist));
      panX = mid.x - pinchStart.worldX * zoom;
      panY = mid.y - pinchStart.worldY * zoom;
      applyTransform();
    } else if (panPointerId === e.pointerId) {
      panX = panStart.panX + (e.clientX - panStart.x);
      panY = panStart.panY + (e.clientY - panStart.y);
      applyTransform();
    }
  }

  function onCanvasPointerUp(e) {
    activePointers.delete(e.pointerId);
    pinchStart = null;
    if (activePointers.size === 0) {
      document.removeEventListener('pointermove', onCanvasPointerMove);
      document.removeEventListener('pointerup', onCanvasPointerUp);
      document.removeEventListener('pointercancel', onCanvasPointerUp);
      panPointerId = null;
    } else if (activePointers.size === 1) {
      const [[id, pt]] = activePointers.entries();
      panPointerId = id;
      panStart = { x: pt.x, y: pt.y, panX, panY };
    }
  }

  function applyTransform() {
    worldEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  // zooms out if needed (never below 50%, never in) and pans so every note
  // is in view, or starts at the top-left if they still don't fit
  function centerView() {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width) return;
    if (entries.size === 0) {
      zoom = 1;
      panX = panY = 0;
      applyTransform();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    entries.forEach(entry => {
      minX = Math.min(minX, entry.cached.x);
      minY = Math.min(minY, entry.cached.y);
      maxX = Math.max(maxX, entry.cached.x + entry.div.offsetWidth);
      maxY = Math.max(maxY, entry.cached.y + entry.div.offsetHeight);
    });
    const MARGIN = 40;
    const fit = Math.min((rect.width - 2 * MARGIN) / (maxX - minX), (rect.height - 2 * MARGIN) / (maxY - minY));
    zoom = clampZoom(Math.max(0.5, Math.min(1, fit)));
    const w = (maxX - minX) * zoom;
    const h = (maxY - minY) * zoom;
    panX = w + 2 * MARGIN < rect.width ? (rect.width - w) / 2 - minX * zoom : MARGIN - minX * zoom;
    panY = h + 2 * MARGIN < rect.height ? (rect.height - h) / 2 - minY * zoom : MARGIN - minY * zoom;
    applyTransform();
  }

  // --- render: one card per note, only touching what changed ---

  function render() {
    const notes = Store.getBoardNodes(BOARD);
    const ids = new Set(notes.map(n => n.id));
    entries.forEach((entry, id) => { if (!ids.has(id)) removeEntry(id); });
    notes.forEach(note => {
      const entry = entries.get(note.id);
      if (entry) updateEntry(entry, note);
      else createEntry(note);
    });
    const hasCampaign = !!Store.getCurrentCampaignId();
    emptyEl.hidden = notes.length > 0;
    emptyEl.textContent = hasCampaign
      ? 'No notes yet.' + (AppMode.isEditMode() ? ' Tap "+ New note" to add one.' : '')
      : 'Create or pick a campaign first.';
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function createEntry(note) {
    const div = el('div', 'board-card');
    const head = el('div', 'board-card-head');
    const caret = el('span', 'board-card-caret', '▸');
    const titleEl = el('span', 'board-card-title');
    const titleInput = el('input', 'board-card-title-input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Title';
    const editBtn = el('button', 'btn-icon board-card-edit', '✎');
    editBtn.title = 'Edit';
    const delBtn = el('button', 'btn-icon btn-danger board-card-del', '✕');
    delBtn.title = 'Delete';
    head.append(caret, titleEl, titleInput, editBtn, delBtn);

    const body = el('div', 'board-card-body');
    const textEl = el('div', 'board-card-text notes-preview');
    const textarea = el('textarea', 'board-card-textarea');
    textarea.placeholder = 'Description - **bold text** for bold, links are detected automatically';
    textarea.rows = 6;
    const actions = el('div', 'board-card-actions');
    const doneBtn = el('button', 'btn btn-primary', 'Done');
    actions.appendChild(doneBtn);
    body.append(textEl, textarea, actions);
    div.append(head, body);

    const entry = { div, titleEl, titleInput, textEl, textarea, cached: note, editing: false };
    div.style.zIndex = ++topZ;

    // buttons: no drag or fold from pressing them
    [editBtn, delBtn, doneBtn].forEach(b => b.addEventListener('pointerdown', e => e.stopPropagation()));
    editBtn.addEventListener('click', () => startEditing(entry));
    delBtn.addEventListener('click', () => {
      if (confirm(`Delete the note "${entry.cached.name}"?`)) Store.deleteNode(entry.cached.id);
    });
    doneBtn.addEventListener('click', () => finishEditing(entry));

    // leaving the card while editing (tapping the board, another card, a
    // tab, ...) saves the edit
    div.addEventListener('focusout', e => {
      if (entry.editing && !div.contains(e.relatedTarget)) finishEditing(entry);
    });
    div.addEventListener('keydown', e => {
      if (!entry.editing) return;
      if (e.key === 'Escape' || (e.key === 'Enter' && e.target === titleInput)) {
        e.preventDefault();
        if (e.key === 'Enter') textarea.focus();
        else finishEditing(entry);
      }
    });

    // a press anywhere brings the card to the front; the body can scroll a
    // long description without panning the board
    div.addEventListener('pointerdown', () => { div.style.zIndex = ++topZ; }, true);
    body.addEventListener('pointerdown', e => e.stopPropagation());
    makeHeadInteractive(entry, head);

    worldEl.appendChild(div);
    entries.set(note.id, entry);
    updateEntry(entry, note, true);
    return entry;
  }

  function updateEntry(entry, note, force = false) {
    const prev = entry.cached;
    entry.cached = note;
    const div = entry.div;
    if (force || prev.x !== note.x || prev.y !== note.y) {
      div.style.left = note.x + 'px';
      div.style.top = note.y + 'px';
    }
    const open = openIds.has(note.id);
    div.classList.toggle('open', open);
    div.classList.toggle('editing', entry.editing);
    div.classList.toggle('has-text', !!note.notes);
    div.querySelector('.board-card-caret').textContent = open ? '▾' : '▸';
    // a card being edited keeps what's typed, even if the note changes meanwhile
    if (entry.editing) return;
    if (force || prev.name !== note.name) entry.titleEl.textContent = note.name;
    if (force || prev.notes !== note.notes) {
      entry.textEl.innerHTML = note.notes ? NotesEditor.renderNotes(note.notes) : '';
    }
  }

  function removeEntry(id) {
    const entry = entries.get(id);
    if (entry) entry.div.remove();
    entries.delete(id);
  }

  // --- folding out, editing, moving ---

  function setOpen(entry, open) {
    if (open) openIds.add(entry.cached.id);
    else openIds.delete(entry.cached.id);
    saveOpen();
    updateEntry(entry, entry.cached);
  }

  function startEditing(entry, { isNew = false } = {}) {
    if (!AppMode.isEditMode()) return;
    if (!openIds.has(entry.cached.id)) setOpen(entry, true);
    entry.editing = true;
    entry.titleInput.value = entry.cached.name;
    entry.textarea.value = entry.cached.notes || '';
    updateEntry(entry, entry.cached);
    entry.div.style.zIndex = ++topZ;
    if (isNew) {
      entry.titleInput.focus();
      entry.titleInput.select();
    } else if (window.matchMedia('(pointer: fine)').matches) {
      // with a mouse, straight into the description; on a tablet only
      // when tapped, so the keyboard doesn't cover the card right away
      entry.textarea.focus();
    }
  }

  function finishEditing(entry) {
    if (!entry.editing) return;
    entry.editing = false;
    const id = entry.cached.id;
    Store.updateNode(id, { name: entry.titleInput.value, notes: entry.textarea.value });
    // show the saved text (also when nothing changed, so no render happened)
    updateEntry(entry, Store.getBoardNodes(BOARD).find(n => n.id === id) || entry.cached, true);
  }

  // the title bar: a tap folds the card out/in, a drag moves it (edit mode)
  function makeHeadInteractive(entry, head) {
    head.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return;
      if (e.target.closest('input')) { e.stopPropagation(); return; } // typing in the title
      e.stopPropagation(); // not a pan of the board
      const canMove = AppMode.isEditMode() && !entry.editing;
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = entry.cached.x;
      const startTop = entry.cached.y;
      let moved = false;
      let rafId = null;
      let pending = null;

      function applyMove(ev) {
        if (!moved && (Math.abs(ev.clientX - startX) > MOVE_THRESHOLD || Math.abs(ev.clientY - startY) > MOVE_THRESHOLD)) {
          moved = true;
          if (canMove) entry.div.classList.add('dragging-node');
        }
        if (!moved || !canMove) return;
        const x = Math.max(0, startLeft + (ev.clientX - startX) / zoom);
        const y = Math.max(0, startTop + (ev.clientY - startY) / zoom);
        entry.div.style.left = x + 'px';
        entry.div.style.top = y + 'px';
        entry.cached = { ...entry.cached, x, y }; // in memory only until released
      }
      function onMove(ev) {
        ev.preventDefault();
        pending = ev;
        if (rafId == null) rafId = requestAnimationFrame(() => { rafId = null; applyMove(pending); });
      }
      function finish(ev) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        applyMove(ev);
        entry.div.classList.remove('dragging-node');
        if (moved && canMove) {
          Store.moveNodePosition(entry.cached.id, Math.round(entry.cached.x), Math.round(entry.cached.y));
        } else if (!moved && !entry.editing && ev.type === 'pointerup') {
          setOpen(entry, !openIds.has(entry.cached.id));
        }
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  // "+ New note": in the middle of what's in view (a bit up, so the open
  // card fits below), nudged down-right while it would cover another card
  function addNote() {
    if (!AppMode.isEditMode()) return;
    const rect = canvasEl.getBoundingClientRect();
    let x = (rect.width / 2 - panX) / zoom - 120;
    let y = (rect.height / 3 - panY) / zoom - 20;
    const taken = () => Store.getBoardNodes(BOARD).some(n => Math.abs(n.x - x) < 30 && Math.abs(n.y - y) < 30);
    for (let i = 0; i < 50 && taken(); i++) { x += 30; y += 30; }
    const note = Store.addBoardNode(BOARD, 'New note', x, y);
    if (!note) return;
    render(); // normally done by app.js's Store subscription already
    const entry = entries.get(note.id);
    if (entry) startEditing(entry, { isNew: true });
  }

  return { init, show, render };
})();
