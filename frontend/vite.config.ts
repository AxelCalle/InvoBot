// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.

import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
    router: { basepath: "/GLOBALINVOBOT" },
  },
  // Habilita el build de Nitro con preset "node-server": genera un servidor
  // Node.js standalone en .output/server/index.mjs para desplegar en un VPS
  // propio (en vez del handler tipo Cloudflare Worker que sale por defecto).
  nitro: {
    preset: "node-server",
    // Nitro tiene su propio "baseURL" (aparte del basepath del router y el base de Vite):
    // controla dónde sirve sus rutas y los archivos estáticos (CSS, imágenes públicas).
    // Sin esto, seguía sirviendo todo en "/" aunque el router ya usara /GLOBALINVOBOT.
    baseURL: "/GLOBALINVOBOT/",
  },
  // Pre-empaqueta los paquetes Radix que se montan en runtime para evitar la
  // re-optimización en caliente de Vite (que provocaba errores transitorios
  // "Invalid hook call" la primera vez que se abría un componente Radix en dev).
  // Solo afecta al arranque del servidor de desarrollo; no cambia el build ni el runtime.
  vite: {
    // El sitio se publica en /GLOBALINVOBOT/ (subcarpeta de IIS), no en la raíz del dominio.
    base: "/GLOBALINVOBOT/",
    optimizeDeps: {
      include: ["@radix-ui/react-alert-dialog", "@radix-ui/react-label"],
    },
  },
});
