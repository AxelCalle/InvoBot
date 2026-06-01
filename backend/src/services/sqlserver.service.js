const sql = require('mssql');
const logger = require('../utils/logger');

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

let pool;
async function getPool() {
  if (!pool) {
    pool = await sql.connect(sqlConfig);
    logger.info('Conexión SQL Server OK', { db: process.env.SQL_DATABASE });
  }
  return pool;
}

function mapTipoDoc(tipo) {
  return { FACTURA:'01', BOLETA:'03', NOTA_CREDITO:'07', NOTA_DEBITO:'08' }[tipo] || '01';
}

function mapMoneda(moneda) {
  return moneda === 'USD' ? 'D' : 'S';
}

async function registrarFactura(comprobante, usuario = 'BOT') {
  const db = await getPool();
  const transaction = new sql.Transaction(db);
  await transaction.begin();

  try {
    const fecha = new Date();
    const mesv = String(fecha.getMonth() + 1).padStart(2, '0');
    const ahora = fecha.toTimeString().substring(0, 8);
    const fechaEmision = comprobante.fecha_emision ? new Date(comprobante.fecha_emision) : fecha;
    const fechaVencimiento = comprobante.fecha_vencimiento ? new Date(comprobante.fecha_vencimiento) : fechaEmision;
    const moneda = mapMoneda(comprobante.moneda);
    const tipoDoc = mapTipoDoc(comprobante.tipo_comprobante);
    const neto = comprobante.importes?.op_gravadas || 0;
    const igv = comprobante.importes?.igv || 0;
    const total = comprobante.importes?.total || 0;
    const glosa = `${comprobante.emisor?.razon_social || ''} - ${comprobante.serie || ''}-${comprobante.numero || ''}`.substring(0, 60).toUpperCase();
    // Normalizar número: quitar guiones y ceros extra del correlativo
    const serieRaw = (comprobante.serie || '').trim();
    const numeroRaw = (comprobante.numero || '').replace(/^0+/, '').trim();
    const numeroNormalizado = numeroRaw.padStart(8, '0'); // siempre 8 dígitos
    const numero = serieRaw + numeroNormalizado;
    const rut = comprobante.emisor?.ruc || '';
    const tc = comprobante.moneda === 'USD' ? 3.70 : 1.00;

const anio = String(fecha.getFullYear());
const prefix = `${anio}${mesv}`;

const voucherRes = await new sql.Request(db).query(
  `SELECT ISNULL(MAX(CAST(SUBSTRING(VOU, 7, 4) AS INT)), 0) + 1 AS NEXT_VOU 
   FROM asientos_contables 
   WHERE VOU LIKE '${prefix}%'`
);
const correlativo = String(voucherRes.recordset[0].NEXT_VOU).padStart(4, '0');
const vouBase = `${prefix}${correlativo}`;

    const asientos = [
      { cuenta: '635601', debe: neto,  haber: 0,     tl: ' ' },
      { cuenta: '401111', debe: igv,   haber: 0,     tl: 'C' },
      { cuenta: '421210', debe: 0,     haber: total, tl: ' ' },
    ];

    for (let i = 0; i < asientos.length; i++) {
      const a = asientos[i];
      const voucher = String(parseInt(vouBase) + i).padStart(6, '0');
      const mtv = `${usuario.substring(0, 3).toUpperCase().padEnd(3)} ${voucher}`;
      const req = new sql.Request(transaction);
      await req
        .input('mtv',    sql.VarChar,       mtv)
        .input('mesv',   sql.VarChar,       mesv)
        .input('vou',    sql.VarChar,       voucher)
        .input('cuenta', sql.VarChar,       a.cuenta)
        .input('debe',   sql.Decimal(18,2), a.debe)
        .input('haber',  sql.Decimal(18,2), a.haber)
        .input('glosa',  sql.VarChar,       glosa)
        .input('tl',     sql.VarChar,       a.tl)
        .input('numero', sql.VarChar,       numero)
        .input('fecha',  sql.DateTime,      fecha)
        .input('doc',    sql.VarChar,       tipoDoc)
        .input('fechad', sql.DateTime,      fechaEmision)
        .input('rut',    sql.VarChar,       rut)
        .input('fechav', sql.DateTime,      fechaVencimiento)
        .input('tc',     sql.Decimal(10,4), tc)
        .input('moneda', sql.VarChar,       moneda)
        .input('neto',   sql.Decimal(18,2), neto)
        .input('igv',    sql.Decimal(18,2), igv)
        .input('auser',  sql.VarChar,       usuario.substring(0, 10))
        .input('afecha', sql.DateTime,      fecha)
        .input('ahora',  sql.VarChar,       ahora)
        .input('serie',  sql.VarChar,       comprobante.serie || '')
        .query(`INSERT INTO asientos_contables
          (MTV,MESV,T,VOU,CUENTA,DEBE,HABER,GLOSA,TL,NUMERO,FECHA,SALDO,DOC,FECHAD,RUT,FECHAV,TC,MONEDA,NETO,IGV,AUSER,AFECHA,AHORA,SERIE)
          VALUES(@mtv,'${mesv}','1',@vou,@cuenta,@debe,@haber,@glosa,@tl,@numero,@fecha,0,@doc,@fechad,@rut,@fechav,@tc,@moneda,@neto,@igv,@auser,@afecha,@ahora,@serie)`);
    }

    await transaction.commit();
    logger.info('Factura registrada en SQL Server', { numero, total, asientos: asientos.length });
    return { voucher: vouBase, numero, asientos: asientos.length, total };

  } catch (err) {
    await transaction.rollback();
    logger.error('Error en SQL Server', { error: err.message });
    throw err;
  }
}

async function checkDuplicate(serie, numero, ruc) {
  const db = await getPool();
  const numeroCompleto = (serie || '') + (numero || '');
  const res = await db.request()
    .input('numero', sql.VarChar, numeroCompleto)
    .input('rut', sql.VarChar, ruc)
    .query('SELECT COUNT(*) AS cnt FROM asientos_contables WHERE NUMERO = @numero AND RUT = @rut');
  return res.recordset[0].cnt > 0;
}

module.exports = { registrarFactura, checkDuplicate };