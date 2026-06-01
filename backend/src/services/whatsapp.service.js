const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

/**
 * Descarga un archivo multimedia de WhatsApp.
 * Meta devuelve primero la URL del archivo, luego hay que descargar con el token.
 */
async function downloadMedia(mediaId) {
  // 1. Obtener URL del archivo
  const metaRes = await axios.get(
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`,
    { headers: { Authorization: `Bearer ${config.whatsapp.token}` } }
  );

  const { url, mime_type, file_size } = metaRes.data;
  logger.info('Media info obtenida', { mediaId, mime_type, file_size });

  // 2. Descargar el archivo como buffer
  const fileRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    responseType: 'arraybuffer',
  });

  return {
    buffer: Buffer.from(fileRes.data),
    mimeType: mime_type,
    fileSize: file_size,
  };
}

/**
 * Envía un mensaje de texto simple al número indicado.
 */
async function sendMessage(to, text) {
  try {
    await axios.post(
      `${config.whatsapp.apiUrl}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${config.whatsapp.token}` } }
    );
    logger.info('Mensaje enviado', { to, preview: text.substring(0, 60) });
  } catch (err) {
    logger.error('Error enviando mensaje WhatsApp', { to, error: err.message });
  }
}

/**
 * Envía un mensaje con botones interactivos (hasta 3 opciones).
 */
async function sendButtonMessage(to, body, buttons) {
  try {
    await axios.post(
      `${config.whatsapp.apiUrl}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((b, i) => ({
              type: 'reply',
              reply: { id: b.id || `btn_${i}`, title: b.title },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${config.whatsapp.token}` } }
    );
  } catch (err) {
    logger.error('Error enviando botones WhatsApp', { to, error: err.message });
  }
}

/**
 * Extrae el contenido del mensaje entrante del payload de Meta.
 * Devuelve: { from, type, text?, media? }
 */
function parseIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) return null;

  const from = message.from;
  const type = message.type;

  if (type === 'text') {
    return { from, type: 'text', text: message.text?.body };
  }

  if (['image', 'document', 'audio'].includes(type)) {
    const media = message[type];
    return {
      from,
      type,
      mediaId: media.id,
      mimeType: media.mime_type,
      filename: media.filename || null,
    };
  }

  if (type === 'interactive') {
    const reply = message.interactive?.button_reply;
    return { from, type: 'button_reply', buttonId: reply?.id, buttonTitle: reply?.title };
  }

  return { from, type: 'unsupported' };
}

module.exports = { downloadMedia, sendMessage, sendButtonMessage, parseIncomingMessage };
