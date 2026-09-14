const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/jwt');

/** Exige un JWT válido. Deja el payload decodificado en req.user. */
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
  }
}

/** Exige que req.user (ya autenticado por requireAuth) tenga rol admin. */
function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') {
    return res.status(403).json({ error: 'No tienes permisos para esta acción.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
