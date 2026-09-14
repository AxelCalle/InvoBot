const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `Eres un extractor de datos de comprobantes de pago, tanto peruanos como extranjeros.
Analiza el documento y devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin backticks.

Estructura exacta requerida:
{
  "tipo_comprobante": "BOLETA" | "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO" | "RECIBO_HONORARIOS" | "RECIBO_SERVICIOS_PUBLICOS" | "RECIBO_ARRENDAMIENTO",
  "serie": "F001 o null si no existe",
  "numero": "número del comprobante sin serie",
  "fecha_emision": "YYYY-MM-DD",
  "fecha_vencimiento": "YYYY-MM-DD o null",
  "moneda": "PEN" | "USD",
  "emisor": {
    "ruc": "RUC o número de identificación fiscal del emisor",
    "razon_social": "nombre o razón social del emisor",
    "direccion": "dirección o null",
    "ubigeo": "null"
  },
  "receptor": {
    "tipo_doc": "RUC" | "DNI" | "CE" | "SIN_DOCUMENTO",
    "numero_doc": "número de documento del receptor",
    "nombre": "nombre del receptor",
    "direccion": "dirección o null"
  },
  "importes": {
    "op_gravadas": 0.00,
    "op_exoneradas": 0.00,
    "op_inafectas": 0.00,
    "igv": 0.00,
    "isc": 0.00,
    "otros_cargos": 0.00,
    "descuentos": 0.00,
    "total": 0.00
  },
  "lineas": [
    {
      "descripcion": "descripción del producto o servicio",
      "cantidad": 1,
      "unidad_medida": "NIU",
      "precio_unitario": 0.00,
      "subtotal": 0.00,
      "tipo_afectacion_igv": "10"
    }
  ],
  "observaciones": "null",
  "confianza": "ALTA" | "MEDIA" | "BAJA"
}

Reglas importantes:
- Para facturas SIN serie (extranjeras o sin formato peruano): serie = null, numero = número completo del documento.
- Para facturas peruanas con serie: serie = "F001", numero = "00001234".
- El RUC del emisor puede ser un número de registro de IVA extranjero — úsalo igual.
- Al leer el RUC del documento (imagen/foto), presta especial atención a distinguir dígitos
  que se confunden fácilmente en fotos de baja calidad o mala impresión: 6 vs 8, 8 vs 0,
  5 vs 6, 3 vs 8. Verifica cada dígito contra la forma exacta que aparece en la imagen,
  no asumas por contexto. Si hay datos pre-extraídos del QR con un RUC, ese RUC es exacto
  y debe prevalecer sobre lo que leas visualmente si hay diferencia.
- Si un campo no está visible usa null, nunca inventes datos.
- moneda: usa "PEN" si dice soles o PEN, "USD" si dice dólares o USD.
- igv e impuestos: extrae el valor numérico aunque se llame IVA, TAX o impuesto.
- total: es el monto NETO realmente a pagar/recibido. Si el documento muestra una retención,
  descuento u otro concepto que se resta del monto bruto (ej. "Retención IR", "Total Neto Recibido",
  "Neto a Pagar"), usa ese monto NETO como total, no el bruto antes de la retención/descuento.
- tipo_comprobante RECIBO_HONORARIOS si el documento dice "Recibo por Honorarios" o "RxH".
  La serie de un RxH normalmente empieza con "E" (ej. "E001"), a diferencia de facturas/boletas
  que usan "F"/"B" — no lo confundas con una factura solo porque tiene formato serie-número.
  Algunos RxH vienen en el mismo PDF junto con la constancia de "Suspensión de 4ta Categoría -
  Formulario 1609" de SUNAT (un bloque distinto, con su propio encabezado y número de operación,
  normalmente en la parte superior de la página). Ese bloque es solo informativo — IGNÓRALO por
  completo para la clasificación y extracción de datos; usa únicamente el bloque que dice
  "Recibo por Honorarios Electrónico".
- tipo_comprobante RECIBO_SERVICIOS_PUBLICOS si es un recibo de luz, agua, teléfono/telefonía, internet u otro servicio
  público (ej. Entel, Sedapal, Luz del Sur, Enel, Movistar, Claro) — normalmente dice "RECIBO N°" en vez de "FACTURA",
  y su serie no sigue el formato de factura electrónica peruana (F001/B001/etc.).
- tipo_comprobante RECIBO_ARRENDAMIENTO si es un recibo por arrendamiento/alquiler (ej. de oficina, local o terreno)
  emitido por una persona natural sin RUC de negocio — normalmente dice "RECIBO POR ARRENDAMIENTO" y no sigue el
  formato de factura electrónica peruana.
- fecha_emision/fecha_vencimiento: los documentos peruanos y latinoamericanos escriben la fecha
  como DÍA/MES/AÑO (dd/mm/aaaa o dd/mm/aa), NUNCA mes/día. No confundas ni invirtas el orden de
  los números. Si el año viene en 2 dígitos, antepone "20" manteniendo el día y el mes en su
  posición original — ej. "21/08/26" en el documento es 21 de agosto de 2026, se extrae como
  "2026-08-21" (NO "2021-08-26": el "26" es el año corto, no el día).
- confianza BAJA si el documento está borroso, incompleto o es ilegible.
- Devuelve SOLO el JSON, sin ningún texto antes ni después.`;

/**
 * Extrae datos de un comprobante a partir de un Buffer.
 * Soporta imágenes (JPEG/PNG), PDF y XML.
 * datosQR (opcional): objeto parseado del QR para enriquecer la extracción.
 */
async function extractFromDocument(buffer, mimeType, datosQR = null) {
  const isXML = mimeType === 'text/xml' || mimeType === 'application/xml';
  const isPDF = mimeType === 'application/pdf';
  const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';

  let userContent;

  // Contexto adicional del QR si está disponible
  const contextoQR = datosQR
    ? `\n\nDatos pre-extraídos del código QR del documento (el RUC del QR es exacto y prevalece sobre tu lectura visual si hay diferencia; para el resto de campos úsalos como referencia):\n${JSON.stringify(datosQR, null, 2)}`
    : '';

  if (isXML) {
    const xmlText = buffer.toString('utf-8');
    userContent = [
      { type: 'text', text: `Extrae los datos de este comprobante electrónico XML:${contextoQR}\n\n${xmlText}` },
    ];
  } else if (isImage || isPDF) {
    const base64 = buffer.toString('base64');
    const textoInstruccion = datosQR
      ? `Extrae todos los datos de este comprobante. El QR ya fue decodificado y los datos están arriba como referencia.${contextoQR}`
      : 'Extrae todos los datos de este comprobante.';
    userContent = [
      {
        type: isPDF ? 'document' : 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      },
      { type: 'text', text: textoInstruccion },
    ];
  } else if (datosQR && datosQR.qr_raw) {
    // Solo QR, sin imagen adjunta (caso poco común pero posible)
    userContent = [
      { type: 'text', text: `Extrae los datos de este comprobante a partir del código QR decodificado:${contextoQR}\n\nTexto QR: ${datosQR.qr_raw}` },
    ];
  } else {
    throw new Error(`Tipo de archivo no soportado: ${mimeType}`);
  }

  logger.info('Llamando a Claude API', { mimeType, bufferKB: Math.round(buffer.length / 1024) });

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    },
    {
      headers: {
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const rawText = response.data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim()
    .replace(/```json|```/g, '')
    .trim();

  logger.info('Respuesta Claude recibida', { chars: rawText.length, preview: rawText.substring(0, 100) });

  // Extraer el bloque JSON aunque Claude incluya texto antes o después
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Diagnóstico: si vino vacío, es clave saber el motivo del corte (stop_reason,
    // ej. "max_tokens") y qué tipos de bloque devolvió realmente (ej. "thinking"
    // en vez de "text"), para no adivinar la causa la próxima vez.
    logger.warn('Claude no devolvió JSON válido', {
      rawText: rawText.substring(0, 300),
      stopReason: response.data?.stop_reason,
      contentTypes: (response.data?.content || []).map((c) => c.type),
      usage: response.data?.usage,
    });
    throw new Error('No se pudieron extraer datos del documento. Intenta con una imagen más clara o en formato PDF.');
  }

  const data = JSON.parse(jsonMatch[0]);

  // El RUC del QR es decodificado bit a bit (sin ambigüedad visual), a diferencia de
  // la lectura del documento por imagen, donde Claude puede confundir dígitos de forma
  // parecida en fotos de baja calidad (ej. 6 ↔ 8). Cuando el QR trae un RUC válido de
  // 11 dígitos, prevalece sobre lo que Claude leyó visualmente.
  if (datosQR?.ruc_emisor && /^\d{11}$/.test(datosQR.ruc_emisor) && data.emisor) {
    if (data.emisor.ruc !== datosQR.ruc_emisor) {
      logger.warn('RUC corregido con el dato del QR (posible confusión visual de dígitos)', {
        rucClaude: data.emisor.ruc,
        rucQR: datosQR.ruc_emisor,
      });
      data.emisor.ruc = datosQR.ruc_emisor;
    }
  }

  return data;
}

module.exports = { extractFromDocument };