const express = require('express');
const router = express.Router();
const config = require('../../config');
const logger = require('../utils/logger');
const { parseIncomingMessage } = require('../services/whatsapp.service');
const { procesarAdjunto, procesarTexto } = require('../services/processor.service');
const { handleProcessingError } = require('../middleware/errorHandler');

/**
 * GET /webhook
 * Verificación inicial del webhook por parte de Meta.
 * Meta envía hub.challenge y espera que lo devuelvas para confirmar que el servidor es tuyo.
 */
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    logger.info('Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('Intento de verificación fallido', { token });
  res.sendStatus(403);
});

/**
 * POST /webhook
 * Recibe todos los eventos de WhatsApp (mensajes, estados de entrega, etc.)
 * Meta espera un 200 rápido — el procesamiento se hace de forma asíncrona.
 */
router.post('/', (req, res) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.sendStatus(200);

  const body = req.body;

  // Ignorar si no es un evento de whatsapp_business_account
  if (body.object !== 'whatsapp_business_account') return;

  const mensaje = parseIncomingMessage(body);
  if (!mensaje) return;

  logger.info('Mensaje recibido', { from: mensaje.from, type: mensaje.type });

  // Procesar de forma asíncrona (no bloquear la respuesta 200)
  setImmediate(async () => {
    try {
      if (mensaje.type === 'text') {
        await procesarTexto(mensaje);
      } else if (['image', 'document'].includes(mensaje.type)) {
        await procesarAdjunto(mensaje);
      } else {
        logger.info('Tipo de mensaje ignorado', { type: mensaje.type });
      }
    } catch (err) {
      await handleProcessingError(err, mensaje.from);
    }
  });
});

module.exports = router;
