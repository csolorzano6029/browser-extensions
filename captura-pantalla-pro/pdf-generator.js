/**
 * Generador nativo de archivos PDF 1.4 en JavaScript puro (sin dependencias externas).
 * Convierte cualquier HTMLCanvasElement en un documento PDF válido en alta resolución,
 * soportando tanto "Página Continua" (sin cortes) como "Paginado A4".
 */
(function (global) {
  function stringToBytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  function dataUrlToBytes(dataUrl) {
    const base64Index = dataUrl.indexOf(';base64,');
    if (base64Index === -1) {
      throw new Error('DataURL inválido para conversión a PDF.');
    }
    const base64 = dataUrl.substring(base64Index + 8);
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Extrae una franja vertical de un canvas hacia un nuevo canvas con fondo blanco
   * (necesario para JPEG que no tiene canal alfa).
   */
  function sliceCanvasToJpeg(sourceCanvas, sy, sHeight, quality = 0.94) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = sourceCanvas.width;
    tempCanvas.height = sHeight;
    const ctx = tempCanvas.getContext('2d');

    // Fondo blanco por si la captura tiene zonas transparentes
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    ctx.drawImage(
      sourceCanvas,
      0,
      sy,
      sourceCanvas.width,
      sHeight,
      0,
      0,
      sourceCanvas.width,
      sHeight
    );

    const jpegDataUrl = tempCanvas.toDataURL('image/jpeg', quality);
    return {
      jpegBytes: dataUrlToBytes(jpegDataUrl),
      pixelWidth: tempCanvas.width,
      pixelHeight: tempCanvas.height
    };
  }

  /**
   * Construye el binario PDF 1.4 a partir de una lista de páginas preparadas
   */
  function buildPdfBinary(pages) {
    const chunks = [];
    let currentOffset = 0;

    function pushBytes(uint8) {
      chunks.push(uint8);
      currentOffset += uint8.byteLength;
    }

    function pushAscii(str) {
      pushBytes(stringToBytes(str));
    }

    const totalObjects = 2 + pages.length * 3;
    const offsets = new Array(totalObjects + 1).fill(0);

    // Cabecera PDF 1.4 con comentario binario de 4 bytes altos
    pushAscii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    // Objeto 1: Catalog
    offsets[1] = currentOffset;
    pushAscii('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // Objeto 2: Pages
    const kidsRefs = pages.map((_, idx) => `${3 + idx * 3} 0 R`).join(' ');
    offsets[2] = currentOffset;
    pushAscii(`2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${pages.length} >>\nendobj\n`);

    // Objetos por cada página (Page, Content Stream, Image XObject)
    pages.forEach((p, idx) => {
      const pageObjId = 3 + idx * 3;
      const contentObjId = 4 + idx * 3;
      const imageObjId = 5 + idx * 3;

      const pageW = p.pageWidthPt.toFixed(2);
      const pageH = p.pageHeightPt.toFixed(2);
      const drawW = p.drawWidthPt.toFixed(2);
      const drawH = p.drawHeightPt.toFixed(2);
      const drawX = p.drawXPt.toFixed(2);
      const drawY = p.drawYPt.toFixed(2);

      // Page Object
      offsets[pageObjId] = currentOffset;
      pushAscii(
        `${pageObjId} 0 obj\n` +
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
          `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageObjId} 0 R >> >> ` +
          `/Contents ${contentObjId} 0 R >>\n` +
          `endobj\n`
      );

      // Content Stream Object
      const streamCommands = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Im0 Do\nQ\n`;
      offsets[contentObjId] = currentOffset;
      pushAscii(
        `${contentObjId} 0 obj\n` +
          `<< /Length ${streamCommands.length} >>\n` +
          `stream\n` +
          streamCommands +
          `endstream\n` +
          `endobj\n`
      );

      // Image XObject (DCTDecode = JPEG nativo en PDF)
      offsets[imageObjId] = currentOffset;
      pushAscii(
        `${imageObjId} 0 obj\n` +
          `<< /Type /XObject /Subtype /Image ` +
          `/Width ${p.pixelWidth} /Height ${p.pixelHeight} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${p.jpegBytes.byteLength} >>\n` +
          `stream\n`
      );
      pushBytes(p.jpegBytes);
      pushAscii(`\nendstream\nendobj\n`);
    });

    // Tabla XREF
    const xrefStart = currentOffset;
    pushAscii(`xref\n0 ${totalObjects + 1}\n`);
    pushAscii(`0000000000 65535 f \n`);
    for (let i = 1; i <= totalObjects; i++) {
      const paddedOffset = String(offsets[i]).padStart(10, '0');
      pushAscii(`${paddedOffset} 00000 n \n`);
    }

    // Trailer
    pushAscii(
      `trailer\n` +
        `<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` +
        `startxref\n` +
        `${xrefStart}\n` +
        `%%EOF\n`
    );

    return new Blob(chunks, { type: 'application/pdf' });
  }

  /**
   * Genera un Blob PDF a partir de un HTMLCanvasElement.
   * @param {HTMLCanvasElement} canvas Canvas con la captura completa o parcial
   * @param {Object} options { layout: 'continuous' | 'a4', quality: 0.94 }
   * @returns {Blob} Blob con mime-type application/pdf
   */
  function generatePdfFromCanvas(canvas, options = {}) {
    const layout = options.layout || 'continuous'; // 'continuous' o 'a4'
    const quality = options.quality || 0.94;

    const totalPxW = canvas.width;
    const totalPxH = canvas.height;

    if (!totalPxW || !totalPxH) {
      throw new Error('El canvas está vacío.');
    }

    const pages = [];

    if (layout === 'a4') {
      // Formato A4 estándar (595.28 x 841.89 pt) con margen limpio
      const a4WidthPt = 595.28;
      const a4HeightPt = 841.89;
      const marginPt = 18;
      const usableWidthPt = a4WidthPt - marginPt * 2;
      const usableHeightPt = a4HeightPt - marginPt * 2;

      const scalePtPerPx = usableWidthPt / totalPxW;
      const maxSlicePxH = Math.max(1, Math.floor(usableHeightPt / scalePtPerPx));

      let sy = 0;
      while (sy < totalPxH) {
        const slicePxH = Math.min(maxSlicePxH, totalPxH - sy);
        const sliceData = sliceCanvasToJpeg(canvas, sy, slicePxH, quality);
        const drawHeightPt = slicePxH * scalePtPerPx;
        // En PDF el origen Y=0 está abajo, por lo que alineamos el contenido hacia el borde superior de la página A4
        const drawYPt = a4HeightPt - marginPt - drawHeightPt;

        pages.push({
          ...sliceData,
          pageWidthPt: a4WidthPt,
          pageHeightPt: a4HeightPt,
          drawWidthPt: usableWidthPt,
          drawHeightPt,
          drawXPt: marginPt,
          drawYPt
        });

        sy += slicePxH;
      }
    } else {
      // Formato continuo: una sola página ajustada exactamente a la proporción de la captura
      // (Si supera los 12,000 puntos de altura máxima de PDF, se divide en bloques largos continuos)
      const baseWidthPt = Math.min(840, Math.max(595.28, totalPxW * 0.5));
      const scalePtPerPx = baseWidthPt / totalPxW;
      const maxPageHeightPt = 12000;
      const maxSlicePxH = Math.max(1, Math.floor(maxPageHeightPt / scalePtPerPx));

      let sy = 0;
      while (sy < totalPxH) {
        const slicePxH = Math.min(maxSlicePxH, totalPxH - sy);
        const sliceData = sliceCanvasToJpeg(canvas, sy, slicePxH, quality);
        const sliceHeightPt = slicePxH * scalePtPerPx;

        pages.push({
          ...sliceData,
          pageWidthPt: baseWidthPt,
          pageHeightPt: sliceHeightPt,
          drawWidthPt: baseWidthPt,
          drawHeightPt: sliceHeightPt,
          drawXPt: 0,
          drawYPt: 0
        });

        sy += slicePxH;
      }
    }

    return buildPdfBinary(pages);
  }

  global.PdfGenerator = {
    generatePdfFromCanvas,
    buildPdfBinary
  };
})(typeof window !== 'undefined' ? window : globalThis);

