const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { JWT_SECRET } = require('../config/jwt');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getPool } = require('../config/database');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, nombre } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const db = await getPool();
    const exists = await db.request()
      .input('email', sql.VarChar, email)
      .query('SELECT id FROM usuarios WHERE email = @email');

    if (exists.recordset.length > 0) {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await db.request()
      .input('email', sql.VarChar, email)
      .input('hash', sql.VarChar, hash)
      .input('nombre', sql.VarChar, nombre || email.split('@')[0])
      .query(`INSERT INTO usuarios (email, password, nombre)
              OUTPUT INSERTED.id, INSERTED.email, INSERTED.nombre, INSERTED.usuario_gf, INSERTED.usuario_ggo
              VALUES (@email, @hash, @nombre)`);

    const user = result.recordset[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, rol: 'usuario' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        rol: 'usuario',
        debe_cambiar_password: false,
        usuario_gf: user.usuario_gf || null,
        usuario_ggo: user.usuario_ggo || null,
      }
    });
  } catch (err) {
    logger.error('Error en register', { error: err.message });
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  try {
    const db = await getPool();
    const result = await db.request()
      .input('email', sql.VarChar, email)
      .query(`SELECT id, email, password, password_temporal, temporal_expira,
              nombre, debe_cambiar_password, rol, usuario_gf, usuario_ggo
              FROM usuarios WHERE email = @email AND activo = 1`);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const user = result.recordset[0];

    // Verificar contraseña normal
    let valid = await bcrypt.compare(password, user.password);

    // Si no coincide, verificar contraseña temporal
    if (!valid && user.password_temporal && user.temporal_expira) {
      const expirado = new Date() > new Date(user.temporal_expira);
      if (!expirado) {
        valid = await bcrypt.compare(password, user.password_temporal);
      }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });

    await db.request()
      .input('id', sql.Int, user.id)
      .query('UPDATE usuarios SET ultimo_acceso = GETDATE() WHERE id = @id');

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol || 'usuario' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        rol: user.rol || 'usuario',
        debe_cambiar_password: user.debe_cambiar_password === true || user.debe_cambiar_password === 1,
        usuario_gf: user.usuario_gf || null,
        usuario_ggo: user.usuario_ggo || null,
      }
    });
  } catch (err) {
    logger.error('Error en login', { error: err.message });
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ ok: true, user: decoded });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// POST /api/auth/admin/reset-password
// Solo un admin autenticado puede resetear la contraseña de otro usuario.
// La nueva contraseña queda activa de inmediato (reemplaza `password`, no un
// campo temporal con expiración) — el admin se la comunica al usuario por
// fuera del sistema (llamada, chat interno, etc).
router.post('/admin/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { email, nuevaPasswordDeseada } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  if (nuevaPasswordDeseada && nuevaPasswordDeseada.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('email', sql.VarChar, email)
      .query('SELECT id, email, nombre FROM usuarios WHERE email = @email AND activo = 1');

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'No existe un usuario activo con ese correo.' });
    }

    // Si el admin especificó una contraseña, se usa esa; si no, se genera una aleatoria.
    const nuevaPassword = nuevaPasswordDeseada || crypto.randomBytes(9).toString('base64url'); // 12 chars, ~72 bits
    const hash = await bcrypt.hash(nuevaPassword, 10);

    await db.request()
      .input('email', sql.VarChar, email)
      .input('hash', sql.VarChar, hash)
      .query(`UPDATE usuarios SET
              password = @hash,
              password_temporal = NULL,
              temporal_expira = NULL,
              debe_cambiar_password = 1
              WHERE email = @email`);

    logger.info('Contraseña reseteada por admin', { email, adminId: req.user.id });

    res.json({ ok: true, email, nuevaPassword });
  } catch (err) {
    logger.error('Error en admin/reset-password', { error: err.message });
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  const { nuevaPassword } = req.body;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) return res.status(401).json({ error: 'No autorizado' });
  if (!nuevaPassword || nuevaPassword.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getPool();
    const hash = await bcrypt.hash(nuevaPassword, 10);

    await db.request()
      .input('id', sql.Int, decoded.id)
      .input('hash', sql.VarChar, hash)
      .query(`UPDATE usuarios SET 
              password = @hash,
              password_temporal = NULL,
              temporal_expira = NULL,
              debe_cambiar_password = 0
              WHERE id = @id`);

    logger.info('Contraseña actualizada', { userId: decoded.id });
    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente' });

  } catch (err) {
    logger.error('Error en change-password', { error: err.message });
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;