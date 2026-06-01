const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sql = require('mssql');
const crypto = require('crypto');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'invoicegg_secret_2026';

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DATABASE,
  server: process.env.SQL_SERVER?.split('\\')[0],
  options: {
    instanceName: process.env.SQL_SERVER?.split('\\')[1],
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};

async function getPool() {
  return await sql.connect(sqlConfig);
}

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
              OUTPUT INSERTED.id, INSERTED.email, INSERTED.nombre
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
              nombre, debe_cambiar_password, rol 
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

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  try {
    const db = await getPool();
    const result = await db.request()
      .input('email', sql.VarChar, email)
      .query('SELECT id, email, nombre FROM usuarios WHERE email = @email AND activo = 1');

    if (result.recordset.length === 0) {
      return res.json({ ok: true, mensaje: 'Si el correo existe, se generó un código temporal.' });
    }

    const codigo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expira = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const hash = await bcrypt.hash(codigo, 10);

    await db.request()
      .input('email', sql.VarChar, email)
      .input('hash', sql.VarChar, hash)
      .input('expira', sql.DateTime, expira)
      .query(`UPDATE usuarios SET 
              password_temporal = @hash,
              temporal_expira = @expira,
              debe_cambiar_password = 1
              WHERE email = @email`);

    logger.info('Código temporal generado', { email });

    res.json({
      ok: true,
      codigo,
      mensaje: 'Código temporal generado. Válido por 24 horas.',
      expira: expira.toISOString(),
    });

  } catch (err) {
    logger.error('Error en forgot-password', { error: err.message });
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