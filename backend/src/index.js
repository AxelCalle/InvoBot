const express = require('express');
const config = require('../config');
const logger = require('./utils/logger');
const { expressErrorHandler } = require('./middleware/errorHandler');

const webhookRoute = require('./routes/webhook.route');
const healthRoute = require('./routes/health.route');
const facturasRoute = require('./routes/facturas.route');

const app = express();
const authRoute = require('./routes/auth.route');

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Middlewares globales ───────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Log de cada request entrante
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRoute);
app.use('/health', healthRoute);
app.use('/api/facturas', facturasRoute);
app.use('/api/auth', authRoute);
// 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Error handler global
app.use(expressErrorHandler);

// ── Inicio del servidor ───────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info(`Servidor iniciado`, {
    port: config.port,
    env: config.nodeEnv,
    webhook: `POST /webhook`,
    health: `GET /health`,
    facturas: `POST /api/facturas`,
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM recibido, cerrando servidor...');
  server.close(() => {
    logger.info('Servidor cerrado');
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promesa no manejada', { reason });
});

module.exports = app;