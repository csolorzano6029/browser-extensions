(() => {
  if (window.__CAPTURA_PRO_CONTENT_LOADED__) {
    return;
  }
  window.__CAPTURA_PRO_CONTENT_LOADED__ = true;

  let fullPageState = null;
  let selectionHost = null;

  /**
   * Encuentra si la página usa un contenedor interno con scroll en lugar del body/html
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

    if (docScrollHeight > window.innerHeight + 25) {
      return { type: 'window', element: docEl, totalHeight: docScrollHeight };
    }

    // Buscar si es una SPA con un contenedor interno scrollable grande
    let bestCandidate = null;
    let maxScrollHeight = docScrollHeight;
    const candidates = document.querySelectorAll('main, [role="main"], div, section, article');

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5) {
        continue;
      }
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
        el.scrollHeight > el.clientHeight + 30 &&
        el.scrollHeight > maxScrollHeight
      ) {
        maxScrollHeight = el.scrollHeight;
        bestCandidate = el;
      }
    }

    if (bestCandidate) {
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
  function waitForPaint(delayMs = 80) {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, delayMs);
        });
      });
    });
  }

  /**
   * Detecta y guarda los elementos fixed/sticky para ocultarlos después de la primera captura
   */
  function collectFixedAndStickyElements(excludeNode) {
    const fixedEls = [];
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (excludeNode && (el === excludeNode || excludeNode.contains(el))) {
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0) {
          fixedEls.push({
            el,
            origVisibility: el.style.getPropertyValue('visibility'),
            origVisibilityPriority: el.style.getPropertyPriority('visibility')
          });
        }
      }
    }
    return fixedEls;
  }

  function setFixedElementsHidden(fixedEls, hidden) {
    if (!fixedEls) return;
    for (const item of fixedEls) {
      if (!item.el || !item.el.isConnected) continue;
      if (hidden) {
        item.el.style.setProperty('visibility', 'hidden', 'important');
      } else {
        if (item.origVisibility) {
          item.el.style.setProperty('visibility', item.origVisibility, item.origVisibilityPriority || '');
        } else {
          item.el.style.removeProperty('visibility');
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
      html, body {
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

    // Ir al inicio de la página para capturar el encabezado correctamente
    if (isElementScroll) {
      scrollEl.scrollTo(0, 0);
    } else {
      window.scrollTo(0, 0);
    }

    await waitForPaint(150);

    const fixedElements = collectFixedAndStickyElements(scrollEl);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // Recalcular altura total tras estar arriba
    const rawTotalHeight = isElementScroll
      ? Math.max(scrollEl.scrollHeight, viewportHeight)
      : Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.offsetHeight : 0,
          document.documentElement ? document.documentElement.offsetHeight : 0,
          viewportHeight
        );

    // Límite seguro para evitar desbordar el tamaño máximo de Canvas del navegador (~32,767 px físicos)
    const maxSafeCssHeight = Math.floor(30000 / dpr);
    const totalHeight = Math.min(rawTotalHeight, maxSafeCssHeight);

    const steps = [];
    let y = 0;
    while (y < totalHeight) {
      steps.push(y);
      y += viewportHeight;
      if (y >= totalHeight) {
        break;
      }
    }
    if (steps.length === 0) {
      steps.push(0);
    }

    fullPageState = {
      styleEl,
      isElementScroll,
      scrollEl,
      origX,
      origY,
      fixedElements,
      viewportWidth,
      viewportHeight,
      totalHeight,
      dpr,
      steps
    };

    return {
      viewportWidth,
      viewportHeight,
      totalHeight,
      dpr,
      steps,
      pageTitle: document.title || 'captura-pagina',
      pageUrl: window.location.href
    };
  }

  /**
   * Desplaza la página al paso indicado y devuelve la posición real alcanzada
   */
  async function scrollToStep(stepIndex, targetY) {
    if (!fullPageState) {
      throw new Error('El estado de captura completa no está inicializado.');
    }

    const { isElementScroll, scrollEl, fixedElements, viewportWidth, viewportHeight, totalHeight, dpr } =
      fullPageState;

    // Ocultar elementos fixed/sticky a partir del segundo fragmento para que no se repitan
    if (stepIndex > 0) {
      setFixedElementsHidden(fixedElements, true);
    } else {
      setFixedElementsHidden(fixedElements, false);
    }

    if (isElementScroll) {
      scrollEl.scrollTo(0, targetY);
    } else {
      window.scrollTo(0, targetY);
    }

    await waitForPaint(120);

    const actualY = isElementScroll ? scrollEl.scrollTop : window.scrollY;

    return {
      actualY,
      viewportWidth: window.innerWidth || viewportWidth,
      viewportHeight: window.innerHeight || viewportHeight,
      totalHeight,
      dpr: window.devicePixelRatio || dpr
    };
  }

  /**
   * Restaura todos los estilos y la posición original de scroll
   */
  function cleanupFullPageCapture() {
    if (!fullPageState) return;
    const { styleEl, isElementScroll, scrollEl, origX, origY, fixedElements } = fullPageState;

    try {
      setFixedElementsHidden(fixedElements, false);
    } catch (_) {}

    try {
      if (styleEl && styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
    } catch (_) {}

    try {
      if (isElementScroll && scrollEl) {
        scrollEl.scrollTo(origX, origY);
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

    let mode = 'idle'; // 'drawing' | 'moving' | 'resizing' | 'selected'
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

      // Nueva selección
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
        actionType // 'preview' | 'pdf' | 'png' | 'jpg'
      };

      // Ocultar completamente el overlay antes de tomar la foto de la pestaña
      removePartialSelectionOverlay();
      await waitForPaint(70);

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

  /**
   * Listener principal de mensajes desde background.js o popup.js
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
  });
})();
