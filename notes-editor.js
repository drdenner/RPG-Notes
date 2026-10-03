// notes-editor.js
// The single panel for a location: renaming it and writing its notes both
// happen here. The list and the mindmap open it by clicking/tapping the
// location itself - there's no separate rename or notes button.
//
// Below the notes, the panel lists the NPCs at the location (name and
// description). In edit mode, NPCs are added there - an existing one
// (moved here from wherever it was) or a new one - and removed again
// (✕, which leaves the NPC without a location; it's deleted on the NPCs
// tab). NPC changes are saved right away, not with the Save button.
//
// Notes are plain text with a tiny markdown-like syntax: **bold text**
// renders as bold, and any http(s)/www URL typed in the text is
// automatically turned into a link that opens in a new tab. No toolbar or
// rich-text editing needed - you just type.
//
// Explicit Save button - nothing is written to the Store until you click
// it. Closing (✕, a tap outside the panel, or Escape) with unsaved changes
// shows a small bar in the panel instead (Save / Discard / Keep editing) -
// a stray tap outside the panel on a tablet shouldn't silently throw away
// what you typed. (A bar rather than confirm() dialogs, since a
// three-way choice doesn't fit OK/Cancel.)
//
// Opening an existing node doesn't focus anything, so a tablet's keyboard
// doesn't pop up when you only want to read. A just-created node ({ isNew })
// gets its placeholder name selected, so typing replaces it.
//
// Safety note: the raw text is stored as-is (see Store.updateNode).
// Turning it into HTML always escapes the text FIRST and only then
// re-introduces the two safe patterns below (**bold** and auto-links), so
// there's no way for typed or imported text to inject arbitrary markup.

const NotesEditor = (() => {
  // runs on already-escaped text, so '<' only ever appears as the start of
  // a tag we added ourselves; raw quotes are excluded as a second safeguard
  const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

  let overlayEl, panelEl, titleInputEl, hintEl, textareaEl, previewLabelEl, previewEl, saveBtn, closeBtn;
  let unsavedBarEl, unsavedSaveBtn;
  let npcSectionEl, npcListEl, npcAddEl;
  let currentId = null;
  let savedName = '';  // what the fields held when opened / last saved,
  let savedNotes = ''; // used to detect unsaved changes
  let built = false;

  function build() {
    if (built) return;
    built = true;

    overlayEl = document.createElement('div');
    overlayEl.className = 'notes-overlay';
    overlayEl.addEventListener('mousedown', e => {
      if (e.target === overlayEl) requestClose();
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !overlayEl.classList.contains('open')) return;
      // Escape while the unsaved-changes bar is showing = keep editing
      if (!unsavedBarEl.hidden) hideUnsavedBar();
      else requestClose();
    });

    panelEl = document.createElement('div');
    panelEl.className = 'notes-panel';

    const header = document.createElement('div');
    header.className = 'notes-header';

    titleInputEl = document.createElement('input');
    titleInputEl.type = 'text';
    titleInputEl.className = 'notes-title-input';

    const headerActions = document.createElement('div');
    headerActions.className = 'notes-header-actions';

    saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary notes-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', save);

    closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', requestClose);

    headerActions.append(saveBtn, closeBtn);
    header.append(titleInputEl, headerActions);

    // shown by requestClose() when there are unsaved changes
    unsavedBarEl = document.createElement('div');
    unsavedBarEl.className = 'notes-unsaved-bar';
    unsavedBarEl.hidden = true;

    const unsavedMsg = document.createElement('span');
    unsavedMsg.className = 'notes-unsaved-msg';
    unsavedMsg.textContent = 'You have unsaved changes.';

    unsavedSaveBtn = document.createElement('button');
    unsavedSaveBtn.className = 'btn btn-primary';
    unsavedSaveBtn.textContent = 'Save';
    unsavedSaveBtn.addEventListener('click', () => { save(); close(); });

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn';
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', close);

    const keepEditingBtn = document.createElement('button');
    keepEditingBtn.className = 'btn';
    keepEditingBtn.textContent = 'Keep editing';
    keepEditingBtn.addEventListener('click', hideUnsavedBar);

    unsavedBarEl.append(unsavedMsg, unsavedSaveBtn, discardBtn, keepEditingBtn);

    hintEl = document.createElement('div');
    hintEl.className = 'notes-hint';
    hintEl.textContent = 'Tip: **bold text** for bold - links are detected automatically.';

    textareaEl = document.createElement('textarea');
    textareaEl.className = 'notes-textarea';
    textareaEl.addEventListener('input', updatePreview);

    previewLabelEl = document.createElement('div');
    previewLabelEl.className = 'notes-preview-label';
    previewLabelEl.textContent = 'Preview';

    previewEl = document.createElement('div');
    previewEl.className = 'notes-preview';

    npcSectionEl = document.createElement('div');
    npcSectionEl.className = 'notes-npcs';
    const npcLabel = document.createElement('div');
    npcLabel.className = 'notes-preview-label notes-npcs-label';
    npcLabel.textContent = 'NPCs here';
    npcListEl = document.createElement('ul');
    npcListEl.className = 'notes-npc-list';
    npcAddEl = document.createElement('select');
    npcAddEl.className = 'npc-input notes-npc-add';
    npcAddEl.addEventListener('change', addNpc);
    npcSectionEl.append(npcLabel, npcListEl, npcAddEl);

    panelEl.append(header, unsavedBarEl, hintEl, textareaEl, previewLabelEl, previewEl, npcSectionEl);
    overlayEl.appendChild(panelEl);
    document.body.appendChild(overlayEl);

    AppMode.subscribe(applyMode);
    Store.subscribe(() => { if (currentId) renderNpcs(); });
  }

  function applyMode() {
    const editable = AppMode.isEditMode();
    titleInputEl.readOnly = !editable;
    textareaEl.hidden = !editable;
    hintEl.hidden = !editable;
    previewLabelEl.hidden = !editable;
    saveBtn.hidden = !editable;
    previewEl.classList.toggle('notes-preview-full', !editable);
    updatePreview();
    renderNpcs();
  }

  // --- the NPCs at this location ---

  const NEW_NPC = '__new__';

  function renderNpcs() {
    if (!currentId) return;
    const editable = AppMode.isEditMode();
    const npcs = Store.getBoardNodes('npcs').sort((a, b) => a.name.localeCompare(b.name));
    const here = npcs.filter(npc => npc.locationId === currentId);
    const paths = new Map(Store.getLocationTree().map(l => [l.id, l.path]));

    npcListEl.innerHTML = '';
    if (!here.length) {
      const empty = document.createElement('li');
      empty.className = 'notes-npc-empty';
      empty.textContent = 'No NPCs here.';
      npcListEl.appendChild(empty);
    }
    here.forEach(npc => {
      const item = document.createElement('li');
      item.className = 'notes-npc';
      const head = document.createElement('div');
      head.className = 'notes-npc-head';
      const name = document.createElement('strong');
      name.textContent = npc.name;
      head.appendChild(name);
      if (editable) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-icon btn-danger';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove from this location (the NPC is kept)';
        removeBtn.addEventListener('click', () => Store.updateNode(npc.id, { locationId: '' }));
        head.appendChild(removeBtn);
      }
      const description = document.createElement('div');
      description.className = 'notes-npc-text';
      description.innerHTML = npc.notes ? renderNotes(npc.notes) : '<i>No description.</i>';
      item.append(head, description);
      npcListEl.appendChild(item);
    });

    npcAddEl.hidden = !editable;
    npcAddEl.innerHTML = '';
    const option = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    };
    npcAddEl.append(option('', '👤 Add an NPC here…'), option(NEW_NPC, '+ New NPC…'));
    npcs.filter(npc => npc.locationId !== currentId).forEach(npc => {
      const where = paths.get(npc.locationId);
      npcAddEl.appendChild(option(npc.id, npc.name + (where ? ` (now: ${where})` : ' (traveling)')));
    });
    npcAddEl.value = '';
  }

  function addNpc() {
    const value = npcAddEl.value;
    npcAddEl.value = '';
    if (!value || !currentId || !AppMode.isEditMode()) return;
    if (value === NEW_NPC) {
      const name = (prompt('Name of the new NPC:') || '').trim();
      if (name) Store.addBoardNode('npcs', name, 0, 0, { locationId: currentId });
    } else {
      Store.updateNode(value, { locationId: currentId });
    }
  }

  function updatePreview() {
    const raw = textareaEl.value.trim();
    previewEl.innerHTML = raw ? renderNotes(textareaEl.value) : '';
  }

  // showNpcs: scroll to the NPCs (the list's 👤+ and NPC names)
  function open(nodeId, { isNew = false, showNpcs = false } = {}) {
    build();
    const node = Store.getById(nodeId);
    if (!node) return;
    currentId = nodeId;
    titleInputEl.value = savedName = node.name;
    textareaEl.value = savedNotes = node.notes || '';
    applyMode();
    overlayEl.classList.add('open');
    if (showNpcs) npcSectionEl.scrollIntoView({ block: 'nearest' });
    if (isNew && AppMode.isEditMode()) {
      titleInputEl.focus();
      titleInputEl.select();
    }
  }

  function save() {
    if (!currentId) return;
    Store.updateNode(currentId, { name: titleInputEl.value, notes: textareaEl.value });
    const node = Store.getById(currentId);
    if (node) {
      // the Store may have normalized the name (trimmed, or kept the old
      // one if left empty) - show that, so it doesn't count as unsaved
      titleInputEl.value = savedName = node.name;
      savedNotes = node.notes;
    }
    saveBtn.textContent = 'Saved ✓';
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }, 900);
  }

  function hasUnsavedChanges() {
    return AppMode.isEditMode() && !!currentId &&
      (titleInputEl.value !== savedName || textareaEl.value !== savedNotes);
  }

  // closes right away if nothing changed; otherwise shows the unsaved-
  // changes bar and lets its buttons decide - so throwing away changes
  // always takes a deliberate click on Discard
  function requestClose() {
    if (hasUnsavedChanges()) {
      unsavedBarEl.hidden = false;
      unsavedSaveBtn.focus();
      return;
    }
    close();
  }

  function hideUnsavedBar() {
    unsavedBarEl.hidden = true;
  }

  // just hides the panel - no saving, nothing that could fail and leave
  // the panel stuck open
  function close() {
    // drop focus, or the title field would keep it while hidden and bring
    // a tablet's keyboard back the next time the panel opens
    if (panelEl.contains(document.activeElement)) document.activeElement.blur();
    hideUnsavedBar();
    overlayEl.classList.remove('open');
    currentId = null;
  }

  // escapes quotes too (textContent/innerHTML doesn't), since the result
  // also ends up inside an href="..." attribute below
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // turns raw text into safe display HTML: escapes everything first, then
  // re-introduces only **bold** and auto-detected links. Bold runs before
  // links on purpose: URL_PATTERN stops at '<', so a link can never swallow
  // (or end up inside) a <b> tag, and after escaping the only quotes left
  // are entities, so nothing can break out of the href attribute.
  function renderNotes(text) {
    let html = escapeHtml(text || '');
    html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    html = html.replace(URL_PATTERN, url => {
      const href = url.startsWith('www.') ? 'https://' + url : url;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  // renderNotes is also used by the NPCs and Players tabs
  return { open, renderNotes };
})();
