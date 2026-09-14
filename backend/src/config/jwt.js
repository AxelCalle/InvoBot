const logger = require('../utils/logger');

const DEV_FALLBACK_SECRET = 'invoicegg_secret_2026';

let JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // No arrancar en producción con un secreto adivinable: quien conozca el
    // código podría forjar tokens de admin.
    throw new Error(
      'JWT_SECRET no está configurado. Define esta variable en el .env de producción antes de iniciar el servidor.'
    );
  }
  logger.warn('JWT_SECRET no configurado, usando secreto de desarrollo (NO usar en producción)');
  JWT_SECRET = DEV_FALLBACK_SECRET;
}

module.exports = { JWT_SECRET };
