const express = require('express');
const router = express.Router();
const multer = require('multer');
const claude = require('../services/claude.service');
const { registrarFactura, checkDuplicate } = require('../services/sqlserver.service');
const logger = require('../utils/logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf', 'text/xml', 'application/xml'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Formato no soportado: ${file.mimetype}`));
  },
});

router.post('/', upload.single('factura'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

  const usuario = req.body.usuario || 'BOT';
  logger.info('Factura recibida', { filename: req.file.originalname, mimeType: req.file.mimetype });

  try {
    const comprobante = await claude.extractFromDocument(req.file.buffer, req.file.mimetype);

    if (!comprobante.numero || !comprobante.emisor?.ruc) {
      return res.status(422).json({ error: 'No se pudieron extraer los datos mínimos.', confianza: comprobante.confianza });
    }

    const isDuplicate = await checkDuplicate(comprobante.serie, comprobante.numero, comprobante.emisor.ruc);
    if (isDuplicate) {
      return res.status(409).json({ error: `El comprobante ${comprobante.serie}-${comprobante.numero} ya fue registrado.` });
    }

    const resultado = await registrarFactura(comprobante, usuario);

    res.json({
      ok: true,
      mensaje: '✅ Comprobante registrado correctamente',
      voucher: resultado.voucher,
      numero: `${comprobante.serie}-${comprobante.numero}`,
      resumen: {
        tipo: comprobante.tipo_comprobante,
        serie_numero: `${comprobante.serie}-${comprobante.numero}`,
        fecha: comprobante.fecha_emision,
        emisor: comprobante.emisor?.razon_social,
        ruc: comprobante.emisor?.ruc,
        moneda: comprobante.moneda,
        confianza: comprobante.confianza,
        asientos_generados: resultado.asientos,
      },
    });
  } catch (err) {
    logger.error('Error procesando factura', { error: err.message });
    res.status(500).json({ error: 'Error interno al procesar la factura.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'invoicegg_secret_2026';
    const token = req.headers.authorization?.replace('Bearer ', '');

    let rol = 'usuario';
    let userEmail = '';

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        rol = decoded.rol || 'usuario';
        userEmail = decoded.email || '';
      } catch {}
    }

    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });

    const usuario = userEmail.split('@')[0].substring(0, 3).toUpperCase();

    const query = rol === 'admin'
      ? `SELECT TOP 50 MTV, VOU, GLOSA, NUMERO, FECHA, RUT, MONEDA, NETO, IGV,
           NETO + IGV AS TOTAL, SERIE, AUSER, AFECHA
           FROM asientos_contables WHERE TL = ' ' ORDER BY ID DESC`
      : `SELECT TOP 50 MTV, VOU, GLOSA, NUMERO, FECHA, RUT, MONEDA, NETO, IGV,
           NETO + IGV AS TOTAL, SERIE, AUSER, AFECHA
           FROM asientos_contables WHERE TL = ' ' AND AUSER LIKE @usuario ORDER BY ID DESC`;

    const request = pool.request();
    if (rol !== 'admin') {
      request.input('usuario', mssql.VarChar, `${usuario}%`);
    }

    const result = await request.query(query);
    res.json({ ok: true, facturas: result.recordset, rol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/empresas', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });
    const result = await pool.request().query('SELECT id, codigo, nombre FROM empresas WHERE activo = 1 ORDER BY nombre');
    res.json({ ok: true, empresas: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/areas', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });
    const result = await pool.request().query('SELECT id, codigo, nombre FROM areas WHERE activo = 1 ORDER BY nombre');
    res.json({ ok: true, areas: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/presupuesto/:empresaId/:areaId', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });
    const fecha = new Date();
    const anio = fecha.getFullYear();
    const mes = fecha.getMonth() + 1;

    const presup = await pool.request()
      .input('empresa_id', mssql.Int, req.params.empresaId)
      .input('area_id', mssql.Int, req.params.areaId)
      .input('anio', mssql.Int, anio)
      .input('mes', mssql.Int, mes)
      .query(`SELECT monto FROM presupuestos 
              WHERE empresa_id = @empresa_id AND area_id = @area_id 
              AND anio = @anio AND mes = @mes`);

    const gasto = await pool.request()
      .input('empresa_id', mssql.Int, req.params.empresaId)
      .input('area_id', mssql.Int, req.params.areaId)
      .input('anio', mssql.Int, anio)
      .input('mes', mssql.Int, mes)
      .query(`SELECT ISNULL(SUM(monto), 0) AS total 
              FROM factura_empresa_area 
              WHERE empresa_id = @empresa_id AND area_id = @area_id
              AND YEAR(fecha_registro) = @anio AND MONTH(fecha_registro) = @mes`);

    const presupuesto = presup.recordset[0]?.monto || 0;
    const gastado = gasto.recordset[0]?.total || 0;
    const porcentaje = presupuesto > 0 ? Math.round((gastado / presupuesto) * 100) : 0;

    res.json({
      ok: true,
      presupuesto,
      gastado,
      disponible: presupuesto - gastado,
      porcentaje,
      alerta: porcentaje >= 80,
      excedido: porcentaje >= 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/total/:numero', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });
    const result = await pool.request()
      .input('numero', mssql.VarChar, req.params.numero)
      .query(`SELECT SUM(HABER) AS total, MAX(MONEDA) AS moneda 
              FROM asientos_contables 
              WHERE NUMERO = @numero AND HABER > 0`);
    const row = result.recordset[0];
    res.json({ ok: true, total: row?.total || 0, moneda: row?.moneda || 'S' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/vincular', async (req, res) => {
  try {
    const { vou, empresa_id, area_id, monto, moneda } = req.body;
    const mssql = require('mssql');
    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });
    await pool.request()
      .input('vou', mssql.VarChar, vou)
      .input('empresa_id', mssql.Int, empresa_id)
      .input('area_id', mssql.Int, area_id)
      .input('monto', mssql.Decimal(18, 2), monto)
      .input('moneda', mssql.VarChar, moneda)
      .query('INSERT INTO factura_empresa_area (vou, empresa_id, area_id, monto, moneda) VALUES (@vou, @empresa_id, @area_id, @monto, @moneda)');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;