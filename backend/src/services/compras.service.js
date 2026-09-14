const sql = require('mssql');
const logger = require('../utils/logger');
const { getPool } = require('../config/database');
const { obtenerTipoCambioSunat } = require('./sunat.service');

// Proveedores extranjeros cuyo VAT/Tax ID, por pura coincidencia, tiene el mismo formato
// que un RUC peruano válido (11 dígitos, prefijo correcto e incluso dígito verificador
// correcto — ej. Anthropic: 20615875547) y por eso ningún chequeo de formato los detecta
// como extranjeros. Se listan explícitamente acá para forzar TipCod = '00' igual.
// Se puede agregar más sin tocar código: RUC_EXTRANJEROS_CONOCIDOS=numero1,numero2 en .env
const RUC_EXTRANJEROS_CONOCIDOS = new Set([
  '20615875547', // Anthropic
  ...(process.env.RUC_EXTRANJEROS_CONOCIDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

// Bancos peruanos: cuando el proveedor es uno de estos RUC Y el concepto de gasto está
// asociado a la cuenta 946391 (comisiones bancarias), la línea de CPCOMPRASDET debe ir
// marcada distinto (ComDTip = 1) según lo indicado por contabilidad.
const RUC_BANCOS_CONOCIDOS = new Set([
  '20100047218', // BCP
  '20100130204', // BBVA
  '20100053455', // Interbank
  '20100043140', // Scotiabank
  ...(process.env.RUC_BANCOS_CONOCIDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const CUENTA_COMISION_BANCARIA = '946391';

// Contabilidad tiene hasta el día 10 de cada mes para seguir registrando comprobantes
// del mes anterior (ej. facturas de agosto se pueden registrar hasta el 10 de
// septiembre). Este helper valida el período que elige el usuario en el frontend y
// devuelve el "AAAAMM" a usar para el correlativo ComRef — nunca la fecha real de
// registro (ComFReg), que siempre queda como la fecha real en que se procesó.
const DIA_LIMITE_PERIODO_ANTERIOR = 10;

function yyyymmDe(fecha) {
  return `${fecha.getFullYear()}${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

function resolverPeriodoGF(periodoInput, ahora = new Date()) {
  const actual = yyyymmDe(ahora);
  if (!periodoInput) return { yyyymm: actual };

  const yyyymm = String(periodoInput).replace(/\D/g, '').slice(0, 6);
  if (yyyymm === actual) return { yyyymm };

  const mesAnteriorFecha = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
  const anterior = yyyymmDe(mesAnteriorFecha);
  if (yyyymm === anterior) {
    if (ahora.getDate() <= DIA_LIMITE_PERIODO_ANTERIOR) return { yyyymm };
    return {
      error: `Ya pasó el plazo para registrar el período ${anterior} — solo se permite hasta el día ${DIA_LIMITE_PERIODO_ANTERIOR} del mes siguiente.`,
    };
  }

  return {
    error: `Período ${periodoInput} no permitido. Solo se puede registrar el mes actual (${actual})`
      + (ahora.getDate() <= DIA_LIMITE_PERIODO_ANTERIOR ? ` o el mes anterior (${anterior}, hasta el día ${DIA_LIMITE_PERIODO_ANTERIOR}).` : '.'),
  };
}

// Abreviaturas (no el código numérico de SUNAT) para que el documento
// aparezca correctamente en la grilla del SIG Advance.
const tipCodMap = {
  FACTURA:                   'FAC',
  BOLETA:                    'BOL',
  NOTA_CREDITO:              'NC',
  NOTA_DEBITO:               'ND',
  RECIBO_HONORARIOS:         'REH',
  RECIBO_SERVICIOS_PUBLICOS: 'SEP',
  RECIBO_ARRENDAMIENTO:      'ARR',
};

function tableNames() {
  return {
    compras:     process.env.GF_TABLE_COMPRAS      || 'COMPRAS_GF',
    comprasdet:  process.env.GF_TABLE_COMPRASDET   || 'COMPRASDET_GF',
    cuentapagar: process.env.GF_TABLE_CUENTAPAGAR  || 'CPCUENTAPAGAR',
    proveedores: process.env.GF_TABLE_PROVEEDORES  || 'CPPROVEEDORES',
    distritos:   process.env.GF_TABLE_DISTRITOS    || 'CDISTRITOS',
    tipocambio:  process.env.GF_TABLE_TIPOCAMBIO   || 'CTIPOCAMBIO',
  };
}

// Descompone el ubigeo de 6 dígitos que devuelve SUNAT (departamento+provincia+distrito,
// 2 dígitos cada uno, ej. "150114" = Lima/Lima/Miraflores) en los códigos que usa
// CDISTRITOS. Si el ubigeo no viene o no tiene el formato esperado, cae a Lima/Lima/Lima
// (EstCod=15, ProvCod=01, DisCod=01) en vez de bloquear el registro.
function resolverUbigeoPeru(ubigeo) {
  const soloDigitos = (ubigeo || '').replace(/\D/g, '');
  if (soloDigitos.length === 6) {
    return { estCod: soloDigitos.slice(0, 2), provCod: soloDigitos.slice(2, 4), disCod: soloDigitos.slice(4, 6) };
  }
  return { estCod: '15', provCod: '01', disCod: '01' };
}

// Asegura que CTIPOCAMBIO (tabla maestra de SIG Advance) tenga el tipo de cambio real
// para la fecha de emisión de una factura en dólares — si falta, SIG Advance calcula
// el TC como 1.000 por defecto al no encontrar la fecha. Usa TipMonCod=2 (dólares) y
// TipVenta como el valor de referencia, según lo indicado por contabilidad.
async function asegurarTipoCambioGF(transaction, fechaEmision, tabla) {
  const fechaStr = `${fechaEmision.getFullYear()}-${String(fechaEmision.getMonth() + 1).padStart(2, '0')}-${String(fechaEmision.getDate()).padStart(2, '0')}`;
  const FECHA_SQL = `CAST('${fechaStr}T00:00:00.000' AS DATETIME)`;

  const existe = await new sql.Request(transaction)
    .query(`SELECT 1 FROM ${tabla} WHERE TipMonCod = 2 AND TipFech = ${FECHA_SQL}`);
  if (existe.recordset.length > 0) return;

  const tc = await obtenerTipoCambioSunat(fechaStr);
  if (!tc) {
    throw new Error(`No se pudo obtener el tipo de cambio SUNAT para ${fechaStr}. Intenta registrar la factura nuevamente en unos minutos.`);
  }

  await new sql.Request(transaction)
    .input('compra', sql.Decimal(14, 5), tc.compra)
    .input('venta',  sql.Decimal(14, 5), tc.venta)
    .query(`INSERT INTO ${tabla} (TipMonCod, TipFech, TipCompra, TipVenta) VALUES (2, ${FECHA_SQL}, @compra, @venta)`);
  logger.info('Tipo de cambio registrado en CTIPOCAMBIO', { fecha: fechaStr, compra: tc.compra, venta: tc.venta });
}

// Da de alta al proveedor en CPPROVEEDORES si su RUC todavía no existe ahí — solo para
// proveedores con RUC/domicilio fiscal peruano (los extranjeros se gestionan a mano,
// como ya está la tabla hoy). Usa la plantilla de alta manual tal cual, reemplazando
// solo los datos propios del proveedor (RUC, razón social, dirección, ubicación).
async function asegurarProveedorPeru(transaction, ruc, sunatDatos, comprobante, tablas) {
  const reqBuscar = new sql.Request(transaction);
  const existe = await reqBuscar
    .input('prvCod', sql.NVarChar(20), ruc)
    .query(`SELECT 1 FROM ${tablas.proveedores} WHERE PrvCod = @prvCod`);
  if (existe.recordset.length > 0) return;

  const { estCod, provCod, disCod } = resolverUbigeoPeru(sunatDatos?.ubigeo);
  // Si por algo no llegaron los datos de SUNAT (servicio caído, etc.), usa lo que ya
  // extrajo la IA del documento en vez de dejar estos campos vacíos.
  const razonSocial = (sunatDatos?.razon_social || comprobante.emisor?.razon_social || '').substring(0, 100);
  const direccion   = (sunatDatos?.direccion || comprobante.emisor?.direccion || '').substring(0, 100);

  // Verifica que el distrito exista en CDISTRITOS; si el ubigeo de SUNAT no calza con
  // ningún registro real, cae a Lima/Lima/Lima en vez de insertar un código inválido.
  const reqDist = new sql.Request(transaction);
  const distritoOk = await reqDist
    .input('estCod', sql.NVarChar(4), estCod)
    .input('provCod', sql.NVarChar(4), provCod)
    .input('disCod', sql.NVarChar(4), disCod)
    .query(`SELECT 1 FROM ${tablas.distritos} WHERE PaiCod = '01' AND EstCod = @estCod AND ProvCod = @provCod AND DisCod = @disCod`);
  const ubicacion = distritoOk.recordset.length > 0
    ? { estCod, provCod, disCod }
    : { estCod: '15', provCod: '01', disCod: '01' };
  if (distritoOk.recordset.length === 0) {
    logger.warn('Ubigeo de SUNAT no coincide con CDISTRITOS, usando Lima por defecto', { ruc, ubigeo: sunatDatos?.ubigeo });
  }

  const reqInsert = new sql.Request(transaction);
  await reqInsert
    .input('PrvCod', sql.NVarChar(20), ruc)
    .input('PrvDsc', sql.NVarChar(100), razonSocial)
    .input('PrvDir', sql.NVarChar(100), direccion)
    .input('EstCod', sql.NVarChar(4), ubicacion.estCod)
    .input('DisCod', sql.NVarChar(4), ubicacion.disCod)
    .input('ProvCod', sql.NVarChar(4), ubicacion.provCod)
    .input('PrvUsuCod', sql.NVarChar(10), 'ENTER')
    .query(`INSERT INTO ${tablas.proveedores}
      (PrvCod,PrvDsc,PrvDir,EstCod,PaiCod,PrvTel1,PrvTel2,PrvFax,PrvCel,PrvEM,PrvWeb,TprvCod,PrvSts,
       PrvRef1,PrvRef2,PrvRef3,PrvRef4,PrvRef5,PrvRef6,PrvRef7,PrvRef8,
       PrvCon1,PrvCTel1,PrvCon2,PrvCTel2,PrvCon3,PrvCTel3,PrvCon4,PrvCTel4,PrvCon5,PrvCTel5,
       PrvNom,PrvAPeP,PrvAPeM,DisCod,ProvCod,PrvVincula,PrvRetencion,PrvTipCuenta1,PrvTipCuenta2,PrvBanCuenta1,PrvBanCuenta2,PrvTCon,
       PrvUsuCod,PrvUsuFec,PrvUsuCodM,PrvUsuFecM,PrvWebUsu,PrvWebPas,PrvWebFec,TipSCod)
      VALUES (@PrvCod,@PrvDsc,@PrvDir,@EstCod,'01','','','','','','',4,1,'','','','','','','','',
       '','','','','','','','','','',
       '','','',@DisCod,@ProvCod,0,0,'','','','',0,
       @PrvUsuCod,GETDATE(),'',GETDATE(),'','',GETDATE(),1)`);

  logger.info('Proveedor nuevo registrado en CPPROVEEDORES', { ruc, razonSocial, ubicacion });
}

async function registrarCompraGF(comprobante, usuario = 'BOT', contab = {}, sunatDatos = null, periodoYYYYMM = null) {
  const db = await getPool();
  const transaction = new sql.Transaction(db);
  await transaction.begin();
  const tablas = tableNames();
  const { compras, comprasdet, cuentapagar } = tablas;

  try {
    const ahora = new Date();

    // Fecha de registro (ComFReg/CPFReg): normalmente hoy. Pero si el usuario eligió
    // registrar bajo el período del mes anterior (dentro del plazo de 10 días — ver
    // resolverPeriodoGF), el usuario final autorizó que la fecha de registro quede
    // como el ÚLTIMO DÍA de ese mes anterior (ej. 31/08 para período agosto), para
    // que el filtro por fecha del sistema lo muestre en el mes que corresponde
    // contablemente y no en el mes en que realmente se subió el documento.
    let fechaRegistro = ahora;
    if (periodoYYYYMM && periodoYYYYMM !== yyyymmDe(ahora)) {
      const anio = parseInt(periodoYYYYMM.slice(0, 4), 10);
      const mes = parseInt(periodoYYYYMM.slice(4, 6), 10);
      const ultimoDia = new Date(anio, mes, 0).getDate();
      fechaRegistro = new Date(anio, mes - 1, ultimoDia);
    }

    // Solo la fecha (sin hora), para las columnas de "fecha de registro" que deben
    // quedar siempre en 00:00:00. Se escribe como literal SQL fijo (no como objeto Date de
    // JS) porque el driver serializa el DateTime usando sus valores UTC: un Date construido
    // en hora LOCAL para "medianoche" equivale a las 05:00 UTC en Lima (UTC-5), y esa es la
    // hora que terminaba guardándose.
    const hoyStr = `${fechaRegistro.getFullYear()}-${String(fechaRegistro.getMonth() + 1).padStart(2, '0')}-${String(fechaRegistro.getDate()).padStart(2, '0')}`;
    const FECHA_HOY_SQL = `CAST('${hoyStr}T00:00:00.000' AS DATETIME)`;

    // Normalizar ComCod = serie-numero, tal como aparece en el documento,
    // sin los ceros de relleno entre el guion y el correlativo (ej. F001-2442).
    const serieRaw  = (comprobante.serie && comprobante.serie !== 'null' ? comprobante.serie : '').trim();
    const numeroRaw = (comprobante.numero || '').replace(/^0+/, '').trim();
    const comCod    = serieRaw ? `${serieRaw}-${numeroRaw}` : numeroRaw;

    const prvCod    = (comprobante.emisor?.ruc || '').trim();
    // Un RUC peruano válido no es solo "11 dígitos" — también debe empezar con uno de
    // los prefijos de tipo de contribuyente que usa SUNAT (10/15/16/17/20/25). Además,
    // se revisa contra la lista de VAT extranjeros conocidos que coinciden con ese
    // formato por pura casualidad (ver RUC_EXTRANJEROS_CONOCIDOS arriba).
    const esExtranjero = RUC_EXTRANJEROS_CONOCIDOS.has(prvCod) || !/^(10|15|16|17|20|25)\d{9}$/.test(prvCod);

    // Alta automática en CPPROVEEDORES si el RUC todavía no existe — solo para
    // proveedores con domicilio fiscal peruano (los extranjeros se gestionan a mano).
    if (!esExtranjero && prvCod) {
      await asegurarProveedorPeru(transaction, prvCod, sunatDatos, comprobante, tablas);
    }

    // Serie que empieza con "S" (ej. S330, S430) = recibo de servicios públicos,
    // sin importar cómo haya clasificado Claude el documento — regla determinística
    // por prefijo, igual que "F" siempre es factura.
    const esServicioPublico = /^S/i.test(serieRaw);
    const tipCod = esExtranjero
      ? '00'
      : esServicioPublico
        ? 'SEP'
        : (tipCodMap[comprobante.tipo_comprobante] || 'FAC');
    const prvDsc    = (comprobante.emisor?.razon_social || '').substring(0, 200);
    const comFec    = comprobante.fecha_emision  ? new Date(comprobante.fecha_emision)  : ahora;
    const comFVcto  = comprobante.fecha_vencimiento ? new Date(comprobante.fecha_vencimiento) : comFec;
    const comMon    = comprobante.moneda === 'USD' ? 2 : 1;
    // Tipo de cambio: siempre 0.00, sin importar la moneda del documento (este campo,
    // ComBanTipC, es para conciliación bancaria, no el TC de la factura — ver
    // asegurarTipoCambioGF más abajo para el TC real, que SIG Advance lee de CTIPOCAMBIO).
    const comBanTipC = 0;

    // Si la factura es en dólares, SIG Advance calcula el TC buscando en CTIPOCAMBIO
    // por fecha — si no encuentra la fecha de emisión, cae a 1.000 por defecto (el bug
    // reportado, causado por que contabilidad no registraba el TC del día a mano).
    // Nos aseguramos de que exista esa fila antes de registrar la factura.
    if (comMon === 2) {
      await asegurarTipoCambioGF(transaction, comFec, tablas.tipocambio);
    }

    const total     = parseFloat(comprobante.importes?.total       || 0);
    const igv       = parseFloat(comprobante.importes?.igv         || 0);
    // Porcentaje de IGV: siempre 18.00, sin importar si el documento tiene IGV o no
    const comPorIva = 18.00;
    const isc       = parseFloat(comprobante.importes?.isc         || 0);
    const dscto     = parseFloat(comprobante.importes?.descuentos  || 0);
    const netoRaw   = parseFloat(comprobante.importes?.op_gravadas || 0);
    const subTotal  = netoRaw > 0 ? netoRaw : (igv === 0 ? total : netoRaw);
    // ComObs = descripción del documento: razón social + número de comprobante
    const serieNumero = serieRaw ? `${serieRaw}-${(comprobante.numero || '')}` : (comprobante.numero || '');
    const glosa       = `${prvDsc} - ${serieNumero}`.substring(0, 500).toUpperCase();
    const obsExtra    = (comprobante.observaciones && comprobante.observaciones !== 'null')
                        ? ` | ${comprobante.observaciones}` : '';
    const obs         = (glosa + obsExtra).substring(0, 500);

    const lineas    = comprobante.lineas || [];
    const comItem   = lineas.length || 1;
    const usuarioCorto = usuario.substring(0, 20);
    const conceptoId    = contab.conceptoId || 0;

    // ── Cabecera COMPRAS_GF ───────────────────────────────────────────────────
    // Fecha "vacía" para las columnas de fecha NOT NULL que no aplican a este registro
    // (mismo valor que usa el sistema contable: el mínimo real de SQL Server, no 1900-01-01).
    // Se escribe como literal SQL fijo (no como objeto Date de JS) porque para años tan
    // antiguos como 1753, Node aplica un desfase histórico de "hora local media" en vez de
    // la zona horaria estándar, dejando la hora en algo como 04:56:16 en vez de 00:00:00.
    const FECHA_NULA_SQL = `CAST('1753-01-01T00:00:00.000' AS DATETIME)`;

    // ComRef = correlativo interno del sistema contable: AAAAMM + 4 dígitos,
    // reiniciado cada mes y compartido por todos los orígenes que insertan en esta tabla.
    // Se calcula bajo lock dentro de la misma transacción para evitar que dos facturas
    // procesadas al mismo tiempo obtengan el mismo correlativo.
    // El período ya se validó en la ruta antes de llegar aquí (resolverPeriodoGF) —
    // si por algún motivo llega sin resolver, cae al mes actual real.
    const yyyymm = periodoYYYYMM || yyyymmDe(ahora);
    const reqRef = new sql.Request(transaction);
    const refResult = await reqRef
      .input('prefix', sql.NVarChar(6), yyyymm)
      .query(`SELECT MAX(CAST(RIGHT(ComRef, 4) AS INT)) AS maxRef
              FROM ${compras} WITH (UPDLOCK, HOLDLOCK)
              WHERE ComRef LIKE @prefix + '%' AND LEN(ComRef) = 10`);
    const maxRef = refResult.recordset[0].maxRef || 0;
    const comRef = yyyymm + String(maxRef + 1).padStart(4, '0');

    const reqCab = new sql.Request(transaction);
    await reqCab
      .input('TipCod',   sql.NVarChar(3),    tipCod)
      .input('ComCod',   sql.NVarChar(15),   comCod)
      .input('PrvCod',   sql.NVarChar(20),   prvCod)
      .input('ComFec',   sql.DateTime,       comFec)
      .input('ComFVcto', sql.DateTime,       comFVcto)
      .input('ComMon',   sql.Int,            comMon)
      .input('ComConpCod', sql.Int,          conceptoId)
      .input('ComRef',   sql.NVarChar(10),   comRef)
      .input('ComOcSt',  sql.SmallInt,       0)
      .input('ComPorIva',sql.SmallMoney,     comPorIva)
      .input('ComFlagRet', sql.SmallInt,     0)
      .input('ComItem',  sql.SmallInt,       comItem)
      .input('ComRedondeo', sql.Money,       0)
      .input('ComValor', sql.Money,          0)
      .input('ComVouAno', sql.SmallInt,      0)
      .input('ComVouMes', sql.SmallInt,      0)
      .input('ComTASICod', sql.Int,          0)
      .input('ComVouNum', sql.NVarChar(10),  '')
      .input('ComSubTotal', sql.Money,       subTotal)
      .input('ComIva',   sql.Money,          igv)
      .input('ComTotal', sql.Money,          total)
      .input('PrvDsc',   sql.NVarChar(100),  prvDsc.substring(0, 100))
      .input('ComUsuC',  sql.NVarChar(10),   usuarioCorto.substring(0, 10))
      .input('ComFecC',  sql.DateTime,       ahora)
      .input('ComUsuM',  sql.NVarChar(10),   usuarioCorto.substring(0, 10))
      .input('ComFecM',  sql.DateTime,       ahora)
      // ComAct = 0 siempre — con 1 el documento queda bloqueado para edición en SIG
      // Advance, y contabilidad reportó documentos quedando marcados así por error.
      .input('ComAct',   sql.SmallInt,       0)
      .input('ComFile',  sql.SmallInt,       0)
      .input('ComTasaDetraccion', sql.NVarChar(20), '')
      .input('ComAut',   sql.SmallInt,       0)
      .input('ComUsuAut', sql.NVarChar(10),  '')
      .input('ComImpAfec', sql.SmallInt,     0)
      .input('ComImpTip', sql.SmallInt,      0)
      .input('ComImpCod', sql.NVarChar(20),  '')
      .input('ComImpTipCos', sql.NVarChar(3), '')
      .input('ComRetAfecto', sql.SmallInt,   0)
      .input('ComRetCod', sql.NVarChar(20),  '')
      .input('ComTipReg', sql.NChar(1),      'A')
      .input('ComIVADUA', sql.Money,         0)
      .input('ComCif',   sql.SmallInt,       0)
      .input('ComRefTDoc', sql.NVarChar(3),  '')
      .input('ComRefDoc', sql.NVarChar(20),  '')
      .input('ComBanCod', sql.Int,           0)
      .input('ComBanCta', sql.NVarChar(20),  '')
      .input('ComBanReg', sql.NVarChar(10),  '')
      .input('ComBanForCod', sql.Int,        0)
      .input('ComBanImp', sql.Money,         0)
      .input('ComBanDoc', sql.NVarChar(20),  '')
      .input('ComBanTipC', sql.Decimal(14, 5), comBanTipC)
      .input('ComBanConc', sql.Int,          0)
      .input('ComRefDom', sql.NVarChar(20),  '')
      .input('ComISC',   sql.Money,          isc)
      .input('ComDscto', sql.Money,          dscto)
      .input('ComRete1', sql.Money,          0)
      .input('ComRete2', sql.Money,          0)
      .input('ComFlete', sql.Money,          0)
      .input('ComObs',   sql.NVarChar(sql.MAX), obs)
      .query(`INSERT INTO ${compras}
        (TipCod,ComCod,PrvCod,ComFec,ComFVcto,ComFReg,ComMon,ComConpCod,ComRef,ComOcSt,ComPorIva,ComFlagRet,
         ComItem,ComRedondeo,ComValor,ComVouAno,ComVouMes,ComTASICod,ComVouNum,
         ComSubTotal,ComIva,ComISC,ComDscto,ComRete1,ComRete2,ComFlete,ComTotal,ComObs,
         PrvDsc,ComUsuC,ComFecC,ComUsuM,ComFecM,ComAct,ComFile,ComTasaDetraccion,ComAut,ComUsuAut,ComFecAut,
         ComImpAfec,ComImpTip,ComImpCod,ComImpTipCos,ComRetAfecto,ComRetCod,ComRetFec,ComFecPago,
         ComTipReg,ComIVADUA,ComCif,ComRefTDoc,ComRefDoc,ComRefFec,
         ComBanCod,ComBanCta,ComBanReg,ComBanForCod,ComBanImp,ComBanDoc,ComBanTipC,ComBanConc,ComRefDom)
        VALUES
        (@TipCod,@ComCod,@PrvCod,@ComFec,@ComFVcto,${FECHA_HOY_SQL},@ComMon,@ComConpCod,@ComRef,@ComOcSt,@ComPorIva,@ComFlagRet,
         @ComItem,@ComRedondeo,@ComValor,@ComVouAno,@ComVouMes,@ComTASICod,@ComVouNum,
         @ComSubTotal,@ComIva,@ComISC,@ComDscto,@ComRete1,@ComRete2,@ComFlete,@ComTotal,@ComObs,
         @PrvDsc,@ComUsuC,@ComFecC,@ComUsuM,@ComFecM,@ComAct,@ComFile,@ComTasaDetraccion,@ComAut,@ComUsuAut,${FECHA_NULA_SQL},
         @ComImpAfec,@ComImpTip,@ComImpCod,@ComImpTipCos,@ComRetAfecto,@ComRetCod,${FECHA_NULA_SQL},${FECHA_NULA_SQL},
         @ComTipReg,@ComIVADUA,@ComCif,@ComRefTDoc,@ComRefDoc,${FECHA_NULA_SQL},
         @ComBanCod,@ComBanCta,@ComBanReg,@ComBanForCod,@ComBanImp,@ComBanDoc,@ComBanTipC,@ComBanConc,@ComRefDom)`);

    // ── Detalle COMPRASDET_GF ─────────────────────────────────────────────────
    const detalles = lineas.length > 0
      ? lineas
      : [{ descripcion: prvDsc || 'SERVICIO', cantidad: 1, precio_unitario: subTotal, subtotal: subTotal }];

    // Cuenta del gasto (del concepto) y centro de costo (del área)
    const cuentaGasto = contab.cuentaGasto || null;
    const centroCosto = contab.centroCosto || null;

    // Comisión bancaria: proveedor es uno de los bancos conocidos Y el concepto de
    // gasto está asociado a la cuenta 946391 — en ese caso ComDTip va en 1 (no 0)
    // en vez del valor normal, según lo indicado por contabilidad. ComDImp siempre
    // va en 0 (coincide con el valor normal, así que no varía por este caso).
    const esBancoComision = RUC_BANCOS_CONOCIDOS.has(prvCod) && cuentaGasto === CUENTA_COMISION_BANCARIA;

    for (let i = 0; i < detalles.length; i++) {
      const d = detalles[i];
      const reqDet = new sql.Request(transaction);
      await reqDet
        .input('TipCod',    sql.NVarChar(3),    tipCod)
        .input('ComCod',    sql.NVarChar(15),   comCod)
        .input('PrvCod',    sql.NVarChar(20),   prvCod)
        .input('ComDItem',  sql.SmallInt,       i + 1)
        .input('ComDOrdCod', sql.NVarChar(10),  '')
        .input('ComDDsc',   sql.NVarChar(100),  (d.descripcion || '').substring(0, 100))
        .input('ComDCant',  sql.Decimal(14, 4), parseFloat(d.cantidad || 1))
        .input('ComDPre',   sql.Decimal(17, 6), parseFloat(d.precio_unitario || d.subtotal || 0))
        .input('ComDTip',   sql.SmallInt,       esBancoComision ? 1 : 0)
        .input('ComDImp',   sql.SmallInt,       0)
        .input('ComDCueCod', sql.NVarChar(15),  cuentaGasto)
        .input('ComCosCod',  sql.NVarChar(10),  centroCosto)
        .input('ComDDct',   sql.Money,          0)
        .input('ComDAuxCue', sql.NVarChar(15),  '')
        .input('ComDAuxCod', sql.NVarChar(20),  '')
        .input('ComDOrdTip', sql.NVarChar(1),   '')
        .query(`INSERT INTO ${comprasdet}
          (TipCod,ComCod,PrvCod,ComDItem,ComDOrdCod,ComDDsc,ComDCant,ComDPre,ComDTip,ComDImp,ComDCueCod,ComCosCod,ComDDct,ComDAuxCue,ComDAuxCod,ComDOrdTip)
          VALUES
          (@TipCod,@ComCod,@PrvCod,@ComDItem,@ComDOrdCod,@ComDDsc,@ComDCant,@ComDPre,@ComDTip,@ComDImp,@ComDCueCod,@ComCosCod,@ComDDct,@ComDAuxCue,@ComDAuxCod,@ComDOrdTip)`);
    }

    // ── Cuenta por pagar CPCUENTAPAGAR ────────────────────────────────────────
    const reqCta = new sql.Request(transaction);
    await reqCta
      .input('CPTipCod',   sql.NVarChar(3),  tipCod)
      .input('CPComCod',   sql.NVarChar(15), comCod)
      .input('CPPrvCod',   sql.NVarChar(20), prvCod)
      .input('CPFech',     sql.DateTime,     comFec)
      .input('CPFVcto',    sql.DateTime,     comFVcto)
      .input('CPMonCod',   sql.Int,          comMon)
      .input('CPImpTotal', sql.Money,        total)
      .input('CPImpPago',  sql.Money,        0)
      .input('CPEstado',   sql.NVarChar(1),  '')
      .query(`INSERT INTO ${cuentapagar}
        (CPTipCod,CPComCod,CPPrvCod,CPFech,CPFVcto,CPFReg,CPMonCod,CPImpTotal,CPImpPago,CPEstado,CPFPago)
        VALUES
        (@CPTipCod,@CPComCod,@CPPrvCod,@CPFech,@CPFVcto,${FECHA_HOY_SQL},@CPMonCod,@CPImpTotal,@CPImpPago,@CPEstado,${FECHA_NULA_SQL})`);

    await transaction.commit();
    logger.info('Compra GF registrada', { tipCod, comCod, prvCod, total, lineas: detalles.length });

    return { tipCod, comCod, prvCod, total, lineas: detalles.length };

  } catch (err) {
    await transaction.rollback();
    logger.error('Error registrando compra GF', { error: err.message });
    throw err;
  }
}

async function checkDuplicateGF(serie, numero, ruc) {
  const db = await getPool();
  const { compras } = tableNames();
  const serieRaw  = (serie || '').trim();
  const numeroRaw = (numero || '').replace(/^0+/, '').trim();
  const comCod    = serieRaw ? `${serieRaw}-${numeroRaw}` : numeroRaw;
  const prvCod    = (ruc || '').trim();
  // El mismo ComCod puede repetirse legítimamente entre proveedores distintos
  // (cada uno numera sus propios documentos desde su propio correlativo),
  // así que el duplicado solo cuenta si coincide también el proveedor.
  const res = await db.request()
    .input('comCod', sql.NVarChar(15), comCod)
    .input('prvCod', sql.NVarChar(20), prvCod)
    .query(`SELECT COUNT(*) AS cnt FROM ${compras} WHERE ComCod = @comCod AND PrvCod = @prvCod`);
  return res.recordset[0].cnt > 0;
}

module.exports = { registrarCompraGF, checkDuplicateGF, resolverPeriodoGF };
