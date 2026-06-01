const whatsapp = require('./whatsapp.service');
const claude = require('./claude.service');
const siscon = require('./siscon.service');
const config = require('../../config');
const logger = require('../utils/logger');

/**
 * Formatea el resumen de un comprobante para enviar por WhatsApp.
 */
function formatResumen(comprobante) {
  const cur = comprobante.moneda === 'USD' ? 'USD' : 'S/';
  const total = comprobante.importes?.total?.toFixed(2) || '0.00';
  const igv = comprobante.importes?.igv?.toFixed(2) || '0.00';

  return (
    `✅ *Comprobante registrado en SISCON*\n\n` +
    `📄 *${comprobante.tipo_comprobante}* ${comprobante.serie}-${comprobante.numero}\n` +
    `📅 Fecha: ${comprobante.fecha_emision}\n` +
    `🏢 Emisor: ${comprobante.emisor?.razon_social || 'N/D'}\n` +
    `🔑 RUC: ${comprobante.emisor?.ruc || 'N/D'}\n\n` +
    `💰 Base imponible: ${cur} ${comprobante.importes?.op_gravadas?.toFixed(2) || '0.00'}\n` +
    `🧾 IGV (18%): ${cur} ${igv}\n` +
    `💵 *TOTAL: ${cur} ${total}*\n\n` +
    `📝 Líneas: ${(comprobante.lineas || []).length} ítem(s)\n` +
    `🔍 Confianza extracción: ${comprobante.confianza}`
  );
}

/**
 * Procesa un mensaje entrante de WhatsApp que contiene un adjunto.
 * Flujo: descarga → Claude → validación → SISCON → confirmación
 */
async function procesarAdjunto(mensaje) {
  const { from, mediaId, mimeType, filename } = mensaje;

  // 1. Validar tipo de archivo
  if (!config.allowedMimeTypes.includes(mimeType)) {
    await whatsapp.sendMessage(
      from,
      `❌ Formato no soportado: *${mimeType}*\n\nEnvía el comprobante en: PDF, JPEG, PNG o XML.`
    );
    return;
  }

  // 2. Notificar que se está procesando
  await whatsapp.sendMessage(from, '⏳ Procesando tu comprobante con IA, espera un momento...');

  // 3. Descargar el archivo de WhatsApp
  logger.info('Descargando media', { from, mediaId, mimeType });
  const { buffer, fileSize } = await whatsapp.downloadMedia(mediaId);

  // Verificar tamaño máximo
  const sizeMB = fileSize / (1024 * 1024);
  if (sizeMB > config.maxFileSizeMB) {
    await whatsapp.sendMessage(from, `❌ El archivo supera el límite de ${config.maxFileSizeMB} MB.`);
    return;
  }

  // 4. Extraer datos con Claude
  logger.info('Extrayendo datos con Claude', { from });
  const comprobante = await claude.extractFromDocument(buffer, mimeType);

  // 5. Validar que Claude extrajo datos mínimos
  if (!comprobante.serie || !comprobante.numero || !comprobante.emisor?.ruc) {
    await whatsapp.sendMessage(
      from,
      `⚠️ No pude leer correctamente el comprobante.\n\n` +
      `Asegúrate de que la imagen sea nítida y el documento sea legible.\n` +
      `Si el problema persiste, intenta enviarlo en formato PDF o XML.`
    );
    return;
  }

  // 6. Advertir si la confianza es baja
  if (comprobante.confianza === 'BAJA') {
    await whatsapp.sendMessage(
      from,
      `⚠️ El documento se ve borroso o incompleto. Intentaré registrarlo de todas formas, pero verifica los datos en SISCON.`
    );
  }

  // 7. Registrar en SISCON
  logger.info('Registrando en SISCON', { from, serie: comprobante.serie, numero: comprobante.numero });
  const resultado = await siscon.registrarComprobante(comprobante);

  // 8. Confirmar al usuario
  const resumen = formatResumen(comprobante);
  await whatsapp.sendMessage(from, resumen + `\n\n🗂 Registro SISCON: *${resultado.numero_registro || resultado.id}*`);

  logger.info('Flujo completado exitosamente', {
    from,
    comprobante: `${comprobante.serie}-${comprobante.numero}`,
    sisconId: resultado.id,
  });
}

/**
 * Procesa mensajes de texto (ayuda, estado, etc.)
 */
async function procesarTexto(mensaje) {
  const { from, text } = mensaje;
  const cmd = (text || '').trim().toLowerCase();

  if (['hola', 'hi', 'ayuda', 'help', 'inicio', 'start'].includes(cmd)) {
    await whatsapp.sendMessage(
      from,
      `👋 *Bot de registro de comprobantes*\n\n` +
      `Envíame una foto o archivo de tu factura o boleta y la registraré automáticamente en SISCON.\n\n` +
      `*Formatos aceptados:*\n` +
      `• PDF\n• JPEG / PNG (foto)\n• XML electrónico\n\n` +
      `_Solo envía el archivo, yo me encargo del resto._`
    );
  } else {
    await whatsapp.sendMessage(
      from,
      `📎 Envíame tu comprobante como archivo adjunto (PDF, imagen o XML) para registrarlo en SISCON.`
    );
  }
}

module.exports = { procesarAdjunto, procesarTexto };
