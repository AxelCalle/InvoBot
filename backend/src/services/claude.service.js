const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `Eres un extractor de datos de comprobantes electrónicos peruanos (boletas y facturas).
Analiza el documento y devuelve ÚNICAMENTE un objeto JSON válido, sin texto adicional, sin markdown, sin backticks.

Estructura exacta requerida:
{
  "tipo_comprobante": "BOLETA" | "FACTURA" | "NOTA_CREDITO" | "NOTA_DEBITO",
  "serie": "B001",
  "numero": "00001234",
  "fecha_emision": "YYYY-MM-DD",
  "fecha_vencimiento": "YYYY-MM-DD o null",
  "moneda": "PEN" | "USD",
  "emisor": {
    "ruc": "20xxxxxxxxx",
    "razon_social": "...",
    "direccion": "...",
    "ubigeo": "... o null"
  },
  "receptor": {
    "tipo_doc": "RUC" | "DNI" | "CE" | "SIN_DOCUMENTO",
    "numero_doc": "...",
    "nombre": "...",
    "direccion": "... o null"
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
      "descripcion": "...",
      "cantidad": 1,
      "unidad_medida": "NIU",
      "precio_unitario": 0.00,
      "subtotal": 0.00,
      "tipo_afectacion_igv": "10"
    }
  ],
  "observaciones": "... o null",
  "confianza": "ALTA" | "MEDIA" | "BAJA"
}

Reglas:
- Si un campo no está visible usa null, nunca inventes datos.
- tipo_afectacion_igv: "10" gravado, "20" exonerado, "30" inafecto.
- confianza BAJA si el documento está borroso, incompleto o es ilegible.
- Devuelve SOLO el JSON, sin ningún texto antes ni después.`;

/**
 * Extrae datos de un comprobante a partir de un Buffer.
 * Soporta imágenes (JPEG/PNG), PDF y XML.
 */
async function extractFromDocument(buffer, mimeType) {
  const isXML = mimeType === 'text/xml' || mimeType === 'application/xml';
  const isPDF = mimeType === 'application/pdf';
  const isImage = mimeType === 'image/jpeg' || mimeType === 'image/png';

  let userContent;

  if (isXML) {
    // Para XML mandamos el texto directamente
    const xmlText = buffer.toString('utf-8');
    userContent = [
      { type: 'text', text: `Extrae los datos de este comprobante electrónico XML:\n\n${xmlText}` },
    ];
  } else if (isImage || isPDF) {
    // Para imágenes y PDF enviamos en base64
    const base64 = buffer.toString('base64');
    userContent = [
      {
        type: isPDF ? 'document' : 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      },
      { type: 'text', text: 'Extrae todos los datos de este comprobante.' },
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

  logger.info('Respuesta Claude recibida', { chars: rawText.length });

  const data = JSON.parse(rawText);
  return data;
}

module.exports = { extractFromDocument };
