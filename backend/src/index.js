const express = require('express');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');
const logger = require('./utils/logger');
const { expressErrorHandler } = require('./middleware/errorHandler');

const healthRoute = require('./routes/health.route');
const facturasRoute = require('./routes/facturas.route');
const chatRoute = require('./routes/chat.route');
const { getPool } = require('./config/database');

const app = express();
const authRoute = require('./routes/auth.route');

// Detrás de un proxy inverso (gateway/Nginx): usa X-Forwarded-For para IP real
// (necesario para que el rate limiting y los logs reflejen al cliente real).
app.set('trust proxy', 1);

app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS: lista separada por comas de orígenes permitidos para llamadas
// cross-origin directas al backend (fuera del gateway). Vacío = ningún origen
// cross-origin permitido (uso normal: todo pasa por el mismo origen vía gateway).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Rate limiting ──────────────────────────────────────────────────────────────
// Algunos saltos del proxy (IIS) reenvían "X-Forwarded-For" como "ip:puerto" en vez
// de solo la ip; express-rate-limit exige una IP sin puerto y si no, tumba la
// solicitud con ERR_ERL_INVALID_IP_ADDRESS. Se recorta el puerto antes de usarla.
function ipSinPuerto(ip) {
  if (!ip) return ip;
  const conCorchetes = ip.match(/^\[(.+)\]:\d+$/); // IPv6 con puerto: [::1]:56034
  if (conCorchetes) return conCorchetes[1];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) return ip.slice(0, ip.lastIndexOf(':')); // IPv4 con puerto
  return ip;
}
const keyGenerator = (req) => ipKeyGenerator(ipSinPuerto(req.ip));

// Login/registro/recuperación: límite estricto (protege contra fuerza bruta).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});
// Resto de la API: límite generoso (protege contra abuso/DoS sin estorbar el uso normal).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' },
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
app.use('/health', healthRoute);
app.use('/api/facturas', apiLimiter, facturasRoute);
app.use('/api/chat', apiLimiter, chatRoute);
app.use('/api/auth', authLimiter, authRoute);
// 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Error handler global
app.use(expressErrorHandler);

// ── Inicio del servidor ───────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info(`Servidor iniciado`, {
    port: config.port,
    env: config.nodeEnv,
    health: `GET /health`,
    facturas: `POST /api/facturas`,
  });
});

// ── Keepalive túnel VPN (Global Go) ─────────────────────────────────────────────
// El FortiClient VPN hacia la oficina tiene "Idle Logout" a los 300s: si el servidor
// no genera tráfico hacia 192.168.130.2 en ese lapso, el túnel se desconecta solo
// (aunque nadie esté subiendo facturas en ese momento). Esta consulta liviana cada
// 2 minutos mantiene la conexión activa.
const KEEPALIVE_GGO_MS = 2 * 60 * 1000;
setInterval(async () => {
  try {
    const pool = await getPool('GGO');
    await pool.request().query('SELECT 1 AS ok');
    logger.info('Keepalive GGO OK');
  } catch (err) {
    logger.warn('Keepalive GGO falló', { error: err.message });
  }
}, KEEPALIVE_GGO_MS).unref();

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