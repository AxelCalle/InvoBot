const { Jimp } = require('jimp');
const jsQR = require('jsqr');
const logger = require('../utils/logger');

/**
 * Intenta decodificar un código QR de una imagen (buffer JPEG/PNG).
 * Retorna el texto del QR o null si no encuentra ninguno.
 */
async function decodeQRFromImage(buffer) {
  try {
    const image = await Jimp.fromBuffer(buffer);
    const { data, width, height } = image.bitmap;

    // jsQR espera un Uint8ClampedArray RGBA
    const pixels = new Uint8ClampedArray(data);
    const result = jsQR(pixels, width, height, { inversionAttempts: 'dontInvert' });

    if (result) {
      logger.info('QR decodificado exitosamente', { texto: result.data.substring(0, 80) });
      return result.data;
    }

    // Segundo intento: imagen más grande (mejora detección en fotos de baja resolución)
    const scaled = image.clone().scaleToFit({ w: image.bitmap.width * 2, h: image.bitmap.height * 2 });
    const s = scaled.bitmap;
    const result2 = jsQR(new Uint8ClampedArray(s.data), s.width, s.height, {
      inversionAttempts: 'attemptBoth',
    });

    if (result2) {
      logger.info('QR decodificado en segundo intento (escala x2)', {
        texto: result2.data.substring(0, 80),
      });
      return result2.data;
    }

    logger.info('No se encontró QR en la imagen');
    return null;
  } catch (err) {
    logger.warn('Error al procesar imagen para QR', { error: err.message });
    return null;
  }
}

/**
 * Parsea el contenido del QR de una factura electrónica peruana (estándar SUNAT).
 * Formato: RUC|TIPO_CDP|SERIE|NUMERO|IGV|TOTAL|FECHA_EMISION|RUC_ADQUIRIENTE|HASH
 *
 * También maneja URLs de verificación SUNAT:
 * https://e-consulta.sunat.gob.pe/...?ruc=...&...
 */
function parsearQRSunat(textoQR) {
  if (!textoQR) return null;

  // Formato pipe-separado (estándar más común)
  const partes = textoQR.split('|');
  if (partes.length >= 6) {
    const [rucEmisor, tipoCdp, serie, numero, igv, total, fechaEmision, rucAdquiriente] = partes;
    const parsed = {
      ruc_emisor: rucEmisor?.trim() || null,
      tipo_comprobante_codigo: tipoCdp?.trim() || null,
      serie: serie?.trim() || null,
      numero: numero?.trim() || null,
      igv: parseFloat(igv) || null,
      total: parseFloat(total) || null,
      fecha_emision: fechaEmision?.trim() || null,
      ruc_adquiriente: rucAdquiriente?.trim() || null,
      fuente: 'QR_SUNAT',
      qr_raw: textoQR,
    };

    // Mapear código a tipo legible
    const tipoMap = { '01': 'FACTURA', '03': 'BOLETA', '07': 'NOTA_CREDITO', '08': 'NOTA_DEBITO' };
    parsed.tipo_comprobante = tipoMap[parsed.tipo_comprobante_codigo] || 'FACTURA';

    logger.info('QR SUNAT parseado', { ruc: parsed.ruc_emisor, doc: `${serie}-${numero}` });
    return parsed;
  }

  // Si es URL de verificación SUNAT, extraer parámetros
  if (textoQR.includes('sunat.gob.pe') || textoQR.startsWith('http')) {
    try {
      const url = new URL(textoQR);
      const params = url.searchParams;
      const parsed = {
        ruc_emisor: params.get('ruc') || params.get('numRuc') || null,
        serie: params.get('serie') || null,
        numero: params.get('numero') || params.get('correlativo') || null,
        tipo_comprobante_codigo: params.get('tipoDoc') || null,
        total: parseFloat(params.get('total') || params.get('impTotal')) || null,
        fecha_emision: params.get('fechaEmision') || null,
        fuente: 'QR_URL_SUNAT',
        qr_raw: textoQR,
      };
      const tipoMap = { '01': 'FACTURA', '03': 'BOLETA', '07': 'NOTA_CREDITO', '08': 'NOTA_DEBITO' };
      parsed.tipo_comprobante = tipoMap[parsed.tipo_comprobante_codigo] || 'FACTURA';
      logger.info('QR URL SUNAT parseado', { ruc: parsed.ruc_emisor });
      return parsed;
    } catch (_) {
      // no es URL válida, ignorar
    }
  }

  // Formato desconocido: retornar el texto crudo para que Claude lo interprete
  logger.info('QR con formato no estándar, se enviará a Claude', { preview: textoQR.substring(0, 60) });
  return { fuente: 'QR_DESCONOCIDO', qr_raw: textoQR };
}

module.exports = { decodeQRFromImage, parsearQRSunat };
