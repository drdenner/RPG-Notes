// notes-editor.js
// Rich-text notes panel for a single node. Supports bold text and links
// (which always open in a new tab), built with a plain contentEditable
// area + document.execCommand - no external library needed. Shared by
// both views: tree-view.js and mindmap-view.js each add a "notes" button
// that calls NotesEditor.open(nodeId).
//
// The panel stays readable-but-not-editable in view mode (see app-mode.js)
// so notes can always be read, just not changed accidentally.

const NotesEditor = (() => {
  const SAVE_DEBOUNCE_MS = 600;

  let overlayEl, panelEl, titleEl, toolbarEl, contentEl, boldBtn, linkBtn, closeBtn;
  let currentId = null;
  let saveTimer = null;
  let built = false;

  function build() {
    if (built) return;
    built = true;

    overlayEl = document.createElement('div');
    overlayEl.className = 'notes-overlay';
    overlayEl.hidden = true;
    overlayEl.addEventListener('mousedown', e => {
      if (e.target === overlayEl) close();
    });

    panelEl = document.createElement('div');
    panelEl.className = 'notes-panel';

    const header = document.createElement('div');
    header.className = 'notes-header';
    titleEl = document.createElement('span');
    titleEl.className = 'notes-title';
    closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', close);
    header.append(titleEl, closeBtn);

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'notes-toolbar';

    boldBtn = document.createElement('button');
    boldBtn.className = 'notes-tool-btn';
    boldBtn.innerHTML = '<b>B</b>';
    boldBtn.title = 'Bold';
    // keep the current text selection alive through the button click
    boldBtn.addEventListener('mousedown', e => e.preventDefault());
    boldBtn.addEventListener('click', () => {
      document.execCommand('bold');
      contentEl.focus();
      scheduleSave();
    });

    linkBtn = document.createElement('button');
    linkBtn.className = 'notes-tool-btn';
    linkBtn.textContent = '🔗';
    linkBtn.title = 'Insert link';
    linkBtn.addEventListener('mousedown', e => e.preventDefault());
    linkBtn.addEventListener('click', () => {
      const url = prompt('Link URL:');
      if (!url) return;
      document.execCommand('createLink', false, url);
      contentEl.querySelectorAll('a').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      contentEl.focus();
      scheduleSave();
    });

    toolbarEl.append(boldBtn, linkBtn);

    contentEl = document.createElement('div');
    contentEl.className = 'notes-content';
    contentEl.addEventListener('input', scheduleSave);

    panelEl.append(header, toolbarEl, contentEl);
    overlayEl.appendChild(panelEl);
    document.body.appendChild(overlayEl);

    AppMode.subscribe(applyMode);
  }

  function applyMode() {
    const editable = AppMode.isEditMode();
    contentEl.contentEditable = editable ? 'true' : 'false';
    toolbarEl.style.display = editable ? 'flex' : 'none';
  }

  function open(nodeId) {
    build();
    flushSave(); // commit any pending edit on the previously open node first
    currentId = nodeId;
    const node = Store.getById(nodeId);
    if (!node) return;
    titleEl.textContent = node.name;
    contentEl.innerHTML = Store.sanitizeNotes(node.notes || '');
    applyMode();
    overlayEl.hidden = false;
    if (AppMode.isEditMode()) contentEl.focus();
  }

  function close() {
    flushSave();
    overlayEl.hidden = true;
    currentId = null;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!currentId || !AppMode.isEditMode()) return;
    Store.updateNodeNotes(currentId, contentEl.innerHTML);
  }

  return { open };
})();
