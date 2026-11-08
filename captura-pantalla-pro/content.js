(() => {
  // Permitir reinicializar funciones actualizadas si se recarga la extensión
  if (window.__CAPTURA_PRO_CLEANUP_LISTENER__) {
    try {
      chrome.runtime.onMessage.removeListener(window.__CAPTURA_PRO_CLEANUP_LISTENER__);
    } catch (_) {}
  }

  let fullPageState = null;
  let selectionHost = null;

  /**
   * Recorre todos los elementos del DOM incluyendo Web Components personalizados
   * (como <infinite-scroller> en Gemini) y Shadow DOM abiertos.
   */
  function getAllElementsDeep(root = document.documentElement, list = []) {
    if (!root) return list;
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of elements) {
      list.push(el);
      if (el.shadowRoot) {
        getAllElementsDeep(el.shadowRoot, list);
      }
    }
    return list;
  }

  /**
   * Comprueba si un elemento realmente puede desplazarse verticalmente (scroll)
   */
  function canScrollVertically(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const scrollH = el.scrollHeight;
    const clientH = el.clientHeight;
    if (!scrollH || !clientH || scrollH <= clientH + 25) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const oy = style.overflowY;
    const o = style.overflow;
    if (oy === 'hidden' || oy === 'clip' || oy === 'visible') return false;

    // Si ya está desplazado hacia abajo, es 100% scrollable
    if (el.scrollTop > 0) return true;

    // Probar si acepta cambiar scrollTop programáticamente
    const prev = el.scrollTop;
    el.scrollTop = prev + 2;
    const movedDown = el.scrollTop !== prev;
    if (movedDown) {
      el.scrollTop = prev;
      return true;
    }

    if (prev > 0) {
      el.scrollTop = Math.max(0, prev - 2);
      const movedUp = el.scrollTop !== prev;
      el.scrollTop = prev;
      if (movedUp) return true;
    }

    return oy === 'auto' || oy === 'scroll' || oy === 'overlay' || o === 'auto' || o === 'scroll';
  }

  /**
   * Encuentra el contenedor principal con scroll (sea window o un contenedor interno
   * como en Google Gemini, ChatGPT, Claude, Notion, etc.)
   */
  function findScrollableTarget() {
    const docEl = document.scrollingElement || document.documentElement;
    const body = document.body;
    const docScrollHeight = Math.max(
      docEl ? docEl.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      docEl ? docEl.offsetHeight : 0,
      body ? body.offsetHeight : 0
    );

    const allElements = getAllElementsDeep(document.documentElement);
    let bestCandidate = null;
    let bestScore = 0;

    for (const el of allElements) {
      if (!canScrollVertically(el)) continue;

      const rect = el.getBoundingClientRect();
      // Debe ocupar al menos una parte importante de la ventana (no un menú pequeño)
      if (rect.width < window.innerWidth * 0.28 || rect.height < window.innerHeight * 0.28) {
        continue;
      }
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        continue;
      }

      // Puntuar priorizando ancho del área principal y altura total de contenido
      const widthRatio = rect.width / window.innerWidth;
      const heightRatio = rect.height / window.innerHeight;
      const score = el.scrollHeight * (widthRatio * widthRatio) * heightRatio;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = el;
      }
    }

    // Si la ventana principal casi no tiene scroll o el contenedor interno tiene mucho contenido
    if (
      bestCandidate &&
      (docScrollHeight <= window.innerHeight + 40 || bestCandidate.scrollHeight > docScrollHeight * 0.7)
    ) {
      return {
        type: 'element',
        element: bestCandidate,
        totalHeight: bestCandidate.scrollHeight
      };
    }

    return {
      type: 'window',
      element: docEl,
      totalHeight: Math.max(docScrollHeight, window.innerHeight)
    };
  }

  /**
   * Espera a que el navegador pinte los cambios en pantalla
   */
  function waitForPaint(delayMs = 140) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, delayMs);
        });
      });
    });
  }

  function recordElementForHiding(el, map) {
    if (!el || map.has(el) || el === document.documentElement || el === document.body) return;
    map.set(el, {
      el,
      origVisibility: el.style.getPropertyValue('visibility'),
      origVisibilityPriority: el.style.getPropertyPriority('visibility'),
      origOpacity: el.style.getPropertyValue('opacity'),
      origOpacityPriority: el.style.getPropertyPriority('opacity')
    });
  }

  /**
   * Detecta barras flotantes superiores e inferiores (fixed, sticky o superpuestas como
   * la caja "Preguntarle a Gemini" en Gemini) para que no tapen el texto al hacer scroll.
   */
  function collectFloatingOverlays(scrollEl, isElementScroll) {
    const topOverlays = new Map();
    const bottomOverlays = new Map();

    const sRect = isElementScroll
      ? scrollEl.getBoundingClientRect()
      : {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight
        };

    const allElements = getAllElementsDeep(document.documentElement);

    // 1. Elementos fixed y sticky globales
    for (const el of allElements) {
      if (isElementScroll && (el === scrollEl || el.contains(scrollEl))) continue;
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.height > window.innerHeight * 0.65) continue;
        const centerY = r.top + r.height / 2;
        if (centerY > window.innerHeight * 0.55) {
          recordElementForHiding(el, bottomOverlays);
        } else {
          recordElementForHiding(el, topOverlays);
        }
      }
    }

    // 2. Si es un contenedor interno (ej. Gemini / ChatGPT), detectar barras superpuestas
    // encima de la parte superior o inferior de scrollEl mediante elementsFromPoint
    if (isElementScroll && scrollEl) {
      const sampleXs = [
        sRect.left + sRect.width * 0.35,
        sRect.left + sRect.width * 0.5,
        sRect.left + sRect.width * 0.65
      ];
      const topSampleYs = [sRect.top + 16, sRect.top + 42, sRect.top + 68];
      const bottomSampleYs = [
        sRect.bottom - 18,
        sRect.bottom - 48,
        sRect.bottom - 85,
        sRect.bottom - 125
      ];

      function findOverlayRoot(hitEl) {
        if (!hitEl || hitEl === scrollEl || scrollEl.contains(hitEl) || hitEl.contains(scrollEl)) {
          return null;
        }
        let candidate = hitEl;
        let curr = hitEl.parentElement;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          if (curr === scrollEl || curr.contains(scrollEl)) break;
          const r = curr.getBoundingClientRect();
          if (r.height > sRect.height * 0.42) break;
          candidate = curr;
          curr = curr.parentElement;
        }
        const cRect = candidate.getBoundingClientRect();
        if (cRect.height <= 4 || cRect.height > sRect.height * 0.42) return null;
        return candidate;
      }

      for (const x of sampleXs) {
        for (const y of topSampleYs) {
          if (y <= 0 || y >= window.innerHeight) continue;
          const hits = document.elementsFromPoint(x, y);
          for (const h of hits) {
            if (h === scrollEl || scrollEl.contains(h)) break;
            const rootOverlay = findOverlayRoot(h);
            if (rootOverlay) recordElementForHiding(rootOverlay, topOverlays);
          }
        }
        for (const y of bottomSampleYs) {
          if (y <= 0 || y >= window.innerHeight) continue;
          const hits = document.elementsFromPoint(x, y);
          for (const h of hits) {
            if (h === scrollEl || scrollEl.contains(h)) break;
            const rootOverlay = findOverlayRoot(h);
            if (rootOverlay) recordElementForHiding(rootOverlay, bottomOverlays);
          }
        }
      }
    }

    return {
      topOverlays: Array.from(topOverlays.values()),
      bottomOverlays: Array.from(bottomOverlays.values())
    };
  }

  function setElementsHidden(items, hidden) {
    if (!items) return;
    for (const item of items) {
      if (!item.el || !item.el.isConnected) continue;
      if (hidden) {
        item.el.style.setProperty('visibility', 'hidden', 'important');
        item.el.style.setProperty('opacity', '0', 'important');
      } else {
        if (item.origVisibility) {
          item.el.style.setProperty('visibility', item.origVisibility, item.origVisibilityPriority || '');
        } else {
          item.el.style.removeProperty('visibility');
        }
        if (item.origOpacity) {
          item.el.style.setProperty('opacity', item.origOpacity, item.origOpacityPriority || '');
        } else {
          item.el.style.removeProperty('opacity');
        }
      }
    }
  }

  /**
   * Prepara la página para la captura completa con scroll automático
   */
  async function prepareFullPageCapture() {
    cleanupFullPageCapture();

    const styleEl = document.createElement('style');
    styleEl.id = '__captura_pro_temp_style__';
    styleEl.textContent = `
      html, body, * {
        scroll-behavior: auto !important;
        transition: none !important;
      }
      ::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    const targetInfo = findScrollableTarget();
    const isElementScroll = targetInfo.type === 'element';
    const scrollEl = targetInfo.element;

    const origX = isElementScroll ? scrollEl.scrollLeft : window.scrollX;
    const origY = isElementScroll ? scrollEl.scrollTop : window.scrollY;

    // Desplazar al inicio (arriba del todo) para capturar desde el principio
    if (isElementScroll) {
      scrollEl.scrollTop = 0;
      scrollEl.scrollLeft = 0;
    } else {
      window.scrollTo(0, 0);
    }

    await waitForPaint(220);

    const { topOverlays, bottomOverlays } = collectFloatingOverlays(scrollEl, isElementScroll);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    const sRect = isElementScroll
      ? scrollEl.getBoundingClientRect()
      : {
          left: 0,
          top: 0,
          width: viewportWidth,
          height: viewportHeight
        };

    const clipRect = {
      x: Math.max(0, Math.round(sRect.left)),
      y: Math.max(0, Math.round(sRect.top)),
      width: Math.min(viewportWidth, Math.round(sRect.width)),
      height: Math.min(viewportHeight, Math.round(sRect.height))
    };

    const rawTotalHeight = isElementScroll
      ? Math.max(scrollEl.scrollHeight, viewportHeight)
      : Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.offsetHeight : 0,
          document.documentElement ? document.documentElement.offsetHeight : 0,
          viewportHeight
        );

    const maxSafeCssHeight = Math.floor(30000 / dpr);
    const totalHeight = Math.min(rawTotalHeight, maxSafeCssHeight);

    fullPageState = {
      styleEl,
      isElementScroll,
      scrollEl,
      origX,
      origY,
      topOverlays,
      bottomOverlays,
      viewportWidth,
      viewportHeight,
      totalHeight,
      clipRect,
      dpr
    };

    return {
      isElementScroll,
      viewportWidth,
      viewportHeight,
      totalHeight,
      clipRect,
      dpr,
      pageTitle: document.title || 'captura-pagina',
      pageUrl: window.location.href
    };
  }

  /**
   * Desplaza la página o contenedor al paso indicado y devuelve métricas exactas
   */
  async function scrollToStep(stepIndex, targetY) {
    if (!fullPageState) {
      throw new Error('El estado de captura completa no está inicializado.');
    }

    const {
      isElementScroll,
      scrollEl,
      topOverlays,
      bottomOverlays,
      viewportWidth,
      viewportHeight,
      clipRect,
      dpr
    } = fullPageState;

    // Ocultar siempre barras flotantes inferiores durante las capturas para que no tapen el texto
    setElementsHidden(bottomOverlays, true);

    // Ocultar cabeceras flotantes superiores a partir del segundo fragmento (stepIndex > 0)
    if (stepIndex > 0) {
      setElementsHidden(topOverlays, true);
    } else {
      setElementsHidden(topOverlays, false);
    }

    if (isElementScroll) {
      scrollEl.scrollTop = targetY;
    } else {
      window.scrollTo(0, targetY);
    }

    await waitForPaint(160);

    const actualY = isElementScroll ? Math.round(scrollEl.scrollTop) : Math.round(window.scrollY);
    const currentScrollHeight = isElementScroll
      ? scrollEl.scrollHeight
      : Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0,
          viewportHeight
        );
    const clientHeight = isElementScroll ? scrollEl.clientHeight : viewportHeight;

    const maxSafeCssHeight = Math.floor(30000 / (window.devicePixelRatio || dpr));
    const cappedScrollHeight = Math.min(currentScrollHeight, maxSafeCssHeight);
    fullPageState.totalHeight = cappedScrollHeight;

    const reachedBottom = actualY + clientHeight >= cappedScrollHeight - 4;

    return {
      actualY,
      viewportWidth: window.innerWidth || viewportWidth,
      viewportHeight: window.innerHeight || viewportHeight,
      totalHeight: cappedScrollHeight,
      clientHeight,
      clipRect,
      reachedBottom,
      dpr: window.devicePixelRatio || dpr
    };
  }

  /**
   * Restaura todos los estilos y la posición original de scroll
   */
  function cleanupFullPageCapture() {
    if (!fullPageState) return;
    const { styleEl, isElementScroll, scrollEl, origX, origY, topOverlays, bottomOverlays } =
      fullPageState;

    try {
      setElementsHidden(topOverlays, false);
      setElementsHidden(bottomOverlays, false);
    } catch (_) {}

    try {
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
    } catch (_) {}

    try {
      if (isElementScroll && scrollEl) {
        scrollEl.scrollLeft = origX;
        scrollEl.scrollTop = origY;
      } else {
        window.scrollTo(origX, origY);
      }
    } catch (_) {}

    fullPageState = null;
  }

  /**
   * Inicia el selector interactivo para Captura Parcial (Área Seleccionada)
   */
  function startPartialSelection(defaultAction = 'preview') {
    removePartialSelectionOverlay();

    selectionHost = document.createElement('div');
    selectionHost.id = '__captura_pro_overlay_host__';
    selectionHost.style.cssText = `
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      user-select: none !important;
    `;

    const shadow = selectionHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif;
      }
      .overlay-root {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        cursor: crosshair;
        overflow: hidden;
      }
      .backdrop-full {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        transition: opacity 0.15s ease;
      }
      .top-hint {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.92);
        color: #f8fafc;
        padding: 10px 18px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.14);
        backdrop-filter: blur(8px);
        z-index: 10;
        pointer-events: none;
      }
      .top-hint kbd {
        background: rgba(255, 255, 255, 0.15);
        padding: 2px 7px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 600;
      }
      .selection-box {
        position: absolute;
        display: none;
        border: 2px solid #38bdf8;
        box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.58), 0 0 15px rgba(56, 189, 248, 0.45);
        cursor: move;
        z-index: 5;
      }
      .size-badge {
        position: absolute;
        top: -28px;
        left: 0;
        background: #0f172a;
        color: #38bdf8;
        font-size: 11px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 5px;
        white-space: nowrap;
        box-shadow: 0 4px 10px rgba(0,0,0,0.25);
        border: 1px solid rgba(56, 189, 248, 0.35);
        pointer-events: none;
      }
      .handle {
        position: absolute;
        width: 10px;
        height: 10px;
        background: #ffffff;
        border: 2px solid #0284c7;
        border-radius: 50%;
      }
      .handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
      .handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
      .handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
      .handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }

      .toolbar {
        position: absolute;
        display: none;
        align-items: center;
        gap: 6px;
        background: #0f172a;
        padding: 6px 8px;
        border-radius: 10px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.12);
        z-index: 15;
        white-space: nowrap;
      }
      .btn {
        border: none;
        outline: none;
        padding: 7px 12px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition: all 0.15s ease;
      }
      .btn-primary {
        background: linear-gradient(135deg, #4f46e5, #06b6d4);
        color: #ffffff;
      }
      .btn-primary:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      .btn-pdf {
        background: #ef4444;
        color: #ffffff;
      }
      .btn-pdf:hover {
        background: #dc2626;
        transform: translateY(-1px);
      }
      .btn-img {
        background: #10b981;
        color: #ffffff;
      }
      .btn-img:hover {
        background: #059669;
        transform: translateY(-1px);
      }
      .btn-cancel {
        background: rgba(255, 255, 255, 0.1);
        color: #cbd5e1;
      }
      .btn-cancel:hover {
        background: rgba(255, 255, 255, 0.2);
        color: #ffffff;
      }
    `;

    const root = document.createElement('div');
    root.className = 'overlay-root';
    root.innerHTML = `
      <div class="backdrop-full" id="backdrop"></div>
      <div class="top-hint" id="hint">
        <span>✂️ Arrastra para seleccionar la zona de la página</span>
        <kbd>ESC</kbd> para cancelar
      </div>
      <div class="selection-box" id="box">
        <div class="size-badge" id="sizeBadge">0 × 0 px</div>
        <div class="handle nw" data-handle="nw"></div>
        <div class="handle ne" data-handle="ne"></div>
        <div class="handle sw" data-handle="sw"></div>
        <div class="handle se" data-handle="se"></div>
      </div>
      <div class="toolbar" id="toolbar">
        <button class="btn btn-primary" id="btnPreview" title="Ver captura y elegir opciones">✨ Vista Previa</button>
        <button class="btn btn-pdf" id="btnPdf" title="Guardar selección directamente como PDF">📄 Guardar PDF</button>
        <button class="btn btn-img" id="btnPng" title="Guardar selección directamente como Imagen PNG">🖼️ Guardar Imagen</button>
        <button class="btn btn-cancel" id="btnCancel" title="Cancelar selección">✕</button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(root);
    document.documentElement.appendChild(selectionHost);

    const backdrop = shadow.getElementById('backdrop');
    const hint = shadow.getElementById('hint');
    const box = shadow.getElementById('box');
    const sizeBadge = shadow.getElementById('sizeBadge');
    const toolbar = shadow.getElementById('toolbar');

    let mode = 'idle';
    let activeHandle = null;
    let startX = 0;
    let startY = 0;
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let dragStartRect = null;

    function updateBoxUI() {
      box.style.display = 'block';
      backdrop.style.opacity = '0';
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      sizeBadge.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
      if (rect.y < 36) {
        sizeBadge.style.top = '6px';
        sizeBadge.style.left = '6px';
      } else {
        sizeBadge.style.top = '-28px';
        sizeBadge.style.left = '0';
      }
    }

    function showToolbar() {
      toolbar.style.display = 'flex';
      const tbRect = toolbar.getBoundingClientRect();
      const tbWidth = tbRect.width || 410;
      const tbHeight = tbRect.height || 44;

      let left = rect.x + rect.width - tbWidth;
      if (left < 12) left = 12;
      if (left + tbWidth > window.innerWidth - 12) {
        left = window.innerWidth - tbWidth - 12;
      }

      let top = rect.y + rect.height + 10;
      if (top + tbHeight > window.innerHeight - 12) {
        top = rect.y - tbHeight - 10;
      }
      if (top < 12) {
        top = rect.y + rect.height - tbHeight - 10;
      }

      toolbar.style.left = `${Math.max(10, left)}px`;
      toolbar.style.top = `${Math.max(10, top)}px`;
    }

    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const path = e.composedPath();
      if (path.includes(toolbar)) return;

      const handleEl = path.find((el) => el && el.dataset && el.dataset.handle);
      if (handleEl) {
        mode = 'resizing';
        activeHandle = handleEl.dataset.handle;
        startX = e.clientX;
        startY = e.clientY;
        dragStartRect = { ...rect };
        toolbar.style.display = 'none';
        e.preventDefault();
        return;
      }

      if (path.includes(box) && rect.width > 10 && rect.height > 10) {
        mode = 'moving';
        startX = e.clientX;
        startY = e.clientY;
        dragStartRect = { ...rect };
        toolbar.style.display = 'none';
        e.preventDefault();
        return;
      }

      mode = 'drawing';
      startX = e.clientX;
      startY = e.clientY;
      rect = { x: startX, y: startY, width: 0, height: 0 };
      toolbar.style.display = 'none';
      updateBoxUI();
      e.preventDefault();
    });

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('keydown', onKeyDown, true);

    function onMouseMove(e) {
      if (mode === 'drawing') {
        const curX = Math.max(0, Math.min(window.innerWidth, e.clientX));
        const curY = Math.max(0, Math.min(window.innerHeight, e.clientY));
        rect.x = Math.min(startX, curX);
        rect.y = Math.min(startY, curY);
        rect.width = Math.abs(curX - startX);
        rect.height = Math.abs(curY - startY);
        updateBoxUI();
      } else if (mode === 'moving' && dragStartRect) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        rect.x = Math.max(0, Math.min(window.innerWidth - rect.width, dragStartRect.x + dx));
        rect.y = Math.max(0, Math.min(window.innerHeight - rect.height, dragStartRect.y + dy));
        updateBoxUI();
      } else if (mode === 'resizing' && dragStartRect) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let { x, y, width, height } = dragStartRect;

        if (activeHandle.includes('e')) width = Math.max(20, width + dx);
        if (activeHandle.includes('s')) height = Math.max(20, height + dy);
        if (activeHandle.includes('w')) {
          const newW = Math.max(20, width - dx);
          x += width - newW;
          width = newW;
        }
        if (activeHandle.includes('n')) {
          const newH = Math.max(20, height - dy);
          y += height - newH;
          height = newH;
        }

        rect = { x, y, width, height };
        updateBoxUI();
      }
    }

    function onMouseUp() {
      if (mode === 'drawing' || mode === 'moving' || mode === 'resizing') {
        if (rect.width < 12 || rect.height < 12) {
          box.style.display = 'none';
          backdrop.style.opacity = '1';
          mode = 'idle';
          return;
        }
        mode = 'selected';
        hint.innerHTML = `<span>✨ Ajusta las esquinas o elige cómo guardar tu captura</span> <kbd>ESC</kbd> cancelar`;
        if (defaultAction === 'pdf' || defaultAction === 'png' || defaultAction === 'jpg') {
          confirmPartialCapture(defaultAction);
        } else {
          showToolbar();
        }
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanupListeners();
        removePartialSelectionOverlay();
      } else if (e.key === 'Enter' && rect.width >= 12 && rect.height >= 12) {
        e.preventDefault();
        e.stopPropagation();
        confirmPartialCapture('preview');
      }
    }

    function cleanupListeners() {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('keydown', onKeyDown, true);
    }

    async function confirmPartialCapture(actionType) {
      cleanupListeners();
      const captureRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        dpr: window.devicePixelRatio || 1,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageTitle: document.title || 'captura-parcial',
        pageUrl: window.location.href,
        actionType
      };

      removePartialSelectionOverlay();
      await waitForPaint(80);

      chrome.runtime.sendMessage({
        type: 'EXECUTE_PARTIAL_CAPTURE',
        payload: captureRect
      });
    }

    shadow.getElementById('btnPreview').addEventListener('click', () => confirmPartialCapture('preview'));
    shadow.getElementById('btnPdf').addEventListener('click', () => confirmPartialCapture('pdf'));
    shadow.getElementById('btnPng').addEventListener('click', () => confirmPartialCapture('png'));
    shadow.getElementById('btnCancel').addEventListener('click', () => {
      cleanupListeners();
      removePartialSelectionOverlay();
    });
  }

  function removePartialSelectionOverlay() {
    if (selectionHost && selectionHost.parentNode) {
      selectionHost.parentNode.removeChild(selectionHost);
    }
    const existing = document.getElementById('__captura_pro_overlay_host__');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    selectionHost = null;
  }

  const messageListener = (message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'PING_CONTENT') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'PREPARE_FULL_PAGE') {
      prepareFullPageCapture()
        .then((info) => sendResponse({ ok: true, info }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === 'SCROLL_TO_STEP') {
      scrollToStep(message.stepIndex, message.targetY)
        .then((stepData) => sendResponse({ ok: true, stepData }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message.type === 'RESTORE_FULL_PAGE') {
      cleanupFullPageCapture();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'START_PARTIAL_SELECTION') {
      startPartialSelection(message.defaultAction || 'preview');
      sendResponse({ ok: true });
      return false;
    }

    return false;
  };

  window.__CAPTURA_PRO_CLEANUP_LISTENER__ = messageListener;
  chrome.runtime.onMessage.addListener(messageListener);
})();
