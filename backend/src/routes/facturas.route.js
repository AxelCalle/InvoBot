const express = require('express');
const router = express.Router();
const multer = require('multer');
const claude = require('../services/claude.service');
const { registrarFactura, checkDuplicate, getConfigContable, asientosTableName } = require('../services/sqlserver.service');
const { registrarCompraGF, checkDuplicateGF, resolverPeriodoGF } = require('../services/compras.service');
const sunat = require('../services/sunat.service');
const qr = require('../services/qr.service');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getPool } = require('../config/database');

// Lista de conexiones en uso (una por servidor distinto configurado en `empresas`),
// para que las pantallas de listar/ver/eliminar busquen en todos los servidores
// donde puede haber quedado guardado un documento (no solo el principal).
async function getConexionesActivas() {
  const mssql = require('mssql');
  const pool = await getPool();
  const result = await pool.request()
    .query("SELECT DISTINCT conexion FROM empresas WHERE conexion IS NOT NULL AND conexion <> ''");
  const conexiones = result.recordset.map(r => r.conexion);
  return conexiones.length > 0 ? conexiones : ['DEFAULT'];
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // alineado con el límite comunicado en el frontend
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf', 'text/xml', 'application/xml'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Formato no soportado: ${file.mimetype}`));
  },
});

// Toda la API de facturas requiere sesión iniciada.
router.use(requireAuth);

router.post('/', upload.single('factura'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

  const usuario       = req.body.usuario       || 'BOT';
  const empresaCodigo = (req.body.empresa_codigo || '').toUpperCase().trim();
  const conceptoId    = req.body.concepto_gasto_id ? parseInt(req.body.concepto_gasto_id, 10) : null;
  const areaId        = req.body.area_id ? parseInt(req.body.area_id, 10) : null;
  const esGF          = empresaCodigo === 'GF';
  logger.info('Factura recibida', { filename: req.file.originalname, mimeType: req.file.mimetype, empresa: empresaCodigo });

  // Período contable elegido en el frontend (solo aplica a Global Factoring por ahora).
  // Se valida ANTES de llamar a Claude para no gastar la extracción si el período no
  // es válido (ej. el usuario intenta registrar un mes ya cerrado, o pasado el día 10).
  let periodoGF = null;
  if (esGF && req.body.periodo) {
    const resuelto = resolverPeriodoGF(req.body.periodo);
    if (resuelto.error) {
      return res.status(422).json({ error: resuelto.error, motivo: 'PERIODO_INVALIDO' });
    }
    periodoGF = resuelto.yyyymm;
  }

  try {
    // Algunas empresas (ej. Global Go) registran sus asientos en un servidor de base de
    // datos distinto al principal. La tabla `empresas` (que siempre vive en la conexión
    // por defecto) indica con qué conexión con nombre debe hablar el resto del proceso.
    const mssqlLib = require('mssql');
    const poolDefault = await getPool();
    const empresaRow = await poolDefault.request()
      .input('codigo', mssqlLib.VarChar, empresaCodigo)
      .query('SELECT conexion FROM empresas WHERE codigo = @codigo');
    const conexion = empresaRow.recordset[0]?.conexion || 'DEFAULT';
    // Intentar decodificar QR si es imagen
    let datosQR = null;
    if (req.file.mimetype === 'image/jpeg' || req.file.mimetype === 'image/png') {
      const textoQR = await qr.decodeQRFromImage(req.file.buffer);
      if (textoQR) {
        datosQR = qr.parsearQRSunat(textoQR);
        logger.info('QR detectado en imagen', { fuente: datosQR?.fuente });
      }
    }

    const comprobante = await claude.extractFromDocument(req.file.buffer, req.file.mimetype, datosQR);

    logger.info('Datos extraídos por Claude', {
      serie: comprobante.serie,
      numero: comprobante.numero,
      ruc: comprobante.emisor?.ruc,
      tipo: comprobante.tipo_comprobante,
      confianza: comprobante.confianza,
      total: comprobante.importes?.total,
    });

    if (!comprobante.numero || !comprobante.emisor?.ruc) {
      return res.status(422).json({ error: 'No se pudieron extraer los datos mínimos.', confianza: comprobante.confianza });
    }


    // Verificar duplicado según destino
    const isDuplicate = esGF
      ? await checkDuplicateGF(comprobante.serie, comprobante.numero, comprobante.emisor.ruc)
      : await checkDuplicate(comprobante.serie, comprobante.numero, comprobante.emisor.ruc, conexion);
    if (isDuplicate) {
      return res.status(409).json({ error: `El comprobante ${comprobante.serie}-${comprobante.numero} ya fue registrado.` });
    }

    // Validar emisor en SUNAT (solo facturas nacionales)
    const validacionSunat = await sunat.validarEmisorNacional(comprobante);
    if (!validacionSunat.proceder) {
      return res.status(422).json({
        error: validacionSunat.mensajeUsuario.replace(/\*/g, ''),
        motivo: validacionSunat.motivo,
        ruc: comprobante.emisor?.ruc,
      });
    }

    // Validar comprobante en API oficial SUNAT (si está configurada)
    let validacionComprobante = null;
    if (process.env.SUNAT_CLIENT_ID && process.env.SUNAT_RUC_CONSULTANTE) {
      validacionComprobante = await sunat.validarComprobanteOficial(comprobante);

      // null = SUNAT no alcanzable (sin internet / timeout) → bloquear
      if (validacionComprobante === null) {
        return res.status(422).json({
          error: `❌ No se pudo verificar el comprobante en SUNAT\n\nEl servicio de SUNAT no está disponible en este momento. Verifica tu conexión a internet e intenta nuevamente.`,
          motivo: 'SUNAT_NO_DISPONIBLE',
        });
      }

      // omitido: true = comprobante extranjero o sin datos suficientes → pasar sin validar
      if (!validacionComprobante.omitido) {
        // Verificar estado del comprobante primero — solo ACEPTADO(1) o AUTORIZADO(3).
        // Cuando el documento NO EXISTE en SUNAT, los campos de estado del contribuyente
        // (estadoRuc/condDomi) vienen vacíos (no es que esté inactivo, es que SUNAT no
        // encontró el documento y no llenó esos campos) — por eso esta validación va
        // antes que la del contribuyente, para no mostrar un mensaje equivocado.
        if (!validacionComprobante.valido) {
          const mensajes = {
            '0': `❌ Comprobante NO EXISTE en SUNAT\n\nEl documento ${comprobante.serie}-${comprobante.numero} no fue informado a SUNAT. Verifica que el número y la fecha sean correctos.`,
            '2': `❌ Comprobante ANULADO en SUNAT\n\nEl documento ${comprobante.serie}-${comprobante.numero} fue dado de baja. No se puede registrar un comprobante anulado.`,
            '4': `❌ Comprobante NO AUTORIZADO en SUNAT\n\nEl documento ${comprobante.serie}-${comprobante.numero} no fue autorizado. No es un comprobante válido.`,
          };
          const mensaje = mensajes[validacionComprobante.estadoCp]
            || `❌ Comprobante rechazado por SUNAT\n\nEstado: ${validacionComprobante.estadoCpTexto}. Solo se aceptan comprobantes ACEPTADOS o AUTORIZADOS.`;

          return res.status(422).json({
            error: mensaje,
            motivo: 'COMPROBANTE_RECHAZADO_SUNAT',
            estadoCp: validacionComprobante.estadoCpTexto,
          });
        }

        // Verificar estado del contribuyente
        if (!validacionComprobante.contribuyenteActivo) {
          return res.status(422).json({
            error: `❌ Contribuyente NO ACTIVO en SUNAT\n\nEl emisor RUC ${comprobante.emisor?.ruc} figura con estado "${validacionComprobante.estadoRucTexto}". No se puede registrar comprobantes de un emisor inactivo.`,
            motivo: 'CONTRIBUYENTE_INACTIVO',
            estadoRuc: validacionComprobante.estadoRucTexto,
          });
        }

        if (!validacionComprobante.contribuyenteHabido) {
          return res.status(422).json({
            error: `❌ Contribuyente NO HABIDO en SUNAT\n\nEl emisor RUC ${comprobante.emisor?.ruc} figura como "${validacionComprobante.condDomiTexto}". SUNAT no puede ubicarlo en su domicilio fiscal.`,
            motivo: 'CONTRIBUYENTE_NO_HABIDO',
            condDomi: validacionComprobante.condDomiTexto,
          });
        }
      }
    }

    // ── Resolver cuentas del concepto de gasto + centro de costo del área ──────
    const contab = await getConfigContable(conceptoId, areaId);
    contab.conceptoId = conceptoId;
    logger.info('Config contable', { conceptoId, areaId, ...contab });

    // ── Registrar según empresa ───────────────────────────────────────────────
    let resultado;
    if (esGF) {
      resultado = await registrarCompraGF(comprobante, usuario, contab, validacionSunat.datos, periodoGF);
    } else {
      resultado = await registrarFactura(comprobante, usuario, contab, conexion, validacionSunat.datos);
    }

    // Construir estado de validación para la respuesta
    let estadoValidacion = 'NO_CONFIGURADO';
    let mensajeValidacion = null;
    if (validacionSunat.advertencia) {
      estadoValidacion = 'NO_DISPONIBLE';
      mensajeValidacion = validacionSunat.advertencia.replace(/\*/g, '');
    } else if (validacionComprobante?.omitido || validacionComprobante?.valido || !process.env.SUNAT_CLIENT_ID) {
      estadoValidacion = 'OK';
    }

    const serieNumero = comprobante.serie && comprobante.serie !== 'null'
      ? `${comprobante.serie}-${comprobante.numero}`
      : `${comprobante.numero}`;

    // ── Bitácora interna (factura_empresa_area) ───────────────────────────────
    // Registro propio de InvoBot con TODOS los datos, independiente de las tablas
    // que consume SIG Advance (COMPRAS_GF/asientos_contables).
    try {
      const mssql = require('mssql');
      const pool = await getPool();
      const empRow = await pool.request().input('cod', mssql.VarChar, empresaCodigo)
        .query('SELECT id FROM empresas WHERE codigo = @cod');
      const empresaId = empRow.recordset[0]?.id || null;
      const tipoMap = { FACTURA: '01', RECIBO_HONORARIOS: '02', BOLETA: '03', NOTA_CREDITO: '07', NOTA_DEBITO: '08', RECIBO_SERVICIOS_PUBLICOS: '14', RECIBO_ARRENDAMIENTO: '10' };
      const imp = comprobante.importes || {};
      const tc = comprobante.moneda === 'USD' ? 3.70 : 1;
      const vouBit = esGF ? resultado.comCod : resultado.voucher;
      // Fecha de registro siempre a las 00:00:00 (mismo criterio que ComFReg/CPFReg/AFECHA) —
      // como literal SQL fijo para evitar el desfase de zona horaria del objeto Date de JS.
      const ahora = new Date();
      const hoyStr = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
      const FECHA_HOY_SQL = `CAST('${hoyStr}T00:00:00.000' AS DATETIME)`;
      await pool.request()
        .input('vou', mssql.VarChar, vouBit)
        .input('empresa_id', mssql.Int, empresaId)
        .input('area_id', mssql.Int, areaId)
        .input('concepto_gasto_id', mssql.SmallInt, conceptoId)
        .input('monto', mssql.Decimal(18, 2), imp.total || 0)
        .input('moneda', mssql.VarChar, comprobante.moneda || 'PEN')
        .input('proveedor_ruc', mssql.VarChar, comprobante.emisor?.ruc || null)
        .input('proveedor_nombre', mssql.VarChar, (comprobante.emisor?.razon_social || '').substring(0, 200) || null)
        .input('tipo_doc', mssql.VarChar, tipoMap[comprobante.tipo_comprobante] || null)
        .input('serie', mssql.VarChar, comprobante.serie || null)
        .input('numero', mssql.VarChar, comprobante.numero || null)
        .input('fecha_emision', mssql.DateTime, comprobante.fecha_emision ? new Date(comprobante.fecha_emision) : null)
        .input('fecha_vcto', mssql.DateTime, comprobante.fecha_vencimiento ? new Date(comprobante.fecha_vencimiento) : null)
        .input('tipo_cambio', mssql.Decimal(10, 4), tc)
        .input('subtotal', mssql.Decimal(18, 2), imp.op_gravadas || 0)
        .input('igv', mssql.Decimal(18, 2), imp.igv || 0)
        .input('total', mssql.Decimal(18, 2), imp.total || 0)
        .input('cuenta_debe', mssql.VarChar, contab.cuentaGasto || null)
        .input('centro_costo', mssql.VarChar, contab.centroCosto || null)
        .input('usuario', mssql.VarChar, usuario.substring(0, 30))
        .input('destino', mssql.VarChar, esGF ? 'COMPRAS_GF' : 'asientos_contables')
        .query(`INSERT INTO factura_empresa_area
          (vou, empresa_id, area_id, concepto_gasto_id, monto, moneda, proveedor_ruc, proveedor_nombre,
           tipo_doc, serie, numero, fecha_emision, fecha_vcto, tipo_cambio, subtotal, igv, total,
           cuenta_debe, centro_costo, usuario, destino, fecha_registro)
          VALUES (@vou,@empresa_id,@area_id,@concepto_gasto_id,@monto,@moneda,@proveedor_ruc,@proveedor_nombre,
           @tipo_doc,@serie,@numero,@fecha_emision,@fecha_vcto,@tipo_cambio,@subtotal,@igv,@total,
           @cuenta_debe,@centro_costo,@usuario,@destino,${FECHA_HOY_SQL})`);
      logger.info('Bitácora registrada', { vou: vouBit, empresaId, areaId, conceptoId });
    } catch (bitErr) {
      logger.warn('No se pudo registrar en bitácora', { error: bitErr.message });
    }

    res.json({
      ok: true,
      mensaje: '✅ Comprobante registrado correctamente',
      voucher: esGF ? resultado.comCod : resultado.voucher,
      numero: serieNumero,
      destino: esGF ? 'COMPRAS_GF' : 'asientos_contables',
      sunat: resultado.sunat ?? null,
      validacion_sunat: {
        estado: estadoValidacion,
        estadoCp: validacionComprobante?.estadoCpTexto || null,
        estadoRuc: validacionComprobante?.estadoRuc || null,
      },
      advertencia_sunat: mensajeValidacion,
      resumen: {
        tipo: comprobante.tipo_comprobante,
        serie_numero: serieNumero,
        fecha: comprobante.fecha_emision,
        emisor: comprobante.emisor?.razon_social,
        ruc: comprobante.emisor?.ruc,
        total: comprobante.importes?.total || 0,
        moneda: comprobante.moneda,
        confianza: comprobante.confianza,
        asientos_generados: esGF ? 0 : resultado.asientos,
        destino: esGF ? 'Global Factoring — pendiente contabilizar' : 'asientos_contables',
      },
    });
  } catch (err) {
    logger.error('Error procesando factura', { error: err.message });
    res.status(500).json({ error: 'Error interno al procesar la factura.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const mssql = require('mssql');

    const rol = req.user.rol || 'usuario';
    const usuario = (req.user.email || '').split('@')[0].substring(0, 3).toUpperCase();
    const pagina = parseInt(req.query.pagina) || 1;
    const porPagina = parseInt(req.query.porPagina) || 20;

    // Los filtros (WHERE) son los mismos sin importar la conexión — se arman una
    // sola vez aquí; `buildRequest` solo agrega los valores (@input) a cada request.
    const whereParts = ['HABER > 0'];
    if (rol !== 'admin')       whereParts.push('AUSER LIKE @usuario');
    if (req.query.ruc)        whereParts.push('RUT LIKE @ruc');
    if (req.query.numero)     whereParts.push('NUMERO LIKE @numero');
    if (req.query.fechaDesde) whereParts.push('FECHAD >= @fechaDesde');
    if (req.query.fechaHasta) whereParts.push('FECHAD <= @fechaHasta');
    const where = 'WHERE ' + whereParts.join(' AND ');

    const buildRequest = (pool) => {
      const request = pool.request();
      if (rol !== 'admin')       request.input('usuario', mssql.VarChar, `${usuario}%`);
      if (req.query.ruc)        request.input('ruc', mssql.VarChar, `%${req.query.ruc}%`);
      if (req.query.numero)     request.input('numero', mssql.VarChar, `%${req.query.numero}%`);
      if (req.query.fechaDesde) request.input('fechaDesde', mssql.VarChar, req.query.fechaDesde);
      if (req.query.fechaHasta) request.input('fechaHasta', mssql.VarChar, req.query.fechaHasta);
      return request;
    };

    // Cada empresa puede vivir en un servidor/tabla distinto (ver `conexion` en
    // `empresas`) — se consulta cada uno y se combinan los resultados, en vez de
    // asumir que todo vive en la tabla principal. Se ordena por AFECHA (no por ID,
    // que no todas las tablas de destino tienen) y se limita a 2000 filas por
    // conexión antes de paginar en memoria.
    const conexiones = await getConexionesActivas();
    let filas = [];
    for (const conexion of conexiones) {
      try {
        const pool = await getPool(conexion);
        const tabla = asientosTableName(conexion);
        const result = await buildRequest(pool).query(`
          SELECT TOP 2000 MTV, VOU, GLOSA, NUMERO, FECHA, RUT, MONEDA, NETO, IGV,
            HABER AS TOTAL, SERIE, AUSER, AFECHA
          FROM ${tabla} ${where}
          ORDER BY AFECHA DESC
        `);
        filas = filas.concat(result.recordset);
      } catch (err) {
        logger.warn('No se pudo listar facturas de una conexión', { conexion, error: err.message });
      }
    }
    filas.sort((a, b) => new Date(b.AFECHA) - new Date(a.AFECHA));

    const total = filas.length;
    const offset = (pagina - 1) * porPagina;
    const pageRows = filas.slice(offset, offset + porPagina);

    res.json({
      ok: true,
      facturas: pageRows,
      rol,
      paginacion: {
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
      }
    });
  } catch (err) {
    logger.error('Error listando facturas', { error: err.message });
    res.status(500).json({ error: 'Error al listar las facturas.' });
  }
});

router.get('/empresas', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await getPool();
    const result = await pool.request().query('SELECT id, codigo, nombre FROM empresas WHERE activo = 1 ORDER BY nombre');
    res.json({ ok: true, empresas: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/areas', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await getPool();
    const result = await pool.request().query('SELECT id, codigo, nombre FROM areas WHERE activo = 1 ORDER BY nombre');
    res.json({ ok: true, areas: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conceptos-gasto', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await getPool();
    const empresaId = req.query.empresa_id ? parseInt(req.query.empresa_id, 10) : null;

    const request = pool.request();
    let where = 'WHERE Activo_ConcepGasto = 1';
    if (empresaId) {
      request.input('empresaId', mssql.Int, empresaId);
      where += ' AND empresa_id = @empresaId';
    }

    const result = await request.query(
      `SELECT Id_ConcepGasto AS id, Nombre_ConcepGasto AS nombre, Cuenta_ConcepGasto AS cuenta, Descripcion_Cuenta AS descripcion
       FROM ConceptoGasto ${where} ORDER BY Nombre_ConcepGasto`
    );
    res.json({ ok: true, conceptos: result.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/presupuesto/:empresaId/:areaId', async (req, res) => {
  try {
    const mssql = require('mssql');
    const pool = await getPool();
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
    // El número puede estar registrado en cualquiera de las conexiones configuradas.
    const conexiones = await getConexionesActivas();
    for (const conexion of conexiones) {
      const pool = await getPool(conexion);
      const tabla = asientosTableName(conexion);
      const result = await pool.request()
        .input('numero', mssql.VarChar, req.params.numero)
        .query(`SELECT SUM(HABER) AS total, MAX(MONEDA) AS moneda
                FROM ${tabla}
                WHERE NUMERO = @numero AND HABER > 0`);
      const row = result.recordset[0];
      if (row?.total) {
        return res.json({ ok: true, total: row.total, moneda: row.moneda || 'S' });
      }
    }
    res.json({ ok: true, total: 0, moneda: 'S' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pdf/:numero', async (req, res) => {
  try {
    const mssql = require('mssql');
    const PDFDocument = require('pdfkit');

    // El mismo NUMERO puede repetirse entre proveedores distintos (cada uno numera
    // sus propios documentos), así que además de buscar en todas las conexiones
    // configuradas, se exige que coincida también el RUT — si no se indica, se
    // toma el primer resultado que coincida solo por NUMERO (comportamiento previo).
    const ruc = (req.query.ruc || '').trim();
    // Se ordena por VOU (no por ID, que no todas las tablas de destino tienen) —
    // los 3 asientos de un mismo documento se insertan con VOU consecutivo, así
    // que ordenar por VOU preserva el mismo orden (gasto, IGV, por pagar).
    const conexiones = await getConexionesActivas();
    let result = { recordset: [] };
    for (const conexion of conexiones) {
      const pool = await getPool(conexion);
      const tabla = asientosTableName(conexion);
      const request = pool.request().input('numero', mssql.VarChar, req.params.numero);
      let where = 'WHERE NUMERO = @numero';
      if (ruc) {
        request.input('ruc', mssql.VarChar, ruc);
        where += ' AND RUT = @ruc';
      }
      const r = await request.query(`SELECT * FROM ${tabla} ${where} ORDER BY VOU ASC`);
      if (r.recordset.length > 0) { result = r; break; }
    }

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

// NOTA: el antiguo endpoint POST /vincular fue eliminado. La bitácora
// (factura_empresa_area) ahora se escribe directamente en POST / al registrar,
// con todos los datos del comprobante.

router.delete('/:vou', requireAdmin, async (req, res) => {
  try {
    const { vou } = req.params;
    const mssql = require('mssql');

    // El VOU es único dentro de cada conexión, pero para evitar borrar el documento
    // equivocado si por coincidencia el mismo VOU existiera en dos conexiones
    // distintas, se exige también que coincida el RUT cuando se indica.
    const ruc = (req.query.ruc || '').trim();
    const conexiones = await getConexionesActivas();
    for (const conexion of conexiones) {
      const pool = await getPool(conexion);
      const tabla = asientosTableName(conexion);
      const request = pool.request().input('vou', mssql.VarChar, vou);
      let where = 'WHERE VOU = @vou';
      if (ruc) {
        request.input('ruc', mssql.VarChar, ruc);
        where += ' AND RUT = @ruc';
      }
      await request.query(`DELETE FROM ${tabla} ${where}`);
    }

    // Eliminar de la bitácora (siempre vive en la conexión principal)
    const poolDefault = await getPool();
    await poolDefault.request()
      .input('vou', mssql.VarChar, vou)
      .query('DELETE FROM factura_empresa_area WHERE vou = @vou');

    logger.info('Documento eliminado', { vou });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Error al eliminar documento', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// NOTA: los antiguos endpoints de depuración GET /validar-ruc/:ruc y GET /test-sunat
// se retiraron antes de producción — no los usa el frontend y exponían la validación
// SUNAT (cuota/costo) sin ningún propósito operativo.

module.exports = router;