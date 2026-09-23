// app-mode.js
// Shared state for whether the app is in "edit" or "view" mode. In view
// mode everything destructive/editable is turned off (add, rename, delete,
// move/drag), so you can safely browse the notes without changing
// anything by accident - e.g. while running a session. Expand/collapse,
// zoom and panning aren't destructive and work in both modes.

const AppMode = (() => {
  const STORAGE_KEY = 'rpg-notes-edit-mode';
  let editMode = localStorage.getItem(STORAGE_KEY) !== 'false'; // edit is the default
  const listeners = [];

  function isEditMode() {
    return editMode;
  }

  function setEditMode(value) {
    editMode = value;
    localStorage.setItem(STORAGE_KEY, String(editMode));
    listeners.forEach(fn => fn(editMode));
  }

  function toggle() {
    setEditMode(!editMode);
  }

  function subscribe(fn) {
    listeners.push(fn);
  }

  return { isEditMode, setEditMode, toggle, subscribe };
})();
