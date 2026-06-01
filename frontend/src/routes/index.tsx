import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { FileText, Sparkles, Upload, Database } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "InvoiceGG — Chat with your invoices" },
      { name: "description", content: "Sube PDFs, imágenes o XML de facturas. Claude los lee y guarda los datos en tu base de datos." },
      { property: "og:title", content: "InvoiceGG — Chat with your invoices" },
      { property: "og:description", content: "Sube facturas en cualquier formato. Claude extrae los datos automáticamente." },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen relative">
      {/* Fondo */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/grupo-global-bg.jpg')" }}
      />
      {/* Overlay oscuro para legibilidad */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Contenido */}
      <div className="relative z-10">
        <header className="border-b border-white/10">
          <div className="container mx-auto flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <img 
                src="/logo-grupo-global.png" 
                alt="Grupo Global" 
                className="h-10 w-auto"
                style={{ mixBlendMode: 'screen' }}
              />
              <span className="font-semibold text-white text-lg">InvoiceGG</span>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild size="lg" className="bg-blue-600 hover:bg-blue-700 text-white border-0">
                <Link to="/login">Iniciar sesión</Link>
              </Button>
            </div>
          </div>
        </header>
        

        <main className="container mx-auto px-6 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs text-white/80">
              <Sparkles className="h-3 w-3" /> Powered by Claude
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-white md:text-6xl">
              Registra tus facturas automáticamente.
            </h1>
            <p className="mt-5 text-lg text-white/70">
              Sube una factura en PDF, JPG o XML. InvoBot lee cada línea y guarda los datos estructurados en tu base de datos al instante.
            </p>
            <div className="mt-8 flex justify-center gap-3">
              <Button asChild size="lg" className="bg-blue-600 hover:bg-blue-700 text-white">
                <Link to="/login">Iniciar sesión</Link>
              </Button>
            </div>
          </div>

          <div className="mx-auto mt-20 grid max-w-4xl gap-4 md:grid-cols-3">
            {[
              { icon: Upload, title: "Cualquier formato", body: "PDF, JPG, JPEG o XML — súbelo y nosotros lo procesamos." },
              { icon: Sparkles, title: "InvoBot lo lee", body: "Proveedor, totales, líneas de detalle, fechas — todo extraído con precisión." },
              { icon: Database, title: "Guardado al instante", body: "Cada factura se registra en base de datos." },
            ].map((f) => (
              <div key={f.title} className="rounded-lg border border-white/10 bg-white/10 backdrop-blur-sm p-6">
                <f.icon className="h-5 w-5 text-blue-400" />
                <h3 className="mt-3 font-medium text-white">{f.title}</h3>
                <p className="mt-1 text-sm text-white/70">{f.body}</p>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}