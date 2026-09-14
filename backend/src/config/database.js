const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const logger = require('../utils/logger');

// La cadena de conexión vive en un archivo .txt FUERA del código fuente (nunca en un .js/.ts).
// Por defecto, un nivel arriba de la carpeta del backend (ej. C:\InvoBot\db-connection.txt si el
// backend está en C:\InvoBot\backend). Se puede apuntar a otro lugar con DB_CONNECTION_FILE.
//
// Algunas empresas (ej. Global Go) viven en un servidor de base de datos totalmente distinto al
// principal. Para esos casos se usa una "conexión con nombre": un archivo aparte
// (db-connection-<key>.txt) o una variable de entorno DB_CONNECTION_FILE_<KEY>. La tabla
// `empresas` (columna `conexion`) le dice al código qué nombre de conexión usar para cada una.
// 'DEFAULT' (o vacío) siempre es la conexión principal (InvoiceGG + ADV_GLOFAC).

function resolveConnectionFile(key) {
  const k = (key || 'DEFAULT').toUpperCase();
  if (k === 'DEFAULT') {
    return process.env.DB_CONNECTION_FILE
      || path.join(__dirname, '..', '..', '..', 'db-connection.txt');
  }
  const envVar = `DB_CONNECTION_FILE_${k}`;
  return process.env[envVar]
    || path.join(__dirname, '..', '..', '..', `db-connection-${k.toLowerCase()}.txt`);
}

const connectionStrings = {};
function getConnectionString(key) {
  const k = (key || 'DEFAULT').toUpperCase();
  if (connectionStrings[k]) return connectionStrings[k];
  const file = resolveConnectionFile(k);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No se encontró el archivo de cadena de conexión (${k}): ${file}\n` +
      `Crea ese archivo con la cadena de conexión a SQL Server (ver db-connection.txt.example).`
    );
  }
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!raw) throw new Error(`El archivo de cadena de conexión está vacío (${k}): ${file}`);
  connectionStrings[k] = raw;
  return connectionStrings[k];
}

const poolPromises = {};
async function getPool(key) {
  const k = (key || 'DEFAULT').toUpperCase();
  if (!poolPromises[k]) {
    // OJO: sql.connect() de la librería 'mssql' es una conexión GLOBAL tipo singleton —
    // la primera llamada crea el pool y todas las siguientes (aunque se les pase una cadena
    // de conexión distinta) reutilizan ESE MISMO pool, ignorando el nuevo string. Como acá
    // manejamos varias conexiones con nombre (DEFAULT, GGO, etc.) hay que usar un
    // `new sql.ConnectionPool(...)` propio por cada una, para que sean independientes de verdad.
    poolPromises[k] = new sql.ConnectionPool(getConnectionString(k)).connect()
      .then((pool) => {
        logger.info(`Conexión SQL Server OK (${k})`);
        return pool;
      })
      .catch((err) => {
        poolPromises[k] = null; // permitir reintentar en el próximo request
        throw err;
      });
  }
  return poolPromises[k];
}

module.exports = { getPool, getConnectionString };
