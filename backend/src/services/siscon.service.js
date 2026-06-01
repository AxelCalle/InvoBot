const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

// Cliente HTTP pre-configurado para SISCON
const sisconClient = axios.create({
  baseURL: config.siscon.baseUrl,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${config.siscon.apiKey}`,
    'Content-Type': 'application/json',
    'X-Empresa-Id': config.siscon.empresaId,
  },
});

/**
 * Verifica si un comprobante ya existe en SISCON para evitar duplicados.
 * Busca por serie + número + RUC del emisor.
 */
async function checkDuplicate(comprobante) {
  try {
    const res = await sisconClient.get('/comprobantes/verificar', {
      params: {
        serie: comprobante.serie,
        numero: comprobante.numero,
        ruc_emisor: comprobante.emisor?.ruc,
      },
    });
    return res.data?.existe === true;
  } catch (err) {
    // Si el endpoint no existe o falla, asumimos que no hay duplicado
    // pero lo logueamos para que el equipo lo revise
    logger.warn('No se pudo verificar duplicado en SISCON', { error: err.message });
    return false;
  }
}

/**
 * Transforma el JSON de Claude al formato específico que espera la API de SISCON.
 * IMPORTANTE: Ajusta este mapeo según la documentación real de tu SISCON.
 */
function transformToSisconFormat(comprobante) {
  return {
    empresa_id: config.siscon.empresaId,
    tipo_documento: mapTipoComprobante(comprobante.tipo_comprobante),
    serie: comprobante.serie,
    numero: comprobante.numero,
    fecha_emision: comprobante.fecha_emision,
    fecha_vencimiento: comprobante.fecha_vencimiento,
    moneda: comprobante.moneda,

    proveedor: {
      ruc: comprobante.emisor?.ruc,
      razon_social: comprobante.emisor?.razon_social,
      direccion: comprobante.emisor?.direccion,
      ubigeo: comprobante.emisor?.ubigeo,
    },

    cliente: {
      tipo_documento: comprobante.receptor?.tipo_doc,
      numero_documento: comprobante.receptor?.numero_doc,
      nombre: comprobante.receptor?.nombre,
      direccion: comprobante.receptor?.direccion,
    },

    totales: {
      base_imponible: comprobante.importes?.op_gravadas || 0,
      exonerado: comprobante.importes?.op_exoneradas || 0,
      inafecto: comprobante.importes?.op_inafectas || 0,
      igv: comprobante.importes?.igv || 0,
      isc: comprobante.importes?.isc || 0,
      descuentos: comprobante.importes?.descuentos || 0,
      otros_cargos: comprobante.importes?.otros_cargos || 0,
      importe_total: comprobante.importes?.total || 0,
    },

    detalle: (comprobante.lineas || []).map((linea, idx) => ({
      numero_item: idx + 1,
      descripcion: linea.descripcion,
      cantidad: linea.cantidad,
      unidad_medida: linea.unidad_medida,
      precio_unitario: linea.precio_unitario,
      valor_venta: linea.subtotal,
      tipo_afectacion_igv: linea.tipo_afectacion_igv,
    })),

    observaciones: comprobante.observaciones,
    origen: 'WHATSAPP_BOT',
    confianza_extraccion: comprobante.confianza,
  };
}

/**
 * Mapea el tipo de comprobante de SUNAT al código interno de SISCON.
 * Ajusta según los códigos que use tu sistema.
 */
function mapTipoComprobante(tipo) {
  const mapa = {
    BOLETA: '03',
    FACTURA: '01',
    NOTA_CREDITO: '07',
    NOTA_DEBITO: '08',
  };
  return mapa[tipo] || '01';
}

/**
 * Registra el comprobante en SISCON.
 * Devuelve el número de registro asignado por el sistema.
 */
async function registrarComprobante(comprobante) {
  const isDuplicate = await checkDuplicate(comprobante);
  if (isDuplicate) {
    throw new Error(`Duplicado: el comprobante ${comprobante.serie}-${comprobante.numero} ya existe en SISCON`);
  }

  const payload = transformToSisconFormat(comprobante);
  logger.info('Registrando en SISCON', {
    tipo: comprobante.tipo_comprobante,
    serie: comprobante.serie,
    numero: comprobante.numero,
    total: comprobante.importes?.total,
  });

  const res = await sisconClient.post('/comprobantes', payload);

  logger.info('Comprobante registrado en SISCON', { registroId: res.data?.id });
  return {
    id: res.data?.id,
    numero_registro: res.data?.numero_registro,
    estado: res.data?.estado || 'REGISTRADO',
  };
}

module.exports = { registrarComprobante, checkDuplicate };
