// mindmap-view.js
// Mindmap view: nodes as freely placeable boxes on a "world" layer
// (mindmap-world), with SVG lines showing parent/child connections.
//
// - Panning/zoom work by transforming the whole world layer (translate+scale),
//   node positions (x,y) are always in "world" coordinates and unaffected by zoom.
// - While dragging, the DOM and lines are updated directly (no full re-render)
//   to avoid flicker; the Store is only updated once you release.
// - All input uses Pointer Events (not mouse events), so it behaves the
//   same with mouse, pen and touch/tablet. One-finger drag on empty canvas
//   pans, two-finger pinch zooms (plus the mouse wheel on desktop).
// - Tapping a node (no movement) opens it (NotesEditor - rename and notes
//   both live there); dragging it (movement past a small threshold) moves
//   it instead, and only works in edit mode.

const MindmapView = (() => {
  let canvasEl = null;
  let worldEl = null;
  let svgEl = null;
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // --- panning + pinch-zoom state (canvas-level, can have 1-2 concurrent pointers) ---
  const activePointers = new Map(); // pointerId -> {x,y}
  let panPointerId = null;
  let panStart = null;
  let pinchStartDist = null;
  let pinchStartZoom = null;

  function init(container) {
    canvasEl = container.querySelector('#mindmap-canvas');
    worldEl = container.querySelector('#mindmap-world');
    svgEl = container.querySelector('#mindmap-svg');

    container.querySelector('#mindmap-new-root-btn').addEventListener('click', () => {
      // place the new node roughly in the middle of the current viewport
      const rect = canvasEl.getBoundingClientRect();
      const worldX = Math.max(0, (rect.width / 2 - panX) / zoom - 60);
      const worldY = Math.max(0, (rect.height / 2 - panY) / zoom - 20);
      const node = Store.addNode('New root node', null);
      Store.moveNodePosition(node.id, worldX, worldY);
      NotesEditor.open(node.id);
    });

    // zoom with the mouse wheel (desktop)
    canvasEl.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      zoom = clampZoom(zoom * factor);
      applyTransform();
    }, { passive: false });

    canvasEl.addEventListener('pointerdown', onCanvasPointerDown);

    applyTransform();
  }

  function clampZoom(z) {
    return Math.min(2.5, Math.max(0.3, z));
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // --- panning (1 finger/mouse) and pinch-zoom (2 fingers) on empty canvas ---

  function onCanvasPointerDown(e) {
    if (e.target !== canvasEl && e.target !== worldEl) return; // only on empty canvas, not on a node
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      panPointerId = e.pointerId;
      panStart = { x: e.clientX, y: e.clientY, panX, panY };
      document.addEventListener('pointermove', onCanvasPointerMove);
      document.addEventListener('pointerup', onCanvasPointerUp);
      document.addEventListener('pointercancel', onCanvasPointerUp);
    } else if (activePointers.size === 2) {
      panPointerId = null;
      const pts = [...activePointers.values()];
      pinchStartDist = pointDistance(pts[0], pts[1]);
      pinchStartZoom = zoom;
    }
  }

  function onCanvasPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2 && pinchStartDist) {
      const pts = [...activePointers.values()];
      const dist = pointDistance(pts[0], pts[1]);
      zoom = clampZoom(pinchStartZoom * (dist / pinchStartDist));
      applyTransform();
    } else if (panPointerId === e.pointerId) {
      panX = panStart.panX + (e.clientX - panStart.x);
      panY = panStart.panY + (e.clientY - panStart.y);
      applyTransform();
    }
  }

  function onCanvasPointerUp(e) {
    activePointers.delete(e.pointerId);
    pinchStartDist = null;

    if (activePointers.size === 0) {
      document.removeEventListener('pointermove', onCanvasPointerMove);
      document.removeEventListener('pointerup', onCanvasPointerUp);
      document.removeEventListener('pointercancel', onCanvasPointerUp);
      panPointerId = null;
    } else if (activePointers.size === 1) {
      // keep panning with the remaining finger
      const [[id, pt]] = activePointers.entries();
      panPointerId = id;
      panStart = { x: pt.x, y: pt.y, panX, panY };
    }
  }

  function applyTransform() {
    worldEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function render() {
    worldEl.querySelectorAll('.mindmap-node').forEach(el => el.remove());
    svgEl.innerHTML = '';

    const allNodes = Store.getAll();
    const divById = {};
    const nodeById = {};
    allNodes.forEach(n => { nodeById[n.id] = n; });

    allNodes.forEach(node => {
      const div = buildNodeEl(node);
      worldEl.appendChild(div);
      divById[node.id] = div;
    });

    // draw connection lines after all boxes are in the DOM, so
    // offsetWidth/offsetHeight are correct (unaffected by the CSS transform)
    allNodes.forEach(node => {
      if (!node.parentId || !divById[node.parentId]) return;
      const line = drawLine(divById[node.parentId], nodeById[node.parentId], divById[node.id], node);
      svgEl.appendChild(line);
    });

    resizeWorld(allNodes);
  }

  function buildNodeEl(node) {
    const div = document.createElement('div');
    div.className = 'mindmap-node';
    if (node.notes) div.classList.add('has-notes');
    div.dataset.id = node.id;
    div.style.left = node.x + 'px';
    div.style.top = node.y + 'px';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'mindmap-node-name';
    nameSpan.textContent = node.name;
    div.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'mindmap-node-del';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete "${node.name}" and all its children?`)) {
        Store.deleteNode(node.id);
      }
    });
    div.appendChild(delBtn);

    // create a new child node directly from this node
    const addBtn = document.createElement('button');
    addBtn.className = 'mindmap-node-add';
    addBtn.title = 'Add child node';
    addBtn.textContent = '+';
    addBtn.addEventListener('pointerdown', e => e.stopPropagation());
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Store.addNode calls notify() synchronously, so the DOM is already
      // re-rendered with the new node by the time addNode returns
      const child = Store.addNode('New node', node.id);
      NotesEditor.open(child.id);
    });
    div.appendChild(addBtn);

    // right-click as an extra shortcut for deleting on desktop (mouse)
    div.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!AppMode.isEditMode()) return;
      if (confirm(`Delete "${node.name}" and all its children?`)) {
        Store.deleteNode(node.id);
      }
    });

    makeDraggable(div, node);
    return div;
  }

  // tapping/clicking without movement opens the node; dragging past a
  // small threshold moves it instead (edit mode only). Uses Pointer Events
  // instead of separate mouse+touch handling.
  function makeDraggable(div, node) {
    const MOVE_THRESHOLD = 5; // px, before a tap counts as a drag

    div.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return;
      e.stopPropagation(); // avoid triggering canvas panning

      const editMode = AppMode.isEditMode();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = node.x;
      const startTop = node.y;
      let dropTargetId = null;
      let moved = false;

      function onMove(ev) {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (!moved && (Math.abs(ev.clientX - startX) > MOVE_THRESHOLD || Math.abs(ev.clientY - startY) > MOVE_THRESHOLD)) {
          moved = true;
          if (editMode) div.classList.add('dragging-node');
        }
        if (!moved || !editMode) return; // view mode: track the tap, but never actually move the node
        ev.preventDefault();

        const newX = Math.max(0, startLeft + dx);
        const newY = Math.max(0, startTop + dy);
        div.style.left = newX + 'px';
        div.style.top = newY + 'px';
        updateLinksForNode(node.id, newX, newY, div);

        document.querySelectorAll('.mindmap-node.drop-target').forEach(el => el.classList.remove('drop-target'));
        const elUnder = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetDiv = elUnder && elUnder.closest('.mindmap-node');
        if (targetDiv && targetDiv !== div) {
          dropTargetId = targetDiv.dataset.id;
          targetDiv.classList.add('drop-target');
        } else {
          dropTargetId = null;
        }
      }

      function finish(ev) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        div.classList.remove('dragging-node');
        document.querySelectorAll('.mindmap-node.drop-target').forEach(el => el.classList.remove('drop-target'));

        if (moved && editMode) {
          const dx = (ev.clientX - startX) / zoom;
          const dy = (ev.clientY - startY) / zoom;
          const newX = Math.max(0, startLeft + dx);
          const newY = Math.max(0, startTop + dy);
          Store.moveNodePosition(node.id, newX, newY);
          if (dropTargetId) {
            Store.moveNode(node.id, dropTargetId);
          }
        } else if (!moved) {
          NotesEditor.open(node.id);
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  function centerOf(div, node) {
    return { cx: node.x + div.offsetWidth / 2, cy: node.y + div.offsetHeight / 2 };
  }

  function drawLine(parentDiv, parentNode, childDiv, childNode) {
    const p = centerOf(parentDiv, parentNode);
    const c = centerOf(childDiv, childNode);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', p.cx);
    line.setAttribute('y1', p.cy);
    line.setAttribute('x2', c.cx);
    line.setAttribute('y2', c.cy);
    line.setAttribute('class', 'mindmap-link');
    line.dataset.parent = parentNode.id;
    line.dataset.child = childNode.id;
    return line;
  }

  // live-updates while dragging: the line to the parent (as a child) and
  // lines to its own children (as a parent), without a full re-render
  function updateLinksForNode(id, x, y, div) {
    const cx = x + div.offsetWidth / 2;
    const cy = y + div.offsetHeight / 2;

    const asChild = svgEl.querySelector(`[data-child="${id}"]`);
    if (asChild) {
      asChild.setAttribute('x2', cx);
      asChild.setAttribute('y2', cy);
    }
    svgEl.querySelectorAll(`[data-parent="${id}"]`).forEach(line => {
      line.setAttribute('x1', cx);
      line.setAttribute('y1', cy);
    });
  }

  function resizeWorld(allNodes) {
    let maxX = 2000;
    let maxY = 1400;
    allNodes.forEach(n => {
      maxX = Math.max(maxX, n.x + 400);
      maxY = Math.max(maxY, n.y + 300);
    });
    worldEl.style.width = maxX + 'px';
    worldEl.style.height = maxY + 'px';
    svgEl.setAttribute('width', maxX);
    svgEl.setAttribute('height', maxY);
  }

  return { init, render };
})();
