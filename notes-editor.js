// notes-editor.js
// Plain-text notes panel for a single node, with a tiny markdown-like
// syntax: **bold text** renders as bold, and any http(s)/www URL typed in
// the text is automatically turned into a link that opens in a new tab.
// No toolbar or rich-text editing - you just type. Shared by both views:
// tree-view.js and mindmap-view.js each add a notes button that calls
// NotesEditor.open(nodeId).
//
// Safety note: the raw text is stored as-is (see Store.updateNodeNotes).
// Turning it into HTML always escapes the text FIRST and only then
// re-introduces the two safe patterns below (**bold** and auto-links), so
// there's no way for typed or imported text to inject arbitrary markup.

const NotesEditor = (() => {
  const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<]+)/gi;

  let overlayEl, panelEl, titleEl, hintEl, textareaEl, previewLabelEl, previewEl, closeBtn;
  let currentId = null;
  let isDirty = false;
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

    hintEl = document.createElement('div');
    hintEl.className = 'notes-hint';
    hintEl.textContent = 'Tip: **bold text** for bold - links are detected automatically.';

    textareaEl = document.createElement('textarea');
    textareaEl.className = 'notes-textarea';
    textareaEl.addEventListener('input', () => {
      isDirty = true;
      updatePreview();
    });

    previewLabelEl = document.createElement('div');
    previewLabelEl.className = 'notes-preview-label';
    previewLabelEl.textContent = 'Preview';

    previewEl = document.createElement('div');
    previewEl.className = 'notes-preview';

    panelEl.append(header, hintEl, textareaEl, previewLabelEl, previewEl);
    overlayEl.appendChild(panelEl);
    document.body.appendChild(overlayEl);

    AppMode.subscribe(applyMode);
  }

  function applyMode() {
    const editable = AppMode.isEditMode();
    textareaEl.hidden = !editable;
    hintEl.hidden = !editable;
    previewLabelEl.hidden = !editable;
    previewEl.classList.toggle('notes-preview-full', !editable);
    updatePreview();
  }

  function updatePreview() {
    const raw = textareaEl.value.trim();
    previewEl.innerHTML = raw ? renderNotes(textareaEl.value) : '';
  }

  function open(nodeId) {
    build();
    // switching straight to a different node without closing first: still
    // offer to save whatever was pending on the previous one
    try {
      maybeSaveBeforeLeaving();
    } finally {
      isDirty = false;
    }
    currentId = nodeId;
    const node = Store.getById(nodeId);
    if (!node) return;
    titleEl.textContent = node.name;
    textareaEl.value = node.notes || '';
    applyMode();
    overlayEl.hidden = false;
    if (AppMode.isEditMode()) textareaEl.focus();
  }

  function close() {
    // the panel must always end up hidden, even if saving throws for some
    // reason - closing should never get "stuck" behind a failed save
    try {
      maybeSaveBeforeLeaving();
    } finally {
      overlayEl.hidden = true;
      currentId = null;
      isDirty = false;
    }
  }

  function maybeSaveBeforeLeaving() {
    if (!isDirty || !currentId || !AppMode.isEditMode()) return;
    if (confirm('Save changes to this note?')) {
      Store.updateNodeNotes(currentId, textareaEl.value);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // turns raw text into safe display HTML: escapes everything first, then
  // re-introduces only **bold** and auto-detected links
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

  return { open };
})();
