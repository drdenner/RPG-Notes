// notes-editor.js
// The single panel for a node: renaming it and writing its notes both
// happen here. Both views open it by clicking/tapping the node itself -
// there's no separate rename or notes button anymore.
//
// Notes are plain text with a tiny markdown-like syntax: **bold text**
// renders as bold, and any http(s)/www URL typed in the text is
// automatically turned into a link that opens in a new tab. No toolbar or
// rich-text editing needed - you just type.
//
// Explicit Save button - nothing is written to the Store until you click
// it. Close always just hides the panel, with no side effects, so it can
// never get stuck.
//
// Safety note: the raw text is stored as-is (see Store.updateNodeNotes).
// Turning it into HTML always escapes the text FIRST and only then
// re-introduces the two safe patterns below (**bold** and auto-links), so
// there's no way for typed or imported text to inject arbitrary markup.

const NotesEditor = (() => {
  // runs on already-escaped text, so '<' only ever appears as the start of
  // a tag we added ourselves; raw quotes are excluded as a second safeguard
  const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;

  let overlayEl, panelEl, titleInputEl, hintEl, textareaEl, previewLabelEl, previewEl, saveBtn, closeBtn;
  let currentId = null;
  let built = false;

  function build() {
    if (built) return;
    built = true;

    overlayEl = document.createElement('div');
    overlayEl.className = 'notes-overlay';
    overlayEl.addEventListener('mousedown', e => {
      if (e.target === overlayEl) close();
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
    closeBtn.addEventListener('click', close);

    headerActions.append(saveBtn, closeBtn);
    header.append(titleInputEl, headerActions);

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

    panelEl.append(header, hintEl, textareaEl, previewLabelEl, previewEl);
    overlayEl.appendChild(panelEl);
    document.body.appendChild(overlayEl);

    AppMode.subscribe(applyMode);
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
  }

  function updatePreview() {
    const raw = textareaEl.value.trim();
    previewEl.innerHTML = raw ? renderNotes(textareaEl.value) : '';
  }

  function open(nodeId) {
    build();
    currentId = nodeId;
    const node = Store.getById(nodeId);
    if (!node) return;
    titleInputEl.value = node.name;
    textareaEl.value = node.notes || '';
    applyMode();
    overlayEl.classList.add('open');
    if (AppMode.isEditMode()) titleInputEl.focus();
  }

  function save() {
    if (!currentId) return;
    Store.renameNode(currentId, titleInputEl.value);
    Store.updateNodeNotes(currentId, textareaEl.value);
    saveBtn.textContent = 'Saved ✓';
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = 'Save';
      saveBtn.disabled = false;
    }, 900);
  }

  // always just hides the panel - no saving, no confirmation, nothing that
  // could fail and leave the panel stuck open
  function close() {
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

  return { open };
})();
