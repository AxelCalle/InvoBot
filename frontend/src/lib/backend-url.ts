// URL base para llamadas del NAVEGADOR al backend.
//
// - Si VITE_BACKEND_URL está definida, se usa tal cual (cualquier despliegue).
// - En desarrollo (`npm run dev`), por defecto apunta directo al backend local
//   (no hay gateway delante mientras se desarrolla).
// - En producción, por defecto usa la misma ruta base del sitio (BASE_URL, ej.
//   "/GLOBALINVOBOT/" sin la barra final) para que "/api/..." caiga dentro de
//   esa subcarpeta y no en la raíz del dominio.
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : import.meta.env.BASE_URL.replace(/\/$/, ""));
