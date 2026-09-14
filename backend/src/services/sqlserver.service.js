const sql = require('mssql');
const logger = require('../utils/logger');
const { getPool } = require('../config/database');
const { obtenerTipoCambioSunat } = require('./sunat.service');

function mapTipoDoc(tipo) {
  return {
    FACTURA: '01',
    BOLETA: '03',
    NOTA_CREDITO: '07',
    NOTA_DEBITO: '08',
    RECIBO_HONORARIOS: '02',
    RECIBO_SERVICIOS_PUBLICOS: '14',
    RECIBO_ARRENDAMIENTO: '10',
  }[tipo] || '01';
}

function mapMoneda(moneda) {
  return moneda === 'USD' ? 'D' : 'S';
}

// Mismo criterio que Global Factoring (compras.service.js): RUC sin 11 dígitos o sin
// prefijo peruano válido (10/15/16/17/20/25) = extranjero, más una lista de VAT
// extranjeros conocidos que por coincidencia sí calzan con ese formato (ej. Anthropic).
const RUC_EXTRANJEROS_CONOCIDOS_GGO = new Set([
  '20615875547', // Anthropic
  ...(process.env.RUC_EXTRANJEROS_CONOCIDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
function esRucExtranjero(ruc) {
  const r = (ruc || '').trim();
  return RUC_EXTRANJEROS_CONOCIDOS_GGO.has(r) || !/^(10|15|16|17|20|25)\d{9}$/.test(r);
}

// Detección de pasajes/boletos aéreos por palabras clave en el documento (razón
// social del emisor, observaciones y descripción de las líneas) — no hay un
// tipo_comprobante propio para esto, así que se reconoce por contenido.
// "pasaje" solo (sin calificar) es demasiado genérico — hace match como substring
// dentro de "pasajeros" y clasificaba transporte terrestre (buses interprovinciales)
// como pasaje aéreo por error. Ahora exige que "pasaje"/"boleto"/"billete" venga
// calificado como aéreo/avión, o palabras que ya son inequívocamente de vuelo.
const PALABRAS_PASAJE_AEREO = /pasaje\s*(a[eé]reo|de\s*avi[oó]n)|boleto\s*a[eé]reo|billete\s*a[eé]reo|itinerario\s*de\s*vuelo|aerol[ií]nea|e-?ticket/i;
function esPasajeAereo(comprobante) {
  const textos = [
    comprobante.emisor?.razon_social,
    comprobante.observaciones,
    ...(comprobante.lineas || []).map((l) => l.descripcion),
  ].filter(Boolean).join(' ');
  return PALABRAS_PASAJE_AEREO.test(textos);
}

// Nombre real de la tabla de asientos contables, configurable por conexión
// (ej. ASIENTOS_TABLE_GGO=SISCONT.dbo.asientos si en el servidor de Global Go
// se llama distinto). Por defecto, 'asientos_contables' tal como en InvoiceGG.
function asientosTableName(conexion) {
  const key = (conexion || 'DEFAULT').toUpperCase();
  return process.env[`ASIENTOS_TABLE_${key}`] || 'asientos_contables';
}

// Algunas conexiones (ej. GGO) escriben directo en la tabla real de SISCONT (MDH_VOU),
// que usa un esquema de numeración distinto al propio de InvoiceGG (asientos_contables):
//   - VOU es decimal(5,0): un correlativo simple que reinicia cada mes (MESV), y las
//     3 líneas de un mismo asiento comparten el mismo VOU.
//   - MTV es char(13): usuario (5, con espacios de relleno) + MESV (2) + correlativo de
//     6 dígitos que sigue GLOBAL entre meses (no reinicia), uno distinto por línea.
// Activar con VOU_NUMERIC_<KEY>=1 en el .env de esa conexión.
function usaEsquemaSiscont(conexion) {
  const key = (conexion || 'DEFAULT').toUpperCase();
  return process.env[`VOU_NUMERIC_${key}`] === '1';
}

// Tabla de proveedores en SISCONT (ej. MDH_PC de Global Go), configurable por conexión.
function proveedoresTableName(conexion) {
  const key = (conexion || 'DEFAULT').toUpperCase();
  return process.env[`PROVEEDORES_${key}`] || 'MDH_PC';
}

// Tabla maestra de tipo de cambio en SISCONT (MDH_TC de Global Go), configurable
// por conexión. FECHA (smalldatetime), TC (compra) y TV (venta) — TV es el valor
// que se usa para el TC de la factura, según contabilidad.
function tipoCambioTableName(conexion) {
  const key = (conexion || 'DEFAULT').toUpperCase();
  return process.env[`TIPOCAMBIO_${key}`] || 'MDH_TC';
}

/**
 * Asegura que MDH_TC tenga el tipo de cambio para la fecha de emisión de una
 * factura en dólares — si falta, lo consulta de SUNAT (vía apis.net.pe) y lo
 * inserta. Retorna el TV (venta) vigente para esa fecha, ya sea porque ya
 * existía o porque se acaba de insertar.
 */
async function asegurarTipoCambioGGO(transaction, fechaEmision, tabla) {
  const fechaStr = `${fechaEmision.getFullYear()}-${String(fechaEmision.getMonth() + 1).padStart(2, '0')}-${String(fechaEmision.getDate()).padStart(2, '0')}`;
  const FECHA_SQL = `CAST('${fechaStr}T00:00:00.000' AS DATETIME)`;

  const existe = await new sql.Request(transaction)
    .query(`SELECT TV FROM ${tabla} WHERE FECHA = ${FECHA_SQL}`);
  if (existe.recordset.length > 0) return existe.recordset[0].TV;

  const tipoCambio = await obtenerTipoCambioSunat(fechaStr);
  if (!tipoCambio) {
    throw new Error(`No se pudo obtener el tipo de cambio SUNAT para ${fechaStr}. Intenta registrar la factura nuevamente en unos minutos.`);
  }

  await new sql.Request(transaction)
    .input('tc', sql.Decimal(12, 7), tipoCambio.compra)
    .input('tv', sql.Decimal(12, 7), tipoCambio.venta)
    .query(`INSERT INTO ${tabla} (FECHA, TC, TV) VALUES (${FECHA_SQL}, @tc, @tv)`);
  logger.info('Tipo de cambio registrado en MDH_TC', { fecha: fechaStr, tc: tipoCambio.compra, tv: tipoCambio.venta });
  return tipoCambio.venta;
}

/**
 * Da de alta en la tabla de proveedores de SISCONT (MDH_PC) una empresa peruana
 * validada por SUNAT, si el RUC todavía no existe ahí. `sunatDatos` solo viene
 * poblado cuando validarEmisorNacional confirmó RUC+serie peruana — proveedores
 * extranjeros nunca llegan a esta función con datos, así que no se registran.
 * Columnas no indicadas quedan con su default de MDH_PC (espacios/0), igual que
 * el resto de proveedores reales de la tabla.
 */
async function asegurarProveedorGGO(transaction, ruc, sunatDatos, tabla) {
  if (!ruc || !sunatDatos) return;

  const check = await new sql.Request(transaction)
    .input('rut', sql.VarChar, ruc)
    .query(`SELECT COUNT(*) AS cnt FROM ${tabla} WHERE RTRIM(RUT) = @rut`);
  if (check.recordset[0].cnt > 0) return;

  const razonSocial = (sunatDatos.razon_social || '').substring(0, 60).toUpperCase();
  const direccion = (sunatDatos.direccion || '').substring(0, 40).toUpperCase();

  await new sql.Request(transaction)
    .input('rut', sql.Char(15), ruc)
    .input('rs', sql.Char(60), razonSocial)
    .input('di', sql.Char(40), direccion)
    .input('codigo', sql.Char(15), ruc)
    .query(`INSERT INTO ${tabla} (RUT, PNJ, RS, TIPO, DI, CODIGO)
      VALUES (@rut, '6', @rs, '1', @di, @codigo)`);
  logger.info('Proveedor registrado en MDH_PC (GGO)', { ruc, razonSocial });
}

async function validarRucSunat(ruc) {
  try {
    const axios = require('axios');
    const res = await axios.get(`https://api.apis.net.pe/v2/sunat/ruc?numero=${ruc}`, { timeout: 5000 });
    logger.info('SUNAT validación', { ruc, estado: res.data?.estado, condicion: res.data?.condicion });
    return {
      activo: res.data?.estado === 'ACTIVO',
      estado: res.data?.estado || 'DESCONOCIDO',
      razon_social: res.data?.razon_social || res.data?.nombre || null,
      condicion: res.data?.condicion || null,
    };
  } catch (err) {
    logger.warn('SUNAT no disponible', { ruc, error: err.message });
    return null;
  }
}

/**
 * Resuelve la configuración contable a partir del concepto de gasto y el área.
 * - cuentaGasto/cuentaIgv/cuentaPorPagar salen de ConceptoGasto
 * - centroCosto sale de areas.centro_costo
 */
async function getConfigContable(conceptoId, areaId) {
  const db = await getPool();
  const out = { cuentaGasto: null, cuentaIgv: null, cuentaPorPagar: null, centroCosto: null };

  // Modelo del SIG: cada concepto tiene su cuenta fija (la función 94/95 ya viene
  // incorporada en el concepto elegido; no se deriva del área).
  if (conceptoId) {
    const r = await db.request()
      .input('id', sql.SmallInt, conceptoId)
      .query('SELECT Cuenta_ConcepGasto, Cuenta_IGV, Cuenta_PorPagar FROM ConceptoGasto WHERE Id_ConcepGasto = @id');
    if (r.recordset[0]) {
      out.cuentaGasto    = r.recordset[0].Cuenta_ConcepGasto;
      out.cuentaIgv      = r.recordset[0].Cuenta_IGV;
      out.cuentaPorPagar = r.recordset[0].Cuenta_PorPagar;
    }
  }

  if (areaId) {
    const r = await db.request()
      .input('id', sql.Int, areaId)
      .query('SELECT centro_costo FROM areas WHERE id = @id');
    if (r.recordset[0]) out.centroCosto = r.recordset[0].centro_costo;
  }

  return out;
}

async function registrarFactura(comprobante, usuario = 'BOT', contab = {}, conexion = 'DEFAULT', sunatDatos = null) {
  const db = await getPool(conexion);
  const tablaAsientos = asientosTableName(conexion);
  const tablaProveedores = proveedoresTableName(conexion);
  const tablaTipoCambio = tipoCambioTableName(conexion);
  const esquemaSiscont = usaEsquemaSiscont(conexion);
  const transaction = new sql.Transaction(db);
  await transaction.begin();

  try {
    const fecha = new Date();
    const mesv = String(fecha.getMonth() + 1).padStart(2, '0');
    const ahora = fecha.toTimeString().substring(0, 8);
    // Fecha de registro (FECHA/AFECHA) siempre a las 00:00:00 — se escribe como
    // literal SQL fijo (no como objeto Date de JS) por la misma razón que en
    // CPCOMPRAS/CPCUENTAPAGAR: el driver serializa el DateTime con sus valores
    // UTC, y una "medianoche" en hora local de Lima (UTC-5) llega como 05:00 UTC.
    const hoyStr = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
    const FECHA_HOY_SQL = `CAST('${hoyStr}T00:00:00.000' AS DATETIME)`;
    const fechaEmision = comprobante.fecha_emision ? new Date(comprobante.fecha_emision) : fecha;
    const fechaVencimiento = comprobante.fecha_vencimiento ? new Date(comprobante.fecha_vencimiento) : fechaEmision;
    const moneda = mapMoneda(comprobante.moneda);
    const tipoDoc = mapTipoDoc(comprobante.tipo_comprobante);
    const total = comprobante.importes?.total || 0;
    const igvRaw = comprobante.importes?.igv || 0;
    const netoRaw = comprobante.importes?.op_gravadas || 0;
    // Para boletas y recibos por honorarios el total va directo al neto si no hay desglose
    const neto = netoRaw > 0 ? netoRaw : (igvRaw === 0 ? total : netoRaw);
    const igv = igvRaw;
    // Para Global Go, la glosa debe ser la descripción del documento (lo que dice
    // el comprobante, ej. "LEGALIZACION DE FIRMA", "SERVICIO DE MOVILIDAD"), no la
    // razón social del emisor — así lo maneja el resto de asientos reales en MDH_VOU.
    const descripcionDoc = (comprobante.lineas || [])
      .map((l) => l.descripcion)
      .filter(Boolean)
      .join(' / ');
    const glosa = esquemaSiscont && descripcionDoc
      ? descripcionDoc.substring(0, 60).toUpperCase()
      : `${comprobante.emisor?.razon_social || ''} - ${comprobante.serie || ''}-${comprobante.numero || ''}`.substring(0, 60).toUpperCase();
    const rut = comprobante.emisor?.ruc || '';

    // Tipo de cambio: en SISCONT, TC siempre lleva el tipo de cambio real del día,
    // sea la factura en soles o en dólares (confirmado contra registros reales —
    // no es un multiplicador que solo aplica a dólares). Se usa el TV (venta) de
    // MDH_TC para la fecha de emisión; si le falta esa fecha, se completa sola
    // consultando a SUNAT.
    const tc = await asegurarTipoCambioGGO(transaction, fechaEmision, tablaTipoCambio);

    // Alta automática del proveedor en MDH_PC (solo empresas peruanas validadas por SUNAT).
    await asegurarProveedorGGO(transaction, rut, sunatDatos, tablaProveedores);

    // Normalizar número = serie-numero, mismo formato que ComCod en Global
    // Factoring (ej. F001-2442), sin ceros de relleno entre el guion y el correlativo.
    const serieRaw = (comprobante.serie && comprobante.serie !== 'null' ? comprobante.serie : '').trim();
    const numeroRaw = (comprobante.numero || '').replace(/^0+/, '').trim();
    const numero = serieRaw ? `${serieRaw}-${numeroRaw}` : numeroRaw;

    // Validar RUC contra SUNAT (no bloqueante)
    const sunat = null;
    if (sunat && !sunat.activo) {
      logger.warn('Proveedor inactivo en SUNAT', { ruc: rut, estado: sunat.estado });
    }

    // Cuentas: del concepto de gasto (con fallback a las genéricas).
    // Por pagar: RxH → honorarios; dólares → ME; soles → MN.
    // Global Go usa las cuentas "hija" de 6 dígitos (donde realmente se contabiliza),
    // no la cuenta "padre" agrupadora de 5 — confirmado contra el plan de cuentas real
    // (ej. 401111 "IGV-CUENTA PROPIA", no 40111 que es solo la agrupadora "IGV Cuenta propia").
    const esRxH = comprobante.tipo_comprobante === 'RECIBO_HONORARIOS';
    const esUSD = comprobante.moneda === 'USD';
    const cuentaGasto    = contab.cuentaGasto || '635601';
    const cuentaIgv      = contab.cuentaIgv || (esquemaSiscont ? '401111' : '40111');
    const cuentaPorPagar = esRxH
      ? (esquemaSiscont ? (esUSD ? '424200' : '424100') : '4241')
      : (esUSD
        ? (esquemaSiscont ? '421220' : '42122')
        : (contab.cuentaPorPagar || (esquemaSiscont ? '421210' : '42121')));

    // Tipo de asiento (columna T) y tipo de libro (columna TL, en la línea del IGV):
    //   T=06/TL=H → Recibo por Honorarios (libro de Honorarios)
    //   T=05/TL=C → Boleta electrónica, pasaje/boleto aéreo, o factura de emisor
    //               extranjero (libro de Compras, pero asiento tipo "Diario")
    //   T=01/TL=C → todo lo demás (factura nacional, notas, recibos de servicios/
    //               arrendamiento) — comportamiento por defecto, sin cambios.
    // Se calcula ANTES del correlativo de VOU (justo abajo) porque cada T lleva su
    // propio correlativo independiente por MESV — ver comentario ahí.
    const esBoleta = comprobante.tipo_comprobante === 'BOLETA';
    const esExtranjero = esRucExtranjero(rut);
    const pasajeAereo = esPasajeAereo(comprobante);
    let tipoT, tlIgv;
    if (esRxH) {
      tipoT = '06';
      tlIgv = 'H';
    } else if (esExtranjero || esBoleta || pasajeAereo) {
      tipoT = '05';
      tlIgv = 'C';
    } else {
      tipoT = '01';
      tlIgv = 'C';
    }

    // Obtener siguiente número de voucher.
    // Esquema SISCONT real (ej. MDH_VOU de Global Go): VOU es un correlativo numérico que
    // reinicia cada mes (MESV) — las 3 líneas de un asiento comparten el mismo VOU. MTV es
    // usuario(5) + mes(2) + correlativo de 6 dígitos que sigue GLOBAL entre meses.
    // Esquema propio de InvoiceGG (asientos_contables): VOU es texto "AAAAMM####".
    // IMPORTANTE: cada tipo de asiento (T=01, 05, 06...) lleva su propio correlativo
    // de VOU independiente dentro del mismo MESV — mezclarlos rompía la numeración
    // esperada por SISCONT (ej. los Recibos por Honorarios no se visualizaban en su
    // tabla porque el VOU venía de un correlativo compartido con las facturas T=01).
    let vouBase, siguienteMtv, usuarioMtv;
    const anio = String(fecha.getFullYear());
    const prefix = `${anio}${mesv}`;
    if (esquemaSiscont) {
      const vouRes = await new sql.Request(db).query(
        `SELECT ISNULL(MAX(VOU), 0) + 1 AS NEXT_VOU FROM ${tablaAsientos} WHERE MESV = '${mesv}' AND T = '${tipoT}'`
      );
      vouBase = vouRes.recordset[0].NEXT_VOU;

      // El correlativo de 6 dígitos de MTV es propio de cada usuario, y reinicia
      // cada mes en 200001 (base 200000) — confirmado contra datos reales de
      // SISCONT (ej. ANA/GTERR/YOSAI arrancan en 200001 cada MESV). Filtrar solo
      // por usuario + MESV; antes se tomaba el máximo global de toda la tabla, sin
      // reiniciar nunca ni separar por usuario.
      usuarioMtv = usuario.substring(0, 5).toUpperCase().padEnd(5);
      const mtvRes = await new sql.Request(db)
        .input('usuarioMtv', sql.Char(5), usuarioMtv)
        .query(`SELECT ISNULL(MAX(CAST(RIGHT(MTV, 6) AS INT)), 200000) AS MAX_MTV
                FROM ${tablaAsientos} WHERE LEFT(MTV, 5) = @usuarioMtv AND MESV = '${mesv}'`);
      siguienteMtv = mtvRes.recordset[0].MAX_MTV;
    } else {
      const voucherRes = await new sql.Request(db).query(
        `SELECT ISNULL(MAX(CAST(SUBSTRING(VOU, 7, 4) AS INT)), 0) + 1 AS NEXT_VOU
         FROM ${tablaAsientos}
         WHERE VOU LIKE '${prefix}%'`
      );
      const correlativo = String(voucherRes.recordset[0].NEXT_VOU).padStart(4, '0');
      vouBase = `${prefix}${correlativo}`;
    }

    const asientos = [
      { cuenta: cuentaGasto,    debe: neto,  haber: 0,     tl: ' ' },
      { cuenta: cuentaIgv,      debe: igv,   haber: 0,     tl: tlIgv },
      { cuenta: cuentaPorPagar, debe: 0,     haber: total, tl: ' ' },
    ];

    for (let i = 0; i < asientos.length; i++) {
      const a = asientos[i];
      let mtv, vouInput;
      if (esquemaSiscont) {
        siguienteMtv += 1;
        mtv = `${usuarioMtv}${mesv}${String(siguienteMtv).padStart(6, '0')}`;
        vouInput = { type: sql.Decimal(5, 0), value: vouBase };
      } else {
        const voucher = String(parseInt(vouBase.slice(-4)) + i).padStart(4, '0');
        const voucherCompleto = `${prefix}${voucher}`;
        mtv = `${usuario.substring(0, 3).toUpperCase().padEnd(3)} ${voucherCompleto}`;
        vouInput = { type: sql.VarChar, value: voucherCompleto };
      }
      const req = new sql.Request(transaction);
      await req
        .input('mtv',    esquemaSiscont ? sql.Char(13) : sql.VarChar, mtv)
        .input('mesv',   sql.VarChar,       mesv)
        .input('vou',    vouInput.type,     vouInput.value)
        .input('cuenta', sql.VarChar,       a.cuenta)
        .input('debe',   sql.Decimal(18,2), a.debe)
        .input('haber',  sql.Decimal(18,2), a.haber)
        .input('glosa',  sql.VarChar,       glosa)
        .input('tl',     sql.VarChar,       a.tl)
        .input('numero', sql.VarChar,       numero)
        .input('doc',    sql.VarChar,       tipoDoc)
        .input('fechad', sql.DateTime,      fechaEmision)
        .input('rut',    sql.VarChar,       rut)
        .input('fechav', sql.DateTime,      fechaVencimiento)
        .input('tc',     sql.Decimal(10,4), tc)
        .input('moneda', sql.VarChar,       moneda)
        .input('neto',   sql.Decimal(18,2), neto)
        .input('igv',    sql.Decimal(18,2), igv)
        .input('auser',  sql.VarChar,       esquemaSiscont ? usuario.substring(0, 5) : usuario.substring(0, 10))
        .input('ahora',  sql.VarChar,       ahora)
        .input('serie',  sql.VarChar,       comprobante.serie || '')
        .query(`INSERT INTO ${tablaAsientos}
          (MTV,MESV,T,VOU,CUENTA,DEBE,HABER,GLOSA,TL,NUMERO,FECHA,SALDO,DOC,FECHAD,RUT,FECHAV,TC,MONEDA,NETO,IGV,AUSER,AFECHA,AHORA,SERIE)
          VALUES(@mtv,'${mesv}','${tipoT}',@vou,@cuenta,@debe,@haber,@glosa,@tl,@numero,${FECHA_HOY_SQL},0,@doc,@fechad,@rut,@fechav,@tc,@moneda,@neto,@igv,@auser,${FECHA_HOY_SQL},@ahora,@serie)`);
    }

    await transaction.commit();
    logger.info('Factura registrada en SQL Server', { numero, total, asientos: asientos.length, sunat: sunat?.estado });
    return {
      voucher: String(vouBase),
      numero,
      asientos: asientos.length,
      total,
      sunat,
    };

  } catch (err) {
    await transaction.rollback();
    logger.error('Error en SQL Server', { error: err.message });
    throw err;
  }
}

async function checkDuplicate(serie, numero, ruc, conexion = 'DEFAULT') {
  const db = await getPool(conexion);
  const serieRaw = (serie || '').trim();
  const numeroRaw = (numero || '').replace(/^0+/, '').trim();
  const numeroCompleto = serieRaw ? `${serieRaw}-${numeroRaw}` : numeroRaw;
  const tablaAsientos = asientosTableName(conexion);
  const res = await db.request()
    .input('numero', sql.VarChar, numeroCompleto)
    .input('rut', sql.VarChar, ruc)
    .query(`SELECT COUNT(*) AS cnt FROM ${tablaAsientos} WHERE NUMERO = @numero AND RUT = @rut`);
  return res.recordset[0].cnt > 0;
}

module.exports = { registrarFactura, checkDuplicate, getConfigContable, asientosTableName };