document.addEventListener('DOMContentLoaded', async () => {
  const formatSelector = document.getElementById('formatSelector');
  const pills = formatSelector.querySelectorAll('.pill');
  const btnFullPage = document.getElementById('btnFullPage');
  const btnPartial = document.getElementById('btnPartial');
  const btnVisible = document.getElementById('btnVisible');
  const btnOpenLast = document.getElementById('btnOpenLast');
  const progressBox = document.getElementById('progressBox');
  const progressText = document.getElementById('progressText');
  const progressBarFill = document.getElementById('progressBarFill');
  const errorBox = document.getElementById('errorBox');

  let selectedAction = 'preview';

  // Cargar formato preferido guardado
  try {
    const stored = await chrome.storage.local.get(['preferredAction', 'lastCaptureData']);
    if (stored.preferredAction) {
      selectedAction = stored.preferredAction;
      updateActivePill(selectedAction);
    }
    if (!stored.lastCaptureData) {
      btnOpenLast.style.opacity = '0.45';
    }
  } catch (_) {}

  function updateActivePill(action) {
    pills.forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.action === action);
    });
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      selectedAction = pill.dataset.action;
      updateActivePill(selectedAction);
      chrome.storage.local.set({ preferredAction: selectedAction }).catch(() => {});
    });
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    progressBox.classList.add('hidden');
    setButtonsDisabled(false);
  }

  function hideError() {
    errorBox.classList.add('hidden');
  }

  function setButtonsDisabled(disabled) {
    btnFullPage.disabled = disabled;
    btnPartial.disabled = disabled;
    btnVisible.disabled = disabled;
  }

  // Escuchar progreso de captura completa desde background.js
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'CAPTURE_PROGRESS') {
      progressBox.classList.remove('hidden');
      if (msg.message) {
        progressText.textContent = msg.message;
      }
      if (typeof msg.percent === 'number') {
        progressBarFill.style.width = `${Math.min(100, Math.max(0, msg.percent))}%`;
      }
      if (msg.status === 'done') {
        setTimeout(() => window.close(), 250);
      }
    }
  });

  // 1. Captura de Página Completa
  btnFullPage.addEventListener('click', () => {
    hideError();
    setButtonsDisabled(true);
    progressBox.classList.remove('hidden');
    progressText.textContent = 'Iniciando captura de página completa...';
    progressBarFill.style.width = '5%';

    chrome.runtime.sendMessage(
      { type: 'START_FULL_PAGE_CAPTURE', defaultAction: selectedAction },
      (response) => {
        if (chrome.runtime.lastError) {
          showError(chrome.runtime.lastError.message);
          return;
        }
        if (response && !response.ok) {
          showError(response.error || 'Ocurrió un error al capturar la página completa.');
        }
      }
    );
  });

  // 2. Captura Parcial (Seleccionar Área)
  btnPartial.addEventListener('click', () => {
    hideError();
    setButtonsDisabled(true);

    chrome.runtime.sendMessage(
      { type: 'START_PARTIAL_CAPTURE', defaultAction: selectedAction },
      (response) => {
        if (chrome.runtime.lastError) {
          showError(chrome.runtime.lastError.message);
          return;
        }
        if (response && !response.ok) {
          showError(response.error || 'No se pudo activar el selector parcial en esta página.');
          return;
        }
        // Cerrar el popup para que el usuario pueda seleccionar el área cómodamente
        window.close();
      }
    );
  });

  // 3. Captura del Área Visible
  btnVisible.addEventListener('click', () => {
    hideError();
    setButtonsDisabled(true);
    progressBox.classList.remove('hidden');
    progressText.textContent = 'Capturando área visible...';
    progressBarFill.style.width = '60%';

    chrome.runtime.sendMessage(
      { type: 'START_VISIBLE_CAPTURE', defaultAction: selectedAction },
      (response) => {
        if (chrome.runtime.lastError) {
          showError(chrome.runtime.lastError.message);
          return;
        }
        if (response && !response.ok) {
          showError(response.error || 'No se pudo capturar el área visible.');
          return;
        }
        window.close();
      }
    );
  });

  // Abrir última captura guardada
  btnOpenLast.addEventListener('click', async () => {
    const stored = await chrome.storage.local.get(['lastCaptureData']);
    if (!stored.lastCaptureData) {
      showError('Aún no hay ninguna captura guardada.');
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('preview.html?action=preview') });
    window.close();
  });
});

