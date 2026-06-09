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
    const sunatActivo = resultado.sunat?.activo !== false;

    res.json({
      ok: true,
      mensaje: '✅ Comprobante registrado correctamente',
      voucher: resultado.voucher,
      numero: comprobante.serie && comprobante.serie !== 'null' 
              ? `${comprobante.serie}-${comprobante.numero}` 
              : `${comprobante.numero}`,
      sunat: resultado.sunat,
      advertencia_sunat: !sunatActivo ? `⚠️ El proveedor RUC ${comprobante.emisor?.ruc} figura como ${resultado.sunat?.estado} en SUNAT.` : null,
      resumen: {
        tipo: comprobante.tipo_comprobante,
        serie_numero:comprobante.serie && comprobante.serie !== 'null' 
              ? `${comprobante.serie}-${comprobante.numero}` 
              : `${comprobante.numero}`,
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
    const pagina = parseInt(req.query.pagina) || 1;
    const porPagina = parseInt(req.query.porPagina) || 20;
    const offset = (pagina - 1) * porPagina;
    const buscarRuc = req.query.ruc || '';
    const buscarFechaDesde = req.query.fechaDesde || '';
    const buscarFechaHasta = req.query.fechaHasta || '';
    const buscarNumero = req.query.numero || '';

    let where = 'WHERE HABER > 0';
    if (rol !== 'admin') where += ` AND AUSER LIKE '${usuario}%'`;
    if (buscarRuc) where += ` AND RUT LIKE '%${buscarRuc}%'`;
    if (buscarNumero) where += ` AND NUMERO LIKE '%${buscarNumero}%'`;
    if (buscarFechaDesde) where += ` AND FECHAD >= '${buscarFechaDesde}'`;
    if (buscarFechaHasta) where += ` AND FECHAD <= '${buscarFechaHasta}'`;

    const countResult = await pool.request().query(
      `SELECT COUNT(*) AS total FROM asientos_contables ${where}`
    );
    const total = countResult.recordset[0].total;

    const result = await pool.request().query(`
      SELECT MTV, VOU, GLOSA, NUMERO, FECHA, RUT, MONEDA, NETO, IGV,
        HABER AS TOTAL, SERIE, AUSER, AFECHA
      FROM asientos_contables ${where}
      ORDER BY ID DESC
      OFFSET ${offset} ROWS FETCH NEXT ${porPagina} ROWS ONLY
    `);

    res.json({
      ok: true,
      facturas: result.recordset,
      rol,
      paginacion: {
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
      }
    });
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

router.get('/pdf/:numero', async (req, res) => {
  try {
    const mssql = require('mssql');
    const PDFDocument = require('pdfkit');

    const pool = await mssql.connect({
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DATABASE,
      server: process.env.SQL_SERVER?.split('\\')[0],
      options: { instanceName: process.env.SQL_SERVER?.split('\\')[1], trustServerCertificate: true, enableArithAbort: true },
    });

    const result = await pool.request()
      .input('numero', mssql.VarChar, req.params.numero)
      .query(`SELECT * FROM asientos_contables WHERE NUMERO = @numero ORDER BY ID ASC`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }

    const filas = result.recordset;
    const primera = filas[0];
    const filahaber = filas.find(f => f.HABER > 0) || primera;

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="factura-${req.params.numero}.pdf"`);
    doc.pipe(res);

    doc.fontSize(20).font('Helvetica-Bold').text('COMPROBANTE DE PAGO', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica').text(`Número: ${primera.NUMERO}`, { align: 'center' });
    doc.moveDown(1);

    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    doc.fontSize(11).font('Helvetica-Bold').text('DATOS DEL COMPROBANTE');
    doc.moveDown(0.3);
    doc.font('Helvetica');
    doc.text(`Serie:          ${primera.SERIE || '—'}`);
    doc.text(`Número:         ${primera.NUMERO || '—'}`);
    doc.text(`Fecha emisión:  ${primera.FECHAD ? new Date(primera.FECHAD).toLocaleDateString('es-PE') : '—'}`);
    doc.text(`Fecha registro: ${primera.FECHA ? new Date(primera.FECHA).toLocaleDateString('es-PE') : '—'}`);
    doc.text(`Moneda:         ${primera.MONEDA === 'D' ? 'USD - Dólares Americanos' : 'PEN - Soles'}`);
    doc.text(`T/C:            ${primera.TC || '1.00'}`);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('PROVEEDOR');
    doc.moveDown(0.3);
    doc.font('Helvetica');
    doc.text(`RUC: ${primera.RUT || '—'}`);
    doc.moveDown(1);

    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').text('IMPORTES');
    doc.moveDown(0.3);
    doc.font('Helvetica');

    const cur = primera.MONEDA === 'D' ? 'US$' : 'S/';
    const neto = parseFloat(primera.NETO || 0).toFixed(2);
    const igv = parseFloat(primera.IGV || 0).toFixed(2);
    const total = parseFloat(filahaber.HABER || 0).toFixed(2);

    doc.text(`Base imponible: ${cur} ${neto}`);
    doc.text(`IGV (18%):      ${cur} ${igv}`);
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(13).text(`TOTAL: ${cur} ${total}`, { align: 'right' });
    doc.moveDown(1);

    doc.fontSize(11).font('Helvetica-Bold').text('ASIENTOS CONTABLES');
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Cuenta', 50, doc.y, { width: 100 });
    doc.text('Glosa', 150, doc.y - doc.currentLineHeight(), { width: 200 });
    doc.text('Debe', 350, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    doc.text('Haber', 430, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(9);
    filas.forEach(f => {
      const y = doc.y;
      doc.text(f.CUENTA || '', 50, y, { width: 100 });
      doc.text((f.GLOSA || '').substring(0, 35), 150, y, { width: 200 });
      doc.text(parseFloat(f.DEBE || 0).toFixed(2), 350, y, { width: 80, align: 'right' });
      doc.text(parseFloat(f.HABER || 0).toFixed(2), 430, y, { width: 80, align: 'right' });
      doc.moveDown(0.8);
    });

    doc.moveDown(1);
    doc.fontSize(9).font('Helvetica').fillColor('gray')
      .text(`Generado por InvoBot — ${new Date().toLocaleString('es-PE')}`, { align: 'center' });

    doc.end();

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

router.get('/validar-ruc/:ruc', async (req, res) => {
  try {
    const ruc = req.params.ruc;
    if (!ruc || ruc.length !== 11) {
      return res.status(400).json({ error: 'RUC inválido — debe tener 11 dígitos' });
    }
    const response = await require('axios').get(
      `https://api.sunat.cloud/ruc/${ruc}`,
      { timeout: 5000 }
    );
    const data = response.data;
    res.json({
      ok: true,
      ruc: data.ruc,
      razon_social: data.razon_social || data.nombre,
      estado: data.estado,
      condicion: data.condicion,
      activo: data.estado === 'ACTIVO',
    });
  } catch (err) {
    logger.warn('No se pudo validar RUC en SUNAT', { ruc: req.params.ruc, error: err.message });
    res.json({ ok: false, advertencia: 'No se pudo validar el RUC en SUNAT. Se procederá con el registro.' });
  }
});

module.exports = router;