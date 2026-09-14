const axios = require('axios');
const logger = require('../utils/logger');

// ─── Token cache para la API oficial de SUNAT ─────────────────────────────────
let _sunatToken = null;
let _sunatTokenExpira = 0;

const codCompMap = {
  FACTURA:                    '01',
  BOLETA:                     '03',
  NOTA_CREDITO:               '07',
  NOTA_DEBITO:                '08',
  RECIBO_HONORARIOS:          'R1',
  RECIBO_SERVICIOS_PUBLICOS:  '14',
  RECIBO_ARRENDAMIENTO:       '10',
};

async function obtenerTokenSunat() {
  const ahora = Date.now();
  if (_sunatToken && ahora < _sunatTokenExpira - 60000) {
    return _sunatToken;
  }

  const clientId     = process.env.SUNAT_CLIENT_ID;
  const clientSecret = process.env.SUNAT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SUNAT_CLIENT_ID y SUNAT_CLIENT_SECRET no configurados en .env');
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    scope:         'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await axios.post(
    `https://api-seguridad.sunat.gob.pe/v1/clientesextranet/${clientId}/oauth2/token/`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );

  _sunatToken       = res.data.access_token;
  _sunatTokenExpira = ahora + (res.data.expires_in * 1000);
  logger.info('Token SUNAT obtenido', { expira_en_segundos: res.data.expires_in });
  return _sunatToken;
}

/**
 * Valida un comprobante en la API oficial de SUNAT.
 * Retorna: { valido, estado, estadoRuc, condDomi, observaciones } o null si el servicio falla.
 */
async function validarComprobanteOficial(comprobante) {
  const clientId     = process.env.SUNAT_CLIENT_ID;
  const clientSecret = process.env.SUNAT_CLIENT_SECRET;
  const rucConsulta  = process.env.SUNAT_RUC_CONSULTANTE;

  if (!clientId || !clientSecret || !rucConsulta) {
    return { omitido: true, motivo: 'NO_CONFIGURADO' };
  }

  // ── numRuc: exactamente 11 dígitos numéricos ──────────────────────────────
  const ruc = (comprobante.emisor?.ruc || '').trim();
  if (!/^\d{11}$/.test(ruc)) {
    logger.info('SUNAT: omitiendo validación — RUC no peruano', { ruc });
    return { omitido: true, motivo: 'COMPROBANTE_EXTRANJERO' };
  }

  // ── codComp: código de 2 chars según tabla SUNAT ─────────────────────────
  const tipo = codCompMap[comprobante.tipo_comprobante] || '01';

  // ── numeroSerie: debe seguir el formato de factura electrónica peruana
  // (F001, B001, E001, T001...). Documentos como recibos de servicios públicos
  // (ej. "S430" de Entel/Sedapal) no son facturas electrónicas y nunca van a
  // existir en el registro de SUNAT, así que se omiten en vez de bloquear.
  const serie = (comprobante.serie || '').trim().toUpperCase();
  if (!esSeriePeruana(serie)) {
    logger.info('SUNAT: omitiendo validación — serie no es de factura electrónica', { serie });
    return { omitido: true, motivo: 'SERIE_INVALIDA' };
  }

  // ── numero: entero positivo sin ceros a la izquierda ─────────────────────
  const numeroInt = parseInt((comprobante.numero || '0').replace(/^0+/, '') || '0', 10);
  if (!numeroInt || numeroInt <= 0) {
    logger.info('SUNAT: omitiendo validación — número inválido', { numero: comprobante.numero });
    return { omitido: true, motivo: 'NUMERO_INVALIDO' };
  }

  // ── fechaEmision: dd/mm/yyyy obligatorio ──────────────────────────────────
  const fechaRaw = comprobante.fecha_emision;
  if (!fechaRaw) {
    logger.info('SUNAT: omitiendo validación — fecha de emisión ausente');
    return { omitido: true, motivo: 'FECHA_AUSENTE' };
  }
  // Parsear manualmente para evitar desfase de zona horaria con new Date()
  let fechaEmision = '';
  const matchFecha = String(fechaRaw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (matchFecha) {
    fechaEmision = `${matchFecha[3]}/${matchFecha[2]}/${matchFecha[1]}`;
  } else {
    logger.info('SUNAT: omitiendo validación — formato de fecha no reconocido', { fechaRaw });
    return { omitido: true, motivo: 'FECHA_INVALIDA' };
  }

  // ── monto: decimal requerido para comprobantes electrónicos ──────────────
  const monto = parseFloat(comprobante.importes?.total || 0);

  try {
    const token = await obtenerTokenSunat();
    const body  = {
      numRuc:      ruc,
      codComp:     tipo,
      numeroSerie: serie,
      numero:      numeroInt,
      fechaEmision,
      monto,
    };
    logger.info('Consultando comprobante en SUNAT', body);

    const res = await axios.post(
      `https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/${rucConsulta}/validarcomprobante`,
      body,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const data = res.data?.data || res.data;
    const estadoCp   = String(data?.estadoCp ?? '');
    const estadoRuc  = String(data?.estadoRuc ?? '');
    const condDomi   = String(data?.condDomiRuc ?? '');

    const estadoCpTexto = {
      '0': 'NO EXISTE', '1': 'ACEPTADO', '2': 'ANULADO', '3': 'AUTORIZADO', '4': 'NO AUTORIZADO',
    }[estadoCp] || estadoCp;

    logger.info('Resultado SUNAT comprobante', { ruc, serie, numero: numeroInt, estadoCp, estadoCpTexto, estadoRuc, condDomi });

    const estadoRucTexto = {
      '00': 'ACTIVO', '01': 'BAJA PROVISIONAL', '02': 'BAJA PROV. POR OFICIO',
      '03': 'SUSPENSION TEMPORAL', '10': 'BAJA DEFINITIVA', '11': 'BAJA DE OFICIO',
      '22': 'INHABILITADO',
    }[estadoRuc] || estadoRuc;

    const condDomiTexto = {
      '00': 'HABIDO', '09': 'PENDIENTE', '11': 'POR VERIFICAR', '12': 'NO HABIDO', '20': 'NO HALLADO',
    }[condDomi] || condDomi;

    const contribuyenteActivo = estadoRuc === '00';
    const contribuyenteHabido = condDomi === '00';

    return {
      valido:              estadoCp === '1' || estadoCp === '3',
      anulado:             estadoCp === '2',
      estadoCp,
      estadoCpTexto,
      estadoRuc,
      estadoRucTexto,
      condDomi,
      condDomiTexto,
      contribuyenteActivo,
      contribuyenteHabido,
      observaciones:       data?.Observaciones || [],
    };
  } catch (err) {
    if (err.response?.status === 401) {
      _sunatToken = null;
    }
    logger.warn('Error al consultar comprobante en SUNAT oficial', { error: err.message, status: err.response?.status });
    // null = servicio no alcanzable (sin internet, timeout, error de red)
    return null;
  }
}

const apisNetPe = axios.create({
  baseURL: 'https://api.apis.net.pe/v1',
  timeout: 10000,
  headers: { Accept: 'application/json' },
});

/**
 * Determina si un RUC es peruano (exactamente 11 dígitos numéricos).
 */
function esRucPeruano(ruc) {
  return /^\d{11}$/.test((ruc || '').trim());
}

/**
 * Determina si una serie es peruana (F001, B001, E001, T001, etc.)
 */
function esSeriePeruana(serie) {
  return /^[FBET]\d{3}$/i.test((serie || '').trim());
}

/**
 * Consulta el estado de un RUC en SUNAT via apis.net.pe.
 * Retorna: { valido, activo, habido, razon_social, estado, condicion, direccion, ubigeo }
 */
async function validarRuc(ruc) {
  try {
    logger.info('Validando RUC en SUNAT', { ruc });
    const res = await apisNetPe.get(`/ruc?numero=${ruc}`);
    const d = res.data;

    const activo = (d.estado || '').toUpperCase() === 'ACTIVO';
    const habido = (d.condicion || '').toUpperCase() === 'HABIDO';

    logger.info('RUC validado', { ruc, estado: d.estado, condicion: d.condicion });

    return {
      valido: true,
      activo,
      habido,
      razon_social: d.nombre || null,
      estado: d.estado || null,
      condicion: d.condicion || null,
      direccion: d.direccion || null,
      ubigeo: d.ubigeo || null,
    };
  } catch (err) {
    // 404 o 422 = RUC no encontrado en SUNAT
    if (err.response?.status === 404 || err.response?.status === 422) {
      logger.warn('RUC no encontrado en SUNAT', { ruc });
      return { valido: false, activo: false, habido: false, error: 'RUC no registrado en SUNAT' };
    }
    // Cualquier otro error (timeout, red, etc.) → no bloqueamos el registro
    logger.warn('Error al consultar SUNAT, se omite validación', { ruc, error: err.message });
    return { valido: null, error: 'Servicio SUNAT no disponible' };
  }
}

/**
 * Consulta el tipo de cambio SUNAT (vía apis.net.pe) para una fecha específica.
 * Ya devuelve el valor correcto para fines de semana/feriados (usa el cierre del
 * día hábil anterior, como corresponde), así que no hace falta ajustar la fecha acá.
 * Reintenta una vez ante error/429 (el servicio comparte límite de peticiones entre
 * todos sus usuarios sin token) antes de rendirse.
 * Retorna { compra, venta, fecha } o null si no se pudo obtener tras el reintento.
 */
async function obtenerTipoCambioSunat(fechaISO, _esReintento = false) {
  try {
    const res = await apisNetPe.get(`/tipo-cambio-sunat?fecha=${fechaISO}`);
    const d = res.data;
    logger.info('Tipo de cambio SUNAT obtenido', { fecha: fechaISO, compra: d.compra, venta: d.venta });
    return { compra: d.compra, venta: d.venta, fecha: d.fecha };
  } catch (err) {
    if (!_esReintento) {
      logger.warn('Tipo de cambio SUNAT falló, reintentando', { fecha: fechaISO, error: err.message });
      return obtenerTipoCambioSunat(fechaISO, true);
    }
    logger.warn('Tipo de cambio SUNAT no disponible tras reintento', { fecha: fechaISO, error: err.message });
    return null;
  }
}

/**
 * Valida el RUC del emisor antes de registrar en SISCON.
 * Solo aplica a facturas peruanas (RUC 11 dígitos + serie peruana).
 *
 * Retorna:
 *   { proceder: true }                          → todo OK, continuar
 *   { proceder: false, motivo, mensajeUsuario } → bloquear registro
 *   { proceder: true, advertencia }             → registrar con advertencia
 */
/**
 * Valida el dígito verificador del RUC (algoritmo módulo 11 de SUNAT), sin red.
 * Sirve para descartar de inmediato un RUC mal leído (ej. confusión visual 6/8)
 * antes incluso de consultar a SUNAT.
 */
function checksumRucValido(ruc) {
  if (!/^\d{11}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const digitos = ruc.split('').map(Number);
  const suma = digitos.slice(0, 10).reduce((acc, d, i) => acc + d * pesos[i], 0);
  let verificador = 11 - (suma % 11);
  if (verificador === 10) verificador = 0;
  if (verificador === 11) verificador = 1;
  return verificador === digitos[10];
}

async function validarEmisorNacional(comprobante) {
  const ruc = comprobante.emisor?.ruc;
  const serie = comprobante.serie;

  // Solo validar facturas nacionales
  if (!esRucPeruano(ruc) || !esSeriePeruana(serie)) {
    logger.info('Comprobante extranjero, omitiendo validación SUNAT', { ruc, serie });
    return { proceder: true };
  }

  // Dígito verificador inválido → RUC estructuralmente imposible, ni vale la pena
  // consultar a SUNAT (evita además que un error de red disfrace un RUC mal leído).
  if (!checksumRucValido(ruc)) {
    logger.warn('RUC con dígito verificador inválido', { ruc });
    return {
      proceder: false,
      motivo: 'RUC_CHECKSUM_INVALIDO',
      mensajeUsuario:
        `❌ *Comprobante NO registrado*\n\n` +
        `El RUC *${ruc}* no es válido (dígito verificador incorrecto).\n` +
        `Verifica que el número esté bien escrito o vuelve a enviar una foto más clara.`,
    };
  }

  let resultado = await validarRuc(ruc);

  // Servicio caído → reintentar una vez antes de decidir
  if (resultado.valido === null) {
    logger.warn('SUNAT no respondió, reintentando validación de RUC', { ruc });
    resultado = await validarRuc(ruc);
  }

  // Sigue sin responder → bloquear. El registro siempre debe confirmarse contra
  // los datos reales de SUNAT (activo y habido), nunca pasar "a ciegas".
  if (resultado.valido === null) {
    return {
      proceder: false,
      motivo: 'SUNAT_NO_DISPONIBLE',
      mensajeUsuario:
        `❌ *Comprobante NO registrado*\n\n` +
        `No se pudo confirmar el RUC *${ruc}* en SUNAT (servicio no disponible en este momento).\n` +
        `Vuelve a intentarlo en unos minutos.`,
    };
  }

  // RUC no existe en SUNAT
  if (!resultado.valido) {
    return {
      proceder: false,
      motivo: 'RUC_INVALIDO',
      mensajeUsuario:
        `❌ *Comprobante NO registrado*\n\n` +
        `El RUC del emisor *${ruc}* no existe en SUNAT.\n` +
        `Verifica que el documento sea auténtico.`,
    };
  }

  // RUC existe pero está de BAJA
  if (!resultado.activo) {
    return {
      proceder: false,
      motivo: 'EMISOR_BAJA',
      mensajeUsuario:
        `❌ *Comprobante NO registrado*\n\n` +
        `El emisor *${resultado.razon_social || ruc}* figura con estado *${resultado.estado}* en SUNAT.\n` +
        `Un proveedor dado de baja no puede emitir comprobantes válidos.`,
    };
  }

  // RUC activo pero NO HABIDO
  if (!resultado.habido) {
    return {
      proceder: false,
      motivo: 'EMISOR_NO_HABIDO',
      mensajeUsuario:
        `❌ *Comprobante NO registrado*\n\n` +
        `El emisor *${resultado.razon_social || ruc}* figura como *${resultado.condicion}* en SUNAT.\n` +
        `SUNAT no puede ubicar al proveedor en su domicilio fiscal.`,
    };
  }

  // Todo OK
  logger.info('Emisor validado correctamente', { ruc, razon_social: resultado.razon_social });
  return {
    proceder: true,
    datos: {
      razon_social: resultado.razon_social,
      direccion: resultado.direccion,
      ubigeo: resultado.ubigeo,
      estado: resultado.estado,
      condicion: resultado.condicion,
    },
  };
}

module.exports = { validarEmisorNacional, validarComprobanteOficial, validarRuc, esRucPeruano, esSeriePeruana, obtenerTipoCambioSunat };
