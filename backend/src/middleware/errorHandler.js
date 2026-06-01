const logger = require('../utils/logger');
const whatsapp = require('../services/whatsapp.service');

/**
 * Maneja errores en el procesamiento de mensajes y notifica al usuario.
 */
async function handleProcessingError(err, from) {
  logger.error('Error procesando mensaje', { from, error: err.message, stack: err.stack });

  let userMessage;

  if (err.message?.includes('Duplicado')) {
    userMessage = `⚠️ *Comprobante ya registrado*\n\nEste comprobante ya existe en SISCON. No se realizó un registro duplicado.`;
  } else if (err.message?.includes('JSON')) {
    userMessage = `❌ No pude interpretar el documento. Intenta con una imagen más nítida o en formato PDF.`;
  } else if (err.message?.includes('SISCON') || err.response?.status >= 500) {
    userMessage = `❌ Error al conectar con SISCON. El equipo de sistemas ha sido notificado. Intenta nuevamente en unos minutos.`;
  } else {
    userMessage = `❌ Ocurrió un error inesperado. Por favor intenta nuevamente o contacta al administrador.`;
  }

  if (from) {
    await whatsapp.sendMessage(from, userMessage).catch(() => {});
  }
}

/**
 * Middleware de errores para Express.
 */
function expressErrorHandler(err, req, res, next) {
  logger.error('Error en request', { path: req.path, error: err.message });
  res.status(500).json({ error: 'Error interno del servidor' });
}

module.exports = { handleProcessingError, expressErrorHandler };
