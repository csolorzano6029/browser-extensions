document.addEventListener('DOMContentLoaded', async () => {
  const topbarEl = document.getElementById('topbar');
  const floatingMiniBarEl = document.getElementById('floatingMiniBar');
  const btnHideBanner = document.getElementById('btnHideBanner');
  const btnShowBanner = document.getElementById('btnShowBanner');
  const btnClosePreview = document.getElementById('btnClosePreview');
  const btnMiniExit = document.getElementById('btnMiniExit');

  const pageTitleEl = document.getElementById('pageTitle');
  const modeBadgeEl = document.getElementById('modeBadge');
  const dimensionsInfoEl = document.getElementById('dimensionsInfo');
  const sourceUrlEl = document.getElementById('sourceUrl');
  const loadingStateEl = document.getElementById('loadingState');
  const loadingTextEl = document.getElementById('loadingText');
  const canvasWrapperEl = document.getElementById('canvasWrapper');
  const canvas = document.getElementById('captureCanvas');
  const ctx = canvas.getContext('2d');

  // Controles de Zoom
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomFit = document.getElementById('btnZoomFit');
  const btnZoom100 = document.getElementById('btnZoom100');
  const zoomLabel = document.getElementById('zoomLabel');

  // Controles de Recorte adicional en vista previa
  const btnToggleCrop = document.getElementById('btnToggleCrop');
  const btnApplyCrop = document.getElementById('btnApplyCrop');
  const btnResetCrop = document.getElementById('btnResetCrop');
  const cropOverlay = document.getElementById('cropOverlay');
  const cropBox = document.getElementById('cropBox');
  const cropSizeLabel = document.getElementById('cropSizeLabel');

  // Controles de Exportación
  const pdfLayoutSelect = document.getElementById('pdfLayoutSelect');
  const btnDownloadPdf = document.getElementById('btnDownloadPdf');
  const btnDownloadPng = document.getElementById('btnDownloadPng');
  const btnDownloadJpg = document.getElementById('btnDownloadJpg');
  const btnCopyClipboard = document.getElementById('btnCopyClipboard');
  const toastEl = document.getElementById('toast');

  let captureData = null;
  let originalBackupCanvas = null;
  let currentZoomMode = 'fit';
  let currentZoomPercent = 100;

  let isCropping = false;
  let isDraggingCrop = false;
  let cropStart = { x: 0, y: 0 };
  let cropRectCss = { x: 0, y: 0, width: 0, height: 0 };

  function showToast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.style.borderColor = isError ? 'rgba(239, 68, 68, 0.6)' : 'rgba(56, 189, 248, 0.5)';
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3200);
  }

  /**
   * Cierra la pestaña de vista previa y regresa automáticamente a la pestaña original
   */
  async function exitPreview() {
    try {
      if (captureData && captureData.sourceTabId && chrome.tabs) {
        await chrome.tabs.update(captureData.sourceTabId, { active: true }).catch(() => {});
      }
    } catch (_) {}
    window.close();
  }

  // Ocultar / Mostrar el banner superior
  btnHideBanner.addEventListener('click', () => {
    topbarEl.classList.add('hidden');
    floatingMiniBarEl.classList.remove('hidden');
  });

  btnShowBanner.addEventListener('click', () => {
    floatingMiniBarEl.classList.add('hidden');
    topbarEl.classList.remove('hidden');
  });

  btnClosePreview.addEventListener('click', exitPreview);
  btnMiniExit.addEventListener('click', exitPreview);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isCropping) {
        isCropping = false;
        btnToggleCrop.classList.remove('active');
        cropOverlay.classList.add('hidden');
        btnApplyCrop.classList.add('hidden');
      } else {
        exitPreview();
      }
    }
  });

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo cargar un fragmento de imagen.'));
      img.src = dataUrl;
    });
  }

  function sanitizeFilename(name) {
    const clean = (name || 'captura')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 65)
      .replace(/^-+|-+$/g, '');
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `${clean || 'captura'}_${dateStr}`;
  }

  function updateDimensionsLabel(sliceCount) {
    const extra = sliceCount && sliceCount > 1 ? ` (${sliceCount} secciones unidas)` : '';
    dimensionsInfoEl.textContent = `${canvas.width} × ${canvas.height} px${extra}`;
  }

  function applyZoom() {
    if (!canvas.width) return;
    const maxWorkspaceWidth = Math.max(320, window.innerWidth - 80);
    const dpr = window.devicePixelRatio || 1;
    const naturalCssWidth = Math.round(canvas.width / dpr);

    if (currentZoomMode === 'fit') {
      const displayW = Math.min(maxWorkspaceWidth, naturalCssWidth);
      canvasWrapperEl.style.width = `${displayW}px`;
      const pct = Math.round((displayW / naturalCssWidth) * 100);
      currentZoomPercent = pct;
      zoomLabel.textContent = `${pct}%`;
    } else {
      const displayW = Math.round((naturalCssWidth * currentZoomPercent) / 100);
      canvasWrapperEl.style.width = `${displayW}px`;
      zoomLabel.textContent = `${currentZoomPercent}%`;
    }
  }

  function cloneCanvas(srcCanvas) {
    const copy = document.createElement('canvas');
    copy.width = srcCanvas.width;
    copy.height = srcCanvas.height;
    copy.getContext('2d').drawImage(srcCanvas, 0, 0);
    return copy;
  }

  /**
   * Renderiza la captura almacenada (Completa, Parcial o Visible) en el Canvas principal
   */
  async function renderCapture(data) {
    const modeLabels = {
      full: '📜 Página Completa',
      partial: '✂️ Captura Parcial',
      visible: '🖥️ Área Visible'
    };

    pageTitleEl.textContent = data.pageTitle || 'Captura de pantalla';
    modeBadgeEl.textContent = modeLabels[data.mode] || 'Captura';

    if (data.pageUrl) {
      sourceUrlEl.href = data.pageUrl;
      sourceUrlEl.textContent = new URL(data.pageUrl).hostname + ' ↗';
    } else {
      sourceUrlEl.style.display = 'none';
    }

    if (data.mode === 'full') {
      const slices = data.slices || [];
      if (!slices.length) {
        throw new Error('No se encontraron secciones en la captura completa.');
      }

      loadingTextEl.textContent = `Uniendo ${slices.length} secciones de la página...`;
      const firstImg = await loadImage(slices[0].dataUrl);
      const scale = firstImg.width / data.viewportWidth;

      const clipRect = data.clipRect || {
        x: 0,
        y: 0,
        width: data.viewportWidth,
        height: data.viewportHeight
      };

      const lastSlice = slices[slices.length - 1];
      const finalCssHeight = Math.max(
        data.viewportHeight,
        lastSlice.actualY + data.viewportHeight
      );

      const finalWidth = firstImg.width;
      const finalHeight = Math.max(firstImg.height, Math.round(finalCssHeight * scale));

      canvas.width = finalWidth;
      canvas.height = finalHeight;

      // 1. Dibujar la primera captura completa arriba del todo
      ctx.drawImage(firstImg, 0, 0, finalWidth, firstImg.height);

      // 2. Extender el color de fondo inferior para barras laterales fijas (ej. menú izquierdo de Gemini)
      if (slices.length > 1 && finalHeight > firstImg.height) {
        ctx.drawImage(
          firstImg,
          0,
          Math.max(0, firstImg.height - 3),
          finalWidth,
          2,
          0,
          firstImg.height,
          finalWidth,
          finalHeight - firstImg.height
        );
      }

      // 3. Unir todas las secciones siguientes en su coordenada exacta
      for (let i = 1; i < slices.length; i++) {
        const slice = slices[i];
        const img = await loadImage(slice.dataUrl);

        if (data.isElementScroll) {
          const sx = Math.max(0, Math.round(clipRect.x * scale));
          const sy = Math.max(0, Math.round(clipRect.y * scale));
          const sw = Math.min(img.width - sx, Math.round(clipRect.width * scale));
          const sh =
            i === slices.length - 1
              ? img.height - sy
              : Math.min(img.height - sy, Math.round(clipRect.height * scale));

          const dx = sx;
          const dy = Math.round((clipRect.y + slice.actualY) * scale);

          if (sw > 0 && sh > 0) {
            ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw, sh);
          }
        } else {
          const destY = Math.round(slice.actualY * scale);
          ctx.drawImage(img, 0, destY, finalWidth, img.height);
        }
      }

      originalBackupCanvas = cloneCanvas(canvas);
      updateDimensionsLabel(slices.length);
    } else if (data.mode === 'partial') {
      loadingTextEl.textContent = 'Recortando área seleccionada...';
      const img = await loadImage(data.dataUrl);
      const r = data.cropRect;
      const scaleX = img.width / r.viewportWidth;
      const scaleY = img.height / r.viewportHeight;

      const sx = Math.max(0, Math.round(r.x * scaleX));
      const sy = Math.max(0, Math.round(r.y * scaleY));
      const sw = Math.min(img.width - sx, Math.max(1, Math.round(r.width * scaleX)));
      const sh = Math.min(img.height - sy, Math.max(1, Math.round(r.height * scaleY)));

      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      originalBackupCanvas = cloneCanvas(canvas);
      updateDimensionsLabel(1);
    } else {
      loadingTextEl.textContent = 'Cargando captura visible...';
      const img = await loadImage(data.dataUrl);
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      originalBackupCanvas = cloneCanvas(canvas);
      updateDimensionsLabel(1);
    }

    loadingStateEl.classList.add('hidden');
    canvasWrapperEl.classList.remove('hidden');
    applyZoom();
  }

  /**
   * Descarga un Blob usando la API de descargas de Google Chrome
   */
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    if (chrome && chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: true
        },
        () => {
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
      );
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  /**
   * Exportar y guardar como PDF
   */
  function downloadAsPdf() {
    try {
      const layout = pdfLayoutSelect.value || 'continuous';
      showToast('Generando documento PDF en alta resolución...');
      const pdfBlob = window.PdfGenerator.generatePdfFromCanvas(canvas, {
        layout,
        quality: 0.94
      });
      const filename = `${sanitizeFilename(captureData?.pageTitle)}.pdf`;
      triggerBlobDownload(pdfBlob, filename);
      showToast('✅ PDF generado. Elige dónde guardarlo.');
    } catch (err) {
      showToast(`Error al generar PDF: ${err.message}`, true);
    }
  }

  /**
   * Exportar y guardar como Imagen (PNG o JPG)
   */
  function downloadAsImage(format = 'png') {
    const isJpg = format === 'jpg' || format === 'jpeg';
    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const ext = isJpg ? 'jpg' : 'png';

    let targetCanvas = canvas;
    if (isJpg) {
      targetCanvas = document.createElement('canvas');
      targetCanvas.width = canvas.width;
      targetCanvas.height = canvas.height;
      const tCtx = targetCanvas.getContext('2d');
      tCtx.fillStyle = '#ffffff';
      tCtx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
      tCtx.drawImage(canvas, 0, 0);
    }

    targetCanvas.toBlob(
      (blob) => {
        if (!blob) {
          showToast('Error al exportar la imagen.', true);
          return;
        }
        const filename = `${sanitizeFilename(captureData?.pageTitle)}.${ext}`;
        triggerBlobDownload(blob, filename);
        showToast(`✅ Imagen ${ext.toUpperCase()} lista para guardar.`);
      },
      mimeType,
      isJpg ? 0.94 : undefined
    );
  }

  /**
   * Copiar captura al portapapeles
   */
  async function copyToClipboard() {
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('📋 ¡Imagen copiada al portapapeles!');
    } catch (err) {
      showToast('No se pudo copiar al portapapeles: ' + err.message, true);
    }
  }

  // Eventos de Zoom
  btnZoomFit.addEventListener('click', () => {
    currentZoomMode = 'fit';
    applyZoom();
  });

  btnZoom100.addEventListener('click', () => {
    currentZoomMode = 'custom';
    currentZoomPercent = 100;
    applyZoom();
  });

  btnZoomIn.addEventListener('click', () => {
    currentZoomMode = 'custom';
    currentZoomPercent = Math.min(300, currentZoomPercent + 20);
    applyZoom();
  });

  btnZoomOut.addEventListener('click', () => {
    currentZoomMode = 'custom';
    currentZoomPercent = Math.max(15, currentZoomPercent - 20);
    applyZoom();
  });

  window.addEventListener('resize', () => {
    if (currentZoomMode === 'fit') applyZoom();
  });

  // Eventos de Recorte interactivo dentro de la vista previa
  btnToggleCrop.addEventListener('click', () => {
    isCropping = !isCropping;
    btnToggleCrop.classList.toggle('active', isCropping);
    cropOverlay.classList.toggle('hidden', !isCropping);
    cropBox.style.display = 'none';
    btnApplyCrop.classList.add('hidden');
    if (isCropping) {
      showToast('✂️ Arrastra sobre la imagen para seleccionar el recorte.');
    }
  });

  cropOverlay.addEventListener('mousedown', (e) => {
    if (!isCropping || e.button !== 0) return;
    const bounds = cropOverlay.getBoundingClientRect();
    isDraggingCrop = true;
    cropStart = {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top
    };
    cropRectCss = { x: cropStart.x, y: cropStart.y, width: 0, height: 0 };
    cropBox.style.display = 'block';
    btnApplyCrop.classList.add('hidden');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingCrop) return;
    const bounds = cropOverlay.getBoundingClientRect();
    const curX = Math.max(0, Math.min(bounds.width, e.clientX - bounds.left));
    const curY = Math.max(0, Math.min(bounds.height, e.clientY - bounds.top));

    cropRectCss.x = Math.min(cropStart.x, curX);
    cropRectCss.y = Math.min(cropStart.y, curY);
    cropRectCss.width = Math.abs(curX - cropStart.x);
    cropRectCss.height = Math.abs(curY - cropStart.y);

    cropBox.style.left = `${cropRectCss.x}px`;
    cropBox.style.top = `${cropRectCss.y}px`;
    cropBox.style.width = `${cropRectCss.width}px`;
    cropBox.style.height = `${cropRectCss.height}px`;

    const scale = canvas.width / bounds.width;
    const pxW = Math.round(cropRectCss.width * scale);
    const pxH = Math.round(cropRectCss.height * scale);
    cropSizeLabel.textContent = `${pxW} × ${pxH} px`;
  });

  window.addEventListener('mouseup', () => {
    if (!isDraggingCrop) return;
    isDraggingCrop = false;
    if (cropRectCss.width > 12 && cropRectCss.height > 12) {
      btnApplyCrop.classList.remove('hidden');
    } else {
      cropBox.style.display = 'none';
      btnApplyCrop.classList.add('hidden');
    }
  });

  btnApplyCrop.addEventListener('click', () => {
    const bounds = cropOverlay.getBoundingClientRect();
    if (!bounds.width || cropRectCss.width < 10) return;

    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;

    const sx = Math.max(0, Math.round(cropRectCss.x * scaleX));
    const sy = Math.max(0, Math.round(cropRectCss.y * scaleY));
    const sw = Math.min(canvas.width - sx, Math.round(cropRectCss.width * scaleX));
    const sh = Math.min(canvas.height - sy, Math.round(cropRectCss.height * scaleY));

    const temp = cloneCanvas(canvas);
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(temp, sx, sy, sw, sh, 0, 0, sw, sh);

    isCropping = false;
    btnToggleCrop.classList.remove('active');
    cropOverlay.classList.add('hidden');
    btnApplyCrop.classList.add('hidden');
    btnResetCrop.classList.remove('hidden');

    updateDimensionsLabel(1);
    applyZoom();
    showToast('✅ Recorte aplicado a la captura.');
  });

  btnResetCrop.addEventListener('click', () => {
    if (!originalBackupCanvas) return;
    canvas.width = originalBackupCanvas.width;
    canvas.height = originalBackupCanvas.height;
    ctx.drawImage(originalBackupCanvas, 0, 0);
    btnResetCrop.classList.add('hidden');
    updateDimensionsLabel(captureData?.slices?.length || 1);
    applyZoom();
    showToast('↩ Captura original restaurada.');
  });

  // Eventos de descarga
  btnDownloadPdf.addEventListener('click', downloadAsPdf);
  btnDownloadPng.addEventListener('click', () => downloadAsImage('png'));
  btnDownloadJpg.addEventListener('click', () => downloadAsImage('jpg'));
  btnCopyClipboard.addEventListener('click', copyToClipboard);

  // Inicialización principal
  try {
    const stored = await chrome.storage.local.get(['lastCaptureData']);
    if (!stored.lastCaptureData) {
      loadingTextEl.textContent = 'No se encontró ninguna captura reciente.';
      return;
    }

    captureData = stored.lastCaptureData;
    await renderCapture(captureData);

    const params = new URLSearchParams(window.location.search);
    const autoAction = params.get('action') || captureData.actionType || 'preview';

    if (autoAction === 'pdf') {
      setTimeout(() => downloadAsPdf(), 250);
    } else if (autoAction === 'png') {
      setTimeout(() => downloadAsImage('png'), 250);
    } else if (autoAction === 'jpg') {
      setTimeout(() => downloadAsImage('jpg'), 250);
    }
  } catch (err) {
    loadingTextEl.textContent = `Error al procesar la captura: ${err.message}`;
    showToast(err.message, true);
  }
});
