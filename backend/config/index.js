require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneId: process.env.WHATSAPP_PHONE_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v19.0',
    get apiUrl() {
      return `https://graph.facebook.com/${this.apiVersion}/${this.phoneId}`;
    },
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20251001',
    maxTokens: 1500,
  },

  siscon: {
    baseUrl: process.env.SISCON_BASE_URL || '',
    apiKey: process.env.SISCON_API_KEY || '',
    empresaId: process.env.SISCON_EMPRESA_ID || '001',
  },

  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'application/pdf',
    'text/xml',
    'application/xml',
  ],

  maxFileSizeMB: 10,
};