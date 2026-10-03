// map-view.js
// The Map tab: the map picture, with pins on it. Each pin stands for a
// location from the Locations tab; tapping it opens that location's
// mindmap (onOpenLocation, handled by app.js).
//
// - The picture is a fixed file in the app folder, maps/map.jpg, linked
//   from index.html (<img id="map-image">). So it's not in the campaign's
//   data (it costs nothing of localStorage's ~5 MB), the service worker
//   (sw.js) keeps it for offline use like the rest of the app, and every
//   campaign and device uses the same map. To change the map, replace the
//   file and bump its ?v=N in index.html (see README.md).
// - A pin is LOCKED once it has a location: it can't be moved, changed or
//   deleted by accident, and tapping it opens the location. In edit mode,
//   🔒 unlocks it - then it can be dragged by its dot, given another
//   location (which locks it again), or deleted (✕, with Undo). A new pin
//   starts unlocked, without a location. Pins belong to the campaign.
// - Pin positions are stored in 1/10000ths of the picture's width/height,
//   so replacing the picture with another version of the same map keeps
//   the pins in place.
// - Panning and zooming work like the mindmap: one finger/mouse on the
//   map pans, two fingers zoom around the point between them, the mouse
//   wheel zooms around the cursor. The pins aren't scaled with the
//   picture: they're laid over it (outside the zoom transform) and only
//   their positions follow it, so they stay readable at any zoom.

const MapView = (() => {
  const PIN_BOARD = 'pins';
  const SCALE = 10000; // pin x/y units per picture width/height
  const TOP = 64; // room for the bar at the top

  let canvasEl, worldEl, imgEl, pinsEl, emptyEl, barEl, pinBtn;
  let callbacks = null;
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let fitZoom = 1;
  let imgW = 0; // the picture's size in pixels (0 = not loaded (yet))
  let imgH = 0;
  let imageFailed = false;
  let fitted = false; // fitted to the screen once; after that, tab switches keep where you were
  const unlocked = new Set(); // ids of pins unlocked for editing

  const activePointers = new Map();
  let panPointerId = null;
  let panStart = null;
  let pinchStart = null;

  function init(container, navCallbacks) {
    callbacks = navCallbacks;
    canvasEl = container.querySelector('#map-canvas');
    worldEl = container.querySelector('#map-world');
    imgEl = container.querySelector('#map-image');
    pinsEl = container.querySelector('#map-pins');
    emptyEl = container.querySelector('#map-empty');
    barEl = container.querySelector('#map-bar');
    pinBtn = container.querySelector('#map-pin-btn');

    pinBtn.addEventListener('click', addPin);

    // the picture starts loading with the page, so it may be done already
    const onLoad = () => {
      imgW = imgEl.naturalWidth;
      imgH = imgEl.naturalHeight;
      fitIfNeeded();
      render();
    };
    if (imgEl.complete && imgEl.naturalWidth) onLoad();
    else {
      imgEl.addEventListener('load', onLoad);
      imgEl.addEventListener('error', () => { imageFailed = true; render(); });
    }

    canvasEl.addEventListener('wheel', e => {
      e.preventDefault();
      const p = toCanvas(e.clientX, e.clientY);
      const worldX = (p.x - panX) / zoom;
      const worldY = (p.y - panY) / zoom;
      zoom = clampZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
      panX = p.x - worldX * zoom;
      panY = p.y - worldY * zoom;
      applyTransform();
    }, { passive: false });
    canvasEl.addEventListener('pointerdown', onCanvasPointerDown);

    AppMode.subscribe(editMode => {
      if (!editMode) unlocked.clear();
      render();
    });
  }

  // called by app.js once the tab is visible (so the map can be fitted)
  function show() {
    render();
    fitIfNeeded();
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function render() {
    const campaignId = Store.getCurrentCampaignId();
    barEl.hidden = !campaignId || !imgW || !AppMode.isEditMode();
    emptyEl.hidden = !imageFailed;
    emptyEl.textContent = 'The map picture (maps/map.jpg) could not be loaded.';
    renderPins();
  }

  // zooms so the whole picture fits, centered - once, so switching tabs
  // keeps where you were
  function fitIfNeeded() {
    const rect = canvasEl.getBoundingClientRect();
    if (!imgW || !rect.width) return;
    if (fitted) { applyTransform(); return; }
    fitted = true;
    const MARGIN = 16;
    fitZoom = Math.min((rect.width - 2 * MARGIN) / imgW, (rect.height - TOP - MARGIN) / imgH);
    zoom = fitZoom;
    panX = (rect.width - imgW * zoom) / 2;
    panY = TOP + (rect.height - TOP - imgH * zoom) / 2;
    applyTransform();
  }

  function clampZoom(z) {
    return Math.min(Math.max(4, fitZoom * 2), Math.max(fitZoom * 0.5, z));
  }

  function applyTransform() {
    worldEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    positionPins();
  }

  // --- pins ---

  function renderPins() {
    pinsEl.innerHTML = '';
    if (!imgW || !Store.getCurrentCampaignId()) return;
    const edit = AppMode.isEditMode();
    const locations = Store.getLocationTree();
    const byId = new Map(locations.map(l => [l.id, l]));

    Store.getBoardNodes(PIN_BOARD).forEach(pin => {
      const location = byId.get(pin.locationId);
      if (!edit && !location) return; // nothing to open
      const editing = edit && (!location || unlocked.has(pin.id));
      const pinEl = el('div', 'map-pin' + (editing ? ' editing' : '') + (location ? '' : ' missing'));
      pinEl._pin = pin;
      pinEl.addEventListener('pointerdown', e => e.stopPropagation()); // no panning from a pin

      const dot = el('div', 'map-pin-dot');
      pinEl.appendChild(dot);
      const box = el('div', 'map-pin-box');
      pinEl.appendChild(box);

      if (!editing) {
        const label = el('button', 'map-pin-label', location.name);
        label.title = location.path;
        label.addEventListener('click', () => callbacks.onOpenLocation(location.id));
        dot.addEventListener('click', () => callbacks.onOpenLocation(location.id));
        box.appendChild(label);
        if (edit) {
          const unlockBtn = el('button', 'map-pin-btn', '🔒');
          unlockBtn.title = 'Unlock, to move this pin or change its location';
          unlockBtn.addEventListener('click', () => { unlocked.add(pin.id); renderPins(); });
          box.appendChild(unlockBtn);
        }
      } else {
        const select = el('select', 'map-pin-select');
        const none = el('option', '', 'Pick a location…');
        none.value = '';
        select.appendChild(none);
        locations.forEach(l => {
          const option = el('option', '', '   '.repeat(l.depth) + l.name);
          option.value = l.id;
          select.appendChild(option);
        });
        select.value = location ? location.id : '';
        // picking a location locks the pin
        select.addEventListener('change', () => {
          const picked = byId.get(select.value);
          if (!picked) return;
          unlocked.delete(pin.id);
          if (picked.id === pin.locationId) renderPins();
          else Store.updateNode(pin.id, { locationId: picked.id, name: picked.name });
        });
        box.appendChild(select);
        if (location) {
          const lockBtn = el('button', 'map-pin-btn', '🔓');
          lockBtn.title = 'Lock this pin again';
          lockBtn.addEventListener('click', () => { unlocked.delete(pin.id); renderPins(); });
          box.appendChild(lockBtn);
        }
        const delBtn = el('button', 'map-pin-btn map-pin-del', '✕');
        delBtn.title = 'Delete this pin';
        delBtn.addEventListener('click', () => { unlocked.delete(pin.id); Store.deleteNode(pin.id); });
        box.appendChild(delBtn);
        dot.title = 'Drag to move';
        makeDraggable(pinEl, dot);
      }
      pinsEl.appendChild(pinEl);
    });
    positionPins();
  }

  function positionPins() {
    if (!imgW) return;
    [...pinsEl.children].forEach(pinEl => {
      const pin = pinEl._pin;
      pinEl.style.left = (panX + pin.x / SCALE * imgW * zoom) + 'px';
      pinEl.style.top = (panY + pin.y / SCALE * imgH * zoom) + 'px';
    });
  }

  // screen point -> pin units, kept on the picture
  function toPinUnits(clientX, clientY) {
    const p = toCanvas(clientX, clientY);
    const x = Math.min(imgW, Math.max(0, (p.x - panX) / zoom));
    const y = Math.min(imgH, Math.max(0, (p.y - panY) / zoom));
    return { x: Math.round(x / imgW * SCALE), y: Math.round(y / imgH * SCALE) };
  }

  // an unlocked pin is dragged by its dot; saved once released
  function makeDraggable(pinEl, handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      const pin = pinEl._pin;
      pinEl.classList.add('dragging');
      let moved = false;

      function onMove(ev) {
        moved = true;
        Object.assign(pin, toPinUnits(ev.clientX, ev.clientY));
        positionPins();
      }
      function finish() {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        pinEl.classList.remove('dragging');
        if (moved) Store.updateNode(pin.id, { x: pin.x, y: pin.y });
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  // a new pin in the middle of the screen, unlocked, waiting for a location
  function addPin() {
    if (!AppMode.isEditMode() || !imgW) return;
    const rect = canvasEl.getBoundingClientRect();
    const spot = toPinUnits(rect.left + rect.width / 2, rect.top + TOP + (rect.height - TOP) / 2);
    Store.addBoardNode(PIN_BOARD, 'Pin', spot.x, spot.y, { locationId: '' });
  }

  // --- panning (1 finger/mouse) and pinch-zoom (2 fingers) ---

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function toCanvas(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function midpoint(a, b) {
    return toCanvas((a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  function onCanvasPointerDown(e) {
    if (e.target !== canvasEl && e.target !== worldEl && e.target !== pinsEl) return;
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
      const mid = midpoint(a, b);
      pinchStart = { dist: pointDistance(a, b), zoom, worldX: (mid.x - panX) / zoom, worldY: (mid.y - panY) / zoom };
    }
  }

  function onCanvasPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2 && pinchStart) {
      const [a, b] = [...activePointers.values()];
      const mid = midpoint(a, b);
      zoom = clampZoom(pinchStart.zoom * (pointDistance(a, b) / pinchStart.dist));
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

  return { init, show, render };
})();
