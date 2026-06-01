/**
 * Script de prueba local — simula el flujo completo sin WhatsApp.
 * Uso: node src/test-demo.js [ruta-del-archivo]
 *
 * Ejemplos:
 *   node src/test-demo.js ./boleta.pdf
 *   node src/test-demo.js ./factura.xml
 *   node src/test-demo.js ./foto-boleta.jpg
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const claude = require('./services/claude.service');

async function testExtraccion(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.log('\n📋 USO: node src/test-demo.js <ruta-del-archivo>\n');
    console.log('Archivos soportados: .pdf .jpg .jpeg .png .xml\n');

    // Demo con datos ficticios si no se pasa archivo
    console.log('── Demo con comprobante ficticio ──────────────────────────');
    const demoResult = {
      tipo_comprobante: 'BOLETA',
      serie: 'B001',
      numero: '00003847',
      fecha_emision: '2025-05-20',
      fecha_vencimiento: null,
      moneda: 'PEN',
      emisor: {
        ruc: '20601598811',
        razon_social: 'COMERCIAL LOS ANDES S.A.C.',
        direccion: 'AV. ABANCAY 456, LIMA',
        ubigeo: '150101',
      },
      receptor: {
        tipo_doc: 'DNI',
        numero_doc: '47823651',
        nombre: 'CARLOS MENDOZA QUISPE',
        direccion: null,
      },
      importes: {
        op_gravadas: 84.75,
        op_exoneradas: 0,
        op_inafectas: 0,
        igv: 15.25,
        isc: 0,
        otros_cargos: 0,
        descuentos: 0,
        total: 100.0,
      },
      lineas: [
        {
          descripcion: 'PAPEL BOND A4 X 500 HOJAS',
          cantidad: 2,
          unidad_medida: 'CAJ',
          precio_unitario: 28.5,
          subtotal: 57.0,
          tipo_afectacion_igv: '10',
        },
        {
          descripcion: 'LAPICERO AZUL X 50 UNID.',
          cantidad: 1,
          unidad_medida: 'CAJ',
          precio_unitario: 27.75,
          subtotal: 27.75,
          tipo_afectacion_igv: '10',
        },
      ],
      observaciones: null,
      confianza: 'ALTA',
    };
    printResult(demoResult);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.xml': 'text/xml',
  };

  const mimeType = mimeMap[ext];
  if (!mimeType) {
    console.error(`❌ Extensión no soportada: ${ext}`);
    process.exit(1);
  }

  console.log(`\n🔍 Procesando: ${filePath} (${mimeType})`);
  console.log('⏳ Llamando a Claude API...\n');

  const buffer = fs.readFileSync(filePath);

  try {
    const resultado = await claude.extractFromDocument(buffer, mimeType);
    printResult(resultado);
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.response?.data) console.error('Detalle API:', JSON.stringify(err.response.data, null, 2));
  }
}

function printResult(data) {
  const cur = data.moneda === 'USD' ? 'USD' : 'S/';
  const fmt = (n) => `${cur} ${parseFloat(n || 0).toFixed(2)}`;

  console.log('═══════════════════════════════════════════════════════');
  console.log('  CAMPOS QUE SE INGRESARÍAN EN SISCON');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('── CABECERA ──────────────────────────────────────────');
  console.log(`  Tipo comprobante : ${data.tipo_comprobante}`);
  console.log(`  Serie            : ${data.serie}`);
  console.log(`  Número           : ${data.numero}`);
  console.log(`  Serie-Número     : ${data.serie}-${data.numero}`);
  console.log(`  Fecha emisión    : ${data.fecha_emision}`);
  console.log(`  Fecha vencimiento: ${data.fecha_vencimiento || '(no aplica)'}`);
  console.log(`  Moneda           : ${data.moneda}`);
  console.log(`  Confianza IA     : ${data.confianza}`);

  console.log('\n── EMISOR ────────────────────────────────────────────');
  console.log(`  RUC              : ${data.emisor?.ruc}`);
  console.log(`  Razón social     : ${data.emisor?.razon_social}`);
  console.log(`  Dirección        : ${data.emisor?.direccion}`);
  console.log(`  Ubigeo           : ${data.emisor?.ubigeo || '(no disponible)'}`);

  console.log('\n── RECEPTOR ──────────────────────────────────────────');
  console.log(`  Tipo doc.        : ${data.receptor?.tipo_doc}`);
  console.log(`  Nº doc.          : ${data.receptor?.numero_doc}`);
  console.log(`  Nombre           : ${data.receptor?.nombre}`);
  console.log(`  Dirección        : ${data.receptor?.direccion || '(no disponible)'}`);

  console.log('\n── IMPORTES ──────────────────────────────────────────');
  console.log(`  Op. gravadas     : ${fmt(data.importes?.op_gravadas)}`);
  console.log(`  Op. exoneradas   : ${fmt(data.importes?.op_exoneradas)}`);
  console.log(`  Op. inafectas    : ${fmt(data.importes?.op_inafectas)}`);
  console.log(`  IGV (18%)        : ${fmt(data.importes?.igv)}`);
  console.log(`  ISC              : ${fmt(data.importes?.isc)}`);
  console.log(`  Descuentos       : ${fmt(data.importes?.descuentos)}`);
  console.log(`  Otros cargos     : ${fmt(data.importes?.otros_cargos)}`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  TOTAL            : ${fmt(data.importes?.total)}`);

  console.log('\n── LÍNEAS DE DETALLE ─────────────────────────────────');
  (data.lineas || []).forEach((l, i) => {
    console.log(`  [${i + 1}] ${l.descripcion}`);
    console.log(`      Cantidad: ${l.cantidad} ${l.unidad_medida}  |  P.Unit: ${fmt(l.precio_unitario)}  |  Subtotal: ${fmt(l.subtotal)}  |  Afect. IGV: ${l.tipo_afectacion_igv}`);
  });

  if (data.observaciones) {
    console.log(`\n── OBSERVACIONES ─────────────────────────────────────`);
    console.log(`  ${data.observaciones}`);
  }

  console.log('\n── JSON PARA API SISCON ──────────────────────────────');
  console.log(JSON.stringify(data, null, 2));
  console.log('\n═══════════════════════════════════════════════════════\n');
}

// Ejecutar
const file = process.argv[2];
testExtraccion(file);
