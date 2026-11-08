// Service Worker para Google Chrome (Manifest V3) — Captura Pro

let lastCaptureTimestamp = 0;
const MIN_CAPTURE_INTERVAL_MS = 540; // Respeta el límite MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND de Chrome

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verifica si la URL de la pestaña es una página interna restringida de Google Chrome
 */
function isRestrictedChromeUrl(url = '') {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('chrome.google.com/webstore')
  );
}

/**
 * Captura la pestaña visible respetando la cuota de llamadas por segundo de Google Chrome
 */
async function safeCaptureVisibleTab(windowId, retries = 4) {
  const now = Date.now();
  const elapsed = now - lastCaptureTimestamp;
  if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
    await sleep(MIN_CAPTURE_INTERVAL_MS - elapsed);
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      lastCaptureTimestamp = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
        format: 'png'
      });
      return dataUrl;
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (attempt < retries - 1 && (msg.includes('MAX_CAPTURE_VISIBLE_TAB') || msg.includes('quota') || msg.includes('activeTab'))) {
        await sleep(650 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Garantiza que content.js esté inyectado y activo en la pestaña actual
 */
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    if (res && res.ok) return true;
  } catch (_) {
    // No está inyectado aún; lo inyectamos dinámicamente
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });

  await sleep(60);
  return true;
}

/**
 * Envía actualizaciones de progreso al popup (si sigue abierto)
 */
function broadcastProgress(payload) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', ...payload }).catch(() => {});
}

/**
 * Ejecuta la captura de Página Completa (con scroll automático)
 */
async function runFullPageCapture(tab, defaultAction = 'preview') {
  if (isRestrictedChromeUrl(tab.url)) {
    throw new Error(
      'Google Chrome no permite ejecutar extensiones en páginas internas (chrome:// o Chrome Web Store). Prueba en cualquier sitio web normal.'
    );
  }

  await ensureContentScript(tab.id);

  broadcastProgress({
    status: 'preparing',
    percent: 5,
    message: 'Preparando página para captura completa...'
  });

  const prepResponse = await chrome.tabs.sendMessage(tab.id, { type: 'PREPARE_FULL_PAGE' });
  if (!prepResponse || !prepResponse.ok) {
    throw new Error((prepResponse && prepResponse.error) || 'No se pudo preparar la página.');
  }

  const info = prepResponse.info;
  const slices = [];

  try {
    const totalSteps = info.steps.length;

    for (let i = 0; i < totalSteps; i++) {
      const targetY = info.steps[i];
      const percent = Math.round(((i + 1) / totalSteps) * 90);

      broadcastProgress({
        status: 'capturing',
        current: i + 1,
        total: totalSteps,
        percent,
        message: `Capturando sección ${i + 1} de ${totalSteps}...`
      });

      const stepRes = await chrome.tabs.sendMessage(tab.id, {
        type: 'SCROLL_TO_STEP',
        stepIndex: i,
        targetY
      });

      if (!stepRes || !stepRes.ok) {
        throw new Error((stepRes && stepRes.error) || `Error al desplazar a la sección ${i + 1}.`);
      }

      const { actualY, viewportWidth, viewportHeight, dpr } = stepRes.stepData;
      const dataUrl = await safeCaptureVisibleTab(tab.windowId);

      slices.push({
        dataUrl,
        actualY,
        viewportWidth,
        viewportHeight,
        dpr
      });
    }
  } finally {
    // Siempre restaurar el scroll y estilos originales de la página
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_FULL_PAGE' });
    } catch (_) {}
  }

  broadcastProgress({
    status: 'processing',
    percent: 98,
    message: 'Uniendo capturas en alta resolución...'
  });

  const captureRecord = {
    id: `cap_${Date.now()}`,
    createdAt: Date.now(),
    mode: 'full',
    actionType: defaultAction,
    pageTitle: info.pageTitle || tab.title || 'captura-completa',
    pageUrl: info.pageUrl || tab.url || '',
    viewportWidth: info.viewportWidth,
    viewportHeight: info.viewportHeight,
    totalHeight: info.totalHeight,
    dpr: info.dpr,
    slices
  };

  await chrome.storage.local.set({ lastCaptureData: captureRecord });

  broadcastProgress({
    status: 'done',
    percent: 100,
    message: '¡Captura completada!'
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?action=${encodeURIComponent(defaultAction)}`)
  });
}

/**
 * Ejecuta la captura del Área Visible actual
 */
async function runVisibleAreaCapture(tab, defaultAction = 'preview') {
  if (isRestrictedChromeUrl(tab.url)) {
    throw new Error(
      'Google Chrome no permite capturar páginas internas (chrome:// o Chrome Web Store). Prueba en cualquier sitio web normal.'
    );
  }

  const dataUrl = await safeCaptureVisibleTab(tab.windowId);

  const captureRecord = {
    id: `cap_${Date.now()}`,
    createdAt: Date.now(),
    mode: 'visible',
    actionType: defaultAction,
    pageTitle: tab.title || 'captura-visible',
    pageUrl: tab.url || '',
    dataUrl
  };

  await chrome.storage.local.set({ lastCaptureData: captureRecord });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?action=${encodeURIComponent(defaultAction)}`)
  });
}

/**
 * Inicia el modo de selección parcial en la página activa
 */
async function startPartialSelectionOnTab(tab, defaultAction = 'preview') {
  if (isRestrictedChromeUrl(tab.url)) {
    throw new Error(
      'Google Chrome no permite ejecutar el selector de recorte en páginas internas (chrome:// o Chrome Web Store). Prueba en cualquier página web.'
    );
  }

  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, {
    type: 'START_PARTIAL_SELECTION',
    defaultAction
  });
}

/**
 * Procesa la captura una vez que el usuario seleccionó el rectángulo parcial
 */
async function handleExecutePartialCapture(senderTab, payload) {
  const dataUrl = await safeCaptureVisibleTab(senderTab.windowId);

  const captureRecord = {
    id: `cap_${Date.now()}`,
    createdAt: Date.now(),
    mode: 'partial',
    actionType: payload.actionType || 'preview',
    pageTitle: payload.pageTitle || senderTab.title || 'captura-parcial',
    pageUrl: payload.pageUrl || senderTab.url || '',
    dataUrl,
    cropRect: {
      x: payload.x,
      y: payload.y,
      width: payload.width,
      height: payload.height,
      dpr: payload.dpr || 1,
      viewportWidth: payload.viewportWidth,
      viewportHeight: payload.viewportHeight
    }
  };

  await chrome.storage.local.set({ lastCaptureData: captureRecord });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?action=${encodeURIComponent(captureRecord.actionType)}`)
  });
}

/**
 * Listener de mensajes desde popup.js y content.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'START_FULL_PAGE_CAPTURE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab) throw new Error('No se encontró una pestaña activa.');
        return runFullPageCapture(tab, message.defaultAction || 'preview');
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'START_PARTIAL_CAPTURE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab) throw new Error('No se encontró una pestaña activa.');
        return startPartialSelectionOnTab(tab, message.defaultAction || 'preview');
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'START_VISIBLE_CAPTURE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (!tab) throw new Error('No se encontró una pestaña activa.');
        return runVisibleAreaCapture(tab, message.defaultAction || 'preview');
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'EXECUTE_PARTIAL_CAPTURE') {
    const tab = sender && sender.tab;
    if (!tab) {
      sendResponse({ ok: false, error: 'No se identificó la pestaña de origen.' });
      return false;
    }
    handleExecutePartialCapture(tab, message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

/**
 * Atajos de teclado rápidos (Alt+Shift+F y Alt+Shift+S)
 */
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (command === 'capture-full-page') {
      await runFullPageCapture(tab, 'preview');
    } else if (command === 'capture-partial-area') {
      await startPartialSelectionOnTab(tab, 'preview');
    }
  } catch (err) {
    console.warn('Error ejecutando comando:', err);
  }
});

