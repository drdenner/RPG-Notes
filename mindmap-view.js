// mindmap-view.js
// Mindmap-visning: noder som frit placerbare bokse på et "verdens-lag"
// (mindmap-world), med SVG-linjer der viser forælder/barn-forbindelser.
//
// - Panorering/zoom sker ved at transformere hele world-laget (translate+scale),
//   node-positioner (x,y) er altid i "world"-koordinater og upåvirket af zoom.
// - Under træk opdateres DOM og linjer direkte (uden fuld re-render) for at
//   undgå flicker; Store opdateres først når man slipper.
// - Alt input bruger Pointer Events (ikke mouse-events), så det virker
//   ensartet med mus, pen og touch/tablet. Ét-finger-træk på tomt lærred
//   panorerer, to-finger-knib zoomer (samt musehjul på desktop).

const MindmapView = (() => {
  let canvasEl = null;
  let worldEl = null;
  let svgEl = null;
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // --- panorering + pinch-zoom state (canvas-niveau, kan have 1-2 samtidige pointere) ---
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
      // placér den nye node midt i det nuværende synlige udsnit
      const rect = canvasEl.getBoundingClientRect();
      const worldX = Math.max(0, (rect.width / 2 - panX) / zoom - 60);
      const worldY = Math.max(0, (rect.height / 2 - panY) / zoom - 20);
      const node = Store.addNode('Ny rod-node', null);
      Store.moveNodePosition(node.id, worldX, worldY);
    });

    // zoom med musehjul (desktop)
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

  // --- panorering (1 finger/mus) og pinch-zoom (2 fingre) på tomt lærred ---

  function onCanvasPointerDown(e) {
    if (e.target !== canvasEl && e.target !== worldEl) return; // kun på tomt lærred, ikke på en node
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
      // fortsæt panorering med den resterende finger
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

    // tegn forbindelseslinjer efter alle bokse er lagt i DOM'en, så
    // offsetWidth/offsetHeight er korrekte (upåvirket af CSS-transform)
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
    div.dataset.id = node.id;
    div.style.left = node.x + 'px';
    div.style.top = node.y + 'px';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'mindmap-node-name';
    nameSpan.textContent = node.name;
    div.appendChild(nameSpan);

    const delBtn = document.createElement('button');
    delBtn.className = 'mindmap-node-del';
    delBtn.title = 'Slet';
    delBtn.textContent = '✕';
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Slet "${node.name}" og alle underpunkter?`)) {
        Store.deleteNode(node.id);
      }
    });
    div.appendChild(delBtn);

    // opret en ny undernode direkte fra denne node
    const addBtn = document.createElement('button');
    addBtn.className = 'mindmap-node-add';
    addBtn.title = 'Tilføj underpunkt';
    addBtn.textContent = '+';
    addBtn.addEventListener('pointerdown', e => e.stopPropagation());
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Store.addNode kalder notify() synkront, så DOM'en er allerede
      // gen-tegnet med den nye node når addNode returnerer
      const child = Store.addNode('Ny node', node.id);
      const childDiv = worldEl.querySelector(`.mindmap-node[data-id="${child.id}"]`);
      if (childDiv) startEditingNode(child.id, childDiv);
    });
    div.appendChild(addBtn);

    // højreklik som ekstra genvej til sletning på desktop (mus)
    div.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!AppMode.isEditMode()) return;
      if (confirm(`Slet "${node.name}" og alle underpunkter?`)) {
        Store.deleteNode(node.id);
      }
    });

    makeDraggable(div, node);
    return div;
  }

  // træk for at flytte en node; tryk/tap uden bevægelse to gange hurtigt
  // efter hinanden (dobbeltklik/dobbelttryk) omdøber den. Bruger Pointer
  // Events fremfor mouse+touch hver for sig, og undgår browserens indbyggede
  // dblclick-synkronisering (som touch ikke altid udløser pålideligt).
  function makeDraggable(div, node) {
    let lastTapTime = 0;
    const MOVE_THRESHOLD = 5; // px, før et tryk regnes som et træk

    div.addEventListener('pointerdown', e => {
      if (!AppMode.isEditMode()) return; // i vis-tilstand kan noder hverken trækkes eller omdøbes
      if (e.button !== undefined && e.button > 0) return;
      e.stopPropagation(); // undgå at trigge panorering af canvas

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
          div.classList.add('dragging-node');
        }
        if (!moved) return;
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

        if (moved) {
          const dx = (ev.clientX - startX) / zoom;
          const dy = (ev.clientY - startY) / zoom;
          const newX = Math.max(0, startLeft + dx);
          const newY = Math.max(0, startTop + dy);
          Store.moveNodePosition(node.id, newX, newY);
          if (dropTargetId) {
            Store.moveNode(node.id, dropTargetId);
          }
        } else {
          // rent tryk/klik uden bevægelse -> tjek for dobbelttryk (omdøb)
          const now = Date.now();
          if (now - lastTapTime < 350) {
            lastTapTime = 0;
            startEditingNode(node.id, div);
          } else {
            lastTapTime = now;
          }
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  function startEditingNode(id, div) {
    const nameSpan = div.querySelector('.mindmap-node-name');
    const node = Store.getById(id);

    const input = document.createElement('input');
    input.className = 'mindmap-node-input';
    input.type = 'text';
    input.value = node.name;
    input.addEventListener('pointerdown', e => e.stopPropagation());
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      Store.renameNode(id, input.value);
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = node.name; input.blur(); }
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

  // opdaterer live under træk: linjen til forælderen (som barn) og linjer
  // til egne børn (som forælder), uden en fuld re-render
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
