// mindmap-view.js
// Mindmap view: nodes as freely placeable boxes on a "world" layer
// (mindmap-world), one level of the campaign at a time, with SVG lines
// from the current node to its children.
//
// - Only the current node (`currentParentId`, null = the campaign's root
//   level) and its direct children are rendered. The current node is drawn
//   at its own x/y, highlighted, with a line to each child; on the root
//   level there's no current node, just the root nodes. Tapping a child
//   goes into it, and the breadcrumb bar at the top goes back up. The data
//   doesn't change at all: the current level is just a filter on parentId.
// - Panning/zoom work by transforming the whole world layer (translate+scale),
//   node positions (x,y) are always in "world" coordinates and unaffected by zoom.
// - While dragging, the DOM and lines are updated directly (no full
//   re-render) to avoid flicker; the Store is only updated once you release.
// - All input uses Pointer Events (not mouse events), so it behaves the
//   same with mouse, pen and touch/tablet. One-finger drag on empty canvas
//   pans, two-finger pinch zooms (plus the mouse wheel on desktop).
// - Tapping a child (no movement) goes into it; tapping the current node
//   opens its notes. Notes also open from the small notes button on every
//   node, or from the current node's name in the breadcrumb (NotesEditor -
//   rename and notes both live there). Dragging
//   it (movement past a small threshold) moves it instead, and only works
//   in edit mode.
//
// --- performance notes ---
// render() is incremental: it diffs the current level's nodes against
// what's already on screen (tracked in `entries`, keyed by node id) and
// only creates/updates/removes what actually changed, instead of tearing
// down and rebuilding every node and line on every single Store change.
// Nodes outside the current level never get any DOM at all, so a big campaign
// costs no more to show than its busiest level. Each node's rendered box
// size (offsetWidth/offsetHeight) is measured once and cached on its
// entry, and only re-measured when its text changes - reading
// offsetWidth/Height forces the browser to flush layout, so avoiding
// repeated reads (notably on every pointermove while dragging, for the
// line math) is the main win here. `notes` is never
// rendered - the mindmap only reads name/x/y/parentId (plus whether notes
// is empty, for the has-notes marker).

const MindmapView = (() => {
  let canvasEl = null;
  let worldEl = null;
  let svgEl = null;
  let breadcrumbEl = null;
  let emptyEl = null;
  let newNodeBtn = null;
  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // the node whose children are shown (null = the campaign's root nodes)
  let currentParentId = null;
  // campaign + level that was last rendered, to re-center when it changes
  let renderedLevelKey = null;

  // node id -> { div, nameSpan, countSpan, cached: <node data>, childCount, width, height }
  const entries = new Map();
  // child node id -> its <line> element (a node has at most one parent line)
  const lineEls = new Map();

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
    breadcrumbEl = container.querySelector('#mindmap-breadcrumb');
    emptyEl = container.querySelector('#mindmap-empty');
    newNodeBtn = container.querySelector('#mindmap-new-root-btn');

    newNodeBtn.addEventListener('click', () => {
      // a new node on the current level, placed roughly in the middle of
      // the current viewport
      const rect = canvasEl.getBoundingClientRect();
      const worldX = Math.max(0, (rect.width / 2 - panX) / zoom - 60);
      const worldY = Math.max(0, (rect.height / 2 - panY) / zoom - 20);
      const node = Store.addNode(currentParentId ? 'New node' : 'New root node', currentParentId);
      if (!node) return;
      Store.moveNodePosition(node.id, worldX, worldY);
      NotesEditor.open(node.id);
    });

    // zoom with the mouse wheel (desktop) - just a transform, no per-node work
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
  // unchanged from before: cheap arithmetic + a single CSS transform write,
  // never touches individual nodes, so there's nothing to optimize here.

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

  // --- levels / navigation ---

  function navigateTo(parentId) {
    currentParentId = parentId;
    render();
  }

  // pans (keeping the zoom) so the level's nodes are centered in the
  // viewport, or start at the top-left if they don't fit
  function centerView() {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || entries.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    entries.forEach(entry => {
      minX = Math.min(minX, entry.cached.x);
      minY = Math.min(minY, entry.cached.y);
      maxX = Math.max(maxX, entry.cached.x + entry.width);
      maxY = Math.max(maxY, entry.cached.y + entry.height);
    });
    const MARGIN = 40;
    const TOP = 70; // room for the breadcrumb bar
    const w = (maxX - minX) * zoom;
    const h = (maxY - minY) * zoom;
    panX = w + 2 * MARGIN < rect.width ? (rect.width - w) / 2 - minX * zoom : MARGIN - minX * zoom;
    panY = h + TOP + MARGIN < rect.height ? TOP + (rect.height - TOP - h) / 2 - minY * zoom : TOP - minY * zoom;
    applyTransform();
  }

  // "← | Campaign › Chapter 1 › Vinterholm 📝" - hidden on the root level
  function renderBreadcrumb(nodeById) {
    const path = []; // root-level node ... current node
    for (let n = nodeById.get(currentParentId); n; n = nodeById.get(n.parentId)) path.unshift(n);

    breadcrumbEl.innerHTML = '';
    breadcrumbEl.hidden = path.length === 0;
    if (path.length === 0) return;

    const campaignName = Store.getCurrentCampaignName() || 'Campaign';
    const parent = path.length > 1 ? path[path.length - 2] : null;
    const backBtn = document.createElement('button');
    backBtn.className = 'btn mindmap-back-btn';
    backBtn.textContent = '←';
    backBtn.title = 'Back to ' + (parent ? parent.name : campaignName);
    backBtn.addEventListener('click', () => navigateTo(parent ? parent.id : null));
    breadcrumbEl.appendChild(backBtn);

    const crumbs = [{ id: null, name: campaignName }, ...path];
    crumbs.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'mindmap-crumb-sep';
        sep.textContent = '›';
        breadcrumbEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = 'mindmap-crumb';
      btn.textContent = crumb.name;
      if (i === crumbs.length - 1) {
        // the current node itself: open its notes
        btn.classList.add('current');
        btn.textContent += ' 📝';
        btn.title = 'Open notes';
        btn.addEventListener('click', () => NotesEditor.open(crumb.id));
      } else {
        btn.addEventListener('click', () => navigateTo(crumb.id));
      }
      breadcrumbEl.appendChild(btn);
    });
    // on a narrow screen, keep the current node (the end) in view
    breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
  }

  // --- incremental render ---
  // Diffs the current level's nodes against `entries`. Only touches nodes
  // that are new, gone, or actually changed - a rename, a notes edit or a
  // position change never rebuilds nodes that weren't affected, and nodes
  // outside the current level are never built at all.

  function render() {
    const allNodes = Store.getAll();
    const nodeById = new Map(allNodes.map(n => [n.id, n]));

    // the current node was deleted (or the campaign switched): back to the root level
    if (currentParentId && !nodeById.has(currentParentId)) currentParentId = null;

    const childCounts = new Map();
    const levelNodes = [];
    allNodes.forEach(n => {
      if (n.parentId) childCounts.set(n.parentId, (childCounts.get(n.parentId) || 0) + 1);
      // the current node itself + its children
      if (n.parentId === currentParentId || n.id === currentParentId) levelNodes.push(n);
    });
    const levelIds = new Set(levelNodes.map(n => n.id));

    // remove entries for nodes that no longer exist or aren't on this level
    entries.forEach((entry, id) => {
      if (!levelIds.has(id)) removeNodeEntry(id);
    });

    levelNodes.forEach(node => {
      const childCount = childCounts.get(node.id) || 0;
      const entry = entries.get(node.id);
      const updated = entry ? updateNodeEntry(entry, node, childCount) : createNodeEntry(node, childCount);
      updated.div.classList.toggle('is-current', node.id === currentParentId);
    });

    // second pass: lines need every node's box to already be sized and
    // positioned. Only a child's line to the current node is ever drawn -
    // the current node's own parent isn't rendered, so that line is removed
    levelNodes.forEach(node => syncConnection(node));

    renderBreadcrumb(nodeById);
    emptyEl.hidden = entries.size > (currentParentId ? 1 : 0) || !Store.getCurrentCampaignId();
    newNodeBtn.textContent = currentParentId ? '+ New node' : '+ New root node';

    const levelKey = Store.getCurrentCampaignId() + '|' + currentParentId;
    if (levelKey !== renderedLevelKey) {
      renderedLevelKey = levelKey;
      centerView();
    }
  }

  function createNodeEntry(node, childCount) {
    const entry = { cached: node, childCount, positionChanged: true, sizeChanged: true };
    entry.div = buildNodeEl(entry);
    entry.nameSpan = entry.div.querySelector('.mindmap-node-name');
    entry.countSpan = entry.div.querySelector('.mindmap-node-count');
    worldEl.appendChild(entry.div);
    measure(entry);
    entries.set(node.id, entry);
    return entry;
  }

  function updateNodeEntry(entry, node, childCount) {
    const prev = entry.cached;

    entry.positionChanged = prev.x !== node.x || prev.y !== node.y;
    if (entry.positionChanged) {
      entry.div.style.left = node.x + 'px';
      entry.div.style.top = node.y + 'px';
    }

    const nameChanged = prev.name !== node.name;
    if (nameChanged) entry.nameSpan.textContent = node.name;
    const countChanged = entry.childCount !== childCount;
    if (countChanged) {
      entry.childCount = childCount;
      setChildCount(entry.countSpan, childCount);
    }
    entry.sizeChanged = nameChanged || countChanged;
    if (entry.sizeChanged) measure(entry); // text changed -> box size may have changed too

    if (!!prev.notes !== !!node.notes) {
      entry.div.classList.toggle('has-notes', !!node.notes);
    }

    entry.cached = node;
    return entry;
  }

  function removeNodeEntry(id) {
    const entry = entries.get(id);
    if (entry) entry.div.remove();
    entries.delete(id);
    const line = lineEls.get(id);
    if (line) { line.remove(); lineEls.delete(id); }
  }

  // reads offsetWidth/Height (forces layout) - only called when a node is
  // first created or its text changed, never on every render
  function measure(entry) {
    entry.width = entry.div.offsetWidth;
    entry.height = entry.div.offsetHeight;
  }

  function syncConnection(node) {
    const parentEntry = node.parentId ? entries.get(node.parentId) : null;
    const childEntry = entries.get(node.id);
    let line = lineEls.get(node.id);

    if (!parentEntry || !childEntry) {
      if (line) { line.remove(); lineEls.delete(node.id); }
      return;
    }

    // a brand new line, or one that now points at a different parent
    // (re-parented in the list view), always needs fresh endpoints -
    // this can't be inferred from positionChanged/sizeChanged alone
    let reconnected = false;
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'mindmap-link');
      line.dataset.child = node.id;
      svgEl.appendChild(line);
      lineEls.set(node.id, line);
      reconnected = true;
    }
    if (line.dataset.parent !== node.parentId) {
      line.dataset.parent = node.parentId;
      reconnected = true;
    }

    // cheap: only touch the SVG attributes when something relevant to this
    // specific edge actually changed, not on every render (e.g. a pure
    // notes edit elsewhere touches nothing here)
    if (reconnected || parentEntry.positionChanged || parentEntry.sizeChanged || childEntry.positionChanged || childEntry.sizeChanged) {
      updateLineEndpoints(line, parentEntry, childEntry);
    }
  }

  function centerOf(entry) {
    return { cx: entry.cached.x + entry.width / 2, cy: entry.cached.y + entry.height / 2 };
  }

  function updateLineEndpoints(line, parentEntry, childEntry) {
    const p = centerOf(parentEntry);
    const c = centerOf(childEntry);
    line.setAttribute('x1', p.cx);
    line.setAttribute('y1', p.cy);
    line.setAttribute('x2', c.cx);
    line.setAttribute('y2', c.cy);
  }

  function setChildCount(span, count) {
    span.textContent = count ? '▸ ' + count : '';
    span.hidden = !count;
  }

  function buildNodeEl(entry) {
    const node = entry.cached;
    const div = document.createElement('div');
    entry.div = div; // set before makeDraggable(entry) reads it below
    div.className = 'mindmap-node';
    if (node.notes) div.classList.add('has-notes');
    div.dataset.id = node.id;
    div.style.left = node.x + 'px';
    div.style.top = node.y + 'px';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'mindmap-node-name';
    nameSpan.textContent = node.name;
    div.appendChild(nameSpan);

    // how many children this node has, so you can tell which ones lead somewhere
    const countSpan = document.createElement('span');
    countSpan.className = 'mindmap-node-count';
    setChildCount(countSpan, entry.childCount);
    div.appendChild(countSpan);

    // tapping the node goes into it, so its notes open from this button
    const notesBtn = document.createElement('button');
    notesBtn.className = 'mindmap-node-notes';
    notesBtn.title = 'Open notes';
    notesBtn.textContent = '📝';
    notesBtn.addEventListener('pointerdown', e => e.stopPropagation());
    notesBtn.addEventListener('click', e => {
      e.stopPropagation();
      NotesEditor.open(entry.cached.id);
    });
    div.appendChild(notesBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'mindmap-node-del';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      // read the live name (entry.cached), not the node captured when this
      // button was created - the div is reused across renders, so the
      // node it was built for can have been renamed since
      if (confirm(`Delete "${entry.cached.name}" and all its children?`)) {
        Store.deleteNode(entry.cached.id);
      }
    });
    div.appendChild(delBtn);

    // create a new child node directly from this node, and go into this
    // node so the new child is actually visible
    const addBtn = document.createElement('button');
    addBtn.className = 'mindmap-node-add';
    addBtn.title = 'Add child node';
    addBtn.textContent = '+';
    addBtn.addEventListener('pointerdown', e => e.stopPropagation());
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      const child = Store.addNode('New node', entry.cached.id);
      navigateTo(entry.cached.id);
      NotesEditor.open(child.id);
    });
    div.appendChild(addBtn);

    // right-click as an extra shortcut for deleting on desktop (mouse)
    div.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!AppMode.isEditMode()) return;
      if (confirm(`Delete "${entry.cached.name}" and all its children?`)) {
        Store.deleteNode(entry.cached.id);
      }
    });

    makeDraggable(entry);
    return div;
  }

  // tapping/clicking without movement goes into the node (or, for the
  // current node, opens its notes); dragging past a
  // small threshold moves it instead (edit mode only). Dragging only ever
  // changes the node's position - re-parenting is done in the list view.
  // Uses Pointer Events instead of separate mouse+touch handling.
  //
  // Performance: no Store writes and no full re-render happen while
  // dragging - only this node's style.left/top and its own connection
  // lines are touched directly, using the box size cached on `entry`
  // (never re-measuring offsetWidth/Height mid-drag). The raw pointermove
  // stream is coalesced with requestAnimationFrame, so a fast flurry of
  // events only does one DOM update per frame instead of one per event.
  function makeDraggable(entry) {
    const MOVE_THRESHOLD = 5; // px, before a tap counts as a drag
    const div = entry.div;

    div.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button > 0) return;
      e.stopPropagation(); // avoid triggering canvas panning

      const editMode = AppMode.isEditMode();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = entry.cached.x;
      const startTop = entry.cached.y;
      let moved = false;
      let rafId = null;
      let pendingEvent = null;

      function applyMove(ev) {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (!moved && (Math.abs(ev.clientX - startX) > MOVE_THRESHOLD || Math.abs(ev.clientY - startY) > MOVE_THRESHOLD)) {
          moved = true;
          if (editMode) div.classList.add('dragging-node');
        }
        if (!moved || !editMode) return; // view mode: track the tap, but never actually move the node

        const newX = Math.max(0, startLeft + dx);
        const newY = Math.max(0, startTop + dy);
        div.style.left = newX + 'px';
        div.style.top = newY + 'px';
        // keep the cached position in sync so line math stays correct;
        // this is in-memory only, nothing is written to Store mid-drag
        entry.cached.x = newX;
        entry.cached.y = newY;
        updateLinksForNode(entry);
      }

      function onMove(ev) {
        ev.preventDefault();
        pendingEvent = ev;
        if (rafId == null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            applyMove(pendingEvent);
          });
        }
      }

      function finish(ev) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        // make sure the final position is applied even if a rAF was still pending
        applyMove(ev);

        div.classList.remove('dragging-node');

        if (moved && editMode) {
          Store.moveNodePosition(entry.cached.id, entry.cached.x, entry.cached.y);
        } else if (!moved) {
          if (entry.cached.id === currentParentId) NotesEditor.open(entry.cached.id);
          else navigateTo(entry.cached.id);
        }
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  // live-updates while dragging: the line to the parent (as a child) and
  // lines to its own children (as a parent), without a full re-render
  function updateLinksForNode(entry) {
    const c = centerOf(entry);

    const asChild = lineEls.get(entry.cached.id);
    if (asChild) {
      asChild.setAttribute('x2', c.cx);
      asChild.setAttribute('y2', c.cy);
    }
    svgEl.querySelectorAll(`[data-parent="${entry.cached.id}"]`).forEach(line => {
      line.setAttribute('x1', c.cx);
      line.setAttribute('y1', c.cy);
    });
  }

  return { init, render };
})();
