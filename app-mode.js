// app-mode.js
// Delt tilstand for om appen er i "redigér"- eller "vis"-tilstand.
// I vis-tilstand er alt destruktivt/redigerbart slået fra (tilføj, omdøb,
// slet, flyt/træk), så man trygt kan bladre i noterne uden at ændre noget
// ved et uheld - fx mens man kører en session. Fold ud/ind, zoom og
// panorering er ikke destruktivt og virker i begge tilstande.

const AppMode = (() => {
  const STORAGE_KEY = 'rpg-notes-edit-mode';
  let editMode = localStorage.getItem(STORAGE_KEY) !== 'false'; // redigér er default
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
