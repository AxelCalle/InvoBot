import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Loader2, Trash2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { BACKEND_URL } from "@/lib/backend-url";

export const Route = createFileRoute("/_authenticated/invoices")({
  component: InvoicesPage,
});

type Factura = {
  VOU: string;
  NUMERO: string;
  GLOSA: string;
  RUT: string;
  FECHA: string;
  TOTAL: string | number;
  MONEDA: string;
  AUSER: string;
};

function fmtMoney(total: string | number | null | undefined, moneda: string) {
  const n = parseFloat(String(total ?? 0));
  if (isNaN(n)) return "—";
  const cur = (moneda || "").toUpperCase();
  if (cur === "D") return `US$ ${n.toFixed(2)}`;
  return `S/ ${n.toFixed(2)}`;
}

function fmtFecha(fecha: string) {
  if (!fecha) return "—";
  return new Date(fecha).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function InvoicesPage() {
  const auth = useAuth();
  const esAdmin = auth.user?.rol === "admin";
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paginacion, setPaginacion] = useState({
    total: 0,
    pagina: 1,
    porPagina: 20,
    totalPaginas: 0,
  });
  const [filtroRuc, setFiltroRuc] = useState("");
  const [filtroNumero, setFiltroNumero] = useState("");
  const [filtroFechaDesde, setFiltroFechaDesde] = useState("");
  const [filtroFechaHasta, setFiltroFechaHasta] = useState("");
  const [facturaAEliminar, setFacturaAEliminar] = useState<{ vou: string; ruc: string } | null>(
    null,
  );
  const [eliminando, setEliminando] = useState(false);

  const confirmarEliminar = async () => {
    if (!facturaAEliminar) return;
    setEliminando(true);
    const token = localStorage.getItem("invoicegg_token");
    try {
      const params = new URLSearchParams({ ruc: facturaAEliminar.ruc });
      const res = await fetch(
        `${BACKEND_URL}/api/facturas/${encodeURIComponent(facturaAEliminar.vou)}?${params}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) throw new Error("Error al eliminar");
      toast.success(`Documento ${facturaAEliminar.vou} eliminado correctamente`);
      setFacturaAEliminar(null);
      cargarFacturas(paginacion.pagina);
    } catch {
      toast.error("No se pudo eliminar el documento. Inténtalo de nuevo.");
    } finally {
      setEliminando(false);
    }
  };

  const cargarFacturas = (pagina = 1) => {
    setLoading(true);
    const token = localStorage.getItem("invoicegg_token");
    const params = new URLSearchParams({
      pagina: String(pagina),
      porPagina: "20",
      ...(filtroRuc && { ruc: filtroRuc }),
      ...(filtroNumero && { numero: filtroNumero }),
      ...(filtroFechaDesde && { fechaDesde: filtroFechaDesde }),
      ...(filtroFechaHasta && { fechaHasta: filtroFechaHasta }),
    });

    fetch(`${BACKEND_URL}/api/facturas?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => {
        setFacturas(data.facturas || []);
        setPaginacion(data.paginacion || { total: 0, pagina: 1, porPagina: 20, totalPaginas: 0 });
        setLoading(false);
      })
      .catch(() => {
        setError("Error al cargar las facturas");
        setLoading(false);
      });
  };

  // Carga solo una vez al montar, con los filtros vacíos iniciales — cambiar un
  // filtro no debe recargar automáticamente, solo el botón "Buscar" (que ya usa
  // los valores actuales vía su propio closure).
  useEffect(() => {
    cargarFacturas(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buscar = () => cargarFacturas(1);

  const limpiarFiltros = () => {
    setFiltroRuc("");
    setFiltroNumero("");
    setFiltroFechaDesde("");
    setFiltroFechaHasta("");
    setTimeout(() => cargarFacturas(1), 100);
  };

  const PdfLink = ({ numero, ruc }: { numero: string; ruc: string }) => (
    <a
      href={`${BACKEND_URL}/api/facturas/pdf/${encodeURIComponent(numero)}?${new URLSearchParams({ ruc })}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
    >
      📄 PDF
    </a>
  );

  const DeleteButton = ({ vou, ruc }: { vou: string; ruc: string }) => (
    <button
      onClick={() => setFacturaAEliminar({ vou, ruc })}
      className="inline-flex items-center gap-1 rounded-md bg-red-50 border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-100"
      title="Eliminar documento"
    >
      <Trash2 className="h-3 w-3" /> Eliminar
    </button>
  );

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <header className="border-b px-4 md:px-6 py-3 flex items-center gap-3 md:gap-4">
          <Link to="/chat">
            <Button variant="ghost" size="sm" className="shrink-0">
              <ArrowLeft className="h-4 w-4 md:mr-1" />{" "}
              <span className="hidden md:inline">Volver</span>
            </Button>
          </Link>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Todas las facturas</h2>
            <p className="text-xs text-muted-foreground truncate">
              {paginacion.total > 0
                ? `${paginacion.total} comprobantes registrados`
                : "Comprobantes registrados en el sistema"}
            </p>
          </div>
        </header>

        {/* Filtros */}
        <div className="border-b px-4 md:px-6 py-3 bg-muted/10">
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">RUC</label>
              <Input
                placeholder="Buscar por RUC..."
                value={filtroRuc}
                onChange={(e) => setFiltroRuc(e.target.value)}
                className="h-9 md:h-8 w-full sm:w-40 text-sm"
                onKeyDown={(e) => e.key === "Enter" && buscar()}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Número</label>
              <Input
                placeholder="Nº comprobante..."
                value={filtroNumero}
                onChange={(e) => setFiltroNumero(e.target.value)}
                className="h-9 md:h-8 w-full sm:w-44 text-sm"
                onKeyDown={(e) => e.key === "Enter" && buscar()}
              />
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-xs text-muted-foreground">Fecha desde</label>
                <Input
                  type="date"
                  value={filtroFechaDesde}
                  onChange={(e) => setFiltroFechaDesde(e.target.value)}
                  className="h-9 md:h-8 w-full sm:w-36 text-sm"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <label className="text-xs text-muted-foreground">Fecha hasta</label>
                <Input
                  type="date"
                  value={filtroFechaHasta}
                  onChange={(e) => setFiltroFechaHasta(e.target.value)}
                  className="h-9 md:h-8 w-full sm:w-36 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={buscar} size="sm" className="h-9 md:h-8 flex-1 sm:flex-none">
                <Search className="h-3.5 w-3.5 mr-1" /> Buscar
              </Button>
              <Button
                onClick={limpiarFiltros}
                size="sm"
                variant="outline"
                className="h-9 md:h-8 flex-1 sm:flex-none"
              >
                <X className="h-3.5 w-3.5 mr-1" /> Limpiar
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 md:px-6 py-4">
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando facturas…
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && facturas.length === 0 && (
            <div className="rounded-xl border border-dashed bg-muted/20 p-10 text-center">
              <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 text-base font-medium">Sin facturas registradas</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Sube una factura desde el chat para verla aquí.
              </p>
            </div>
          )}

          {!loading && facturas.length > 0 && (
            <>
              {/* Tabla — desktop */}
              <div className="hidden md:block overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Voucher
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Número
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Glosa
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">RUC</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Fecha
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Total
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Usuario
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">PDF</th>
                      {esAdmin && (
                        <th className="px-4 py-3 text-left font-medium text-muted-foreground"></th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {facturas.map((f, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs">{f.VOU}</td>
                        <td className="px-4 py-3 font-mono text-xs">{f.NUMERO}</td>
                        <td className="px-4 py-3 max-w-xs truncate">{f.GLOSA}</td>
                        <td className="px-4 py-3 font-mono text-xs">{f.RUT}</td>
                        <td className="px-4 py-3 text-xs">{fmtFecha(f.FECHA)}</td>
                        <td className="px-4 py-3 text-right font-medium">
                          {fmtMoney(f.TOTAL, f.MONEDA)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{f.AUSER}</td>
                        <td className="px-4 py-3">
                          <PdfLink numero={f.NUMERO} ruc={f.RUT} />
                        </td>
                        {esAdmin && (
                          <td className="px-4 py-3">
                            <DeleteButton vou={f.VOU} ruc={f.RUT} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Tarjetas — móvil */}
              <div className="md:hidden space-y-3">
                {facturas.map((f, i) => (
                  <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-muted-foreground">{f.NUMERO}</p>
                        <p className="mt-0.5 text-sm font-medium truncate">{f.GLOSA || "—"}</p>
                      </div>
                      <p className="shrink-0 text-base font-semibold">
                        {fmtMoney(f.TOTAL, f.MONEDA)}
                      </p>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <div>
                        <span className="text-muted-foreground">Voucher</span>
                        <p className="font-mono">{f.VOU}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">RUC</span>
                        <p className="font-mono">{f.RUT}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Fecha</span>
                        <p>{fmtFecha(f.FECHA)}</p>
                      </div>
                      <div className="min-w-0">
                        <span className="text-muted-foreground">Usuario</span>
                        <p className="truncate">{f.AUSER || "—"}</p>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-2 border-t pt-3">
                      <PdfLink numero={f.NUMERO} ruc={f.RUT} />
                      {esAdmin && <DeleteButton vou={f.VOU} ruc={f.RUT} />}
                    </div>
                  </div>
                ))}
              </div>

              {/* Paginación */}
              <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground order-2 sm:order-1">
                  Mostrando {(paginacion.pagina - 1) * paginacion.porPagina + 1} —{" "}
                  {Math.min(paginacion.pagina * paginacion.porPagina, paginacion.total)} de{" "}
                  {paginacion.total} facturas
                </p>
                <div className="flex items-center gap-2 order-1 sm:order-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={paginacion.pagina <= 1}
                    onClick={() => cargarFacturas(paginacion.pagina - 1)}
                  >
                    ← Anterior
                  </Button>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    Página {paginacion.pagina} de {paginacion.totalPaginas}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={paginacion.pagina >= paginacion.totalPaginas}
                    onClick={() => cargarFacturas(paginacion.pagina + 1)}
                  >
                    Siguiente →
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!facturaAEliminar}
        onOpenChange={(open) => {
          if (!open && !eliminando) setFacturaAEliminar(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar documento?</AlertDialogTitle>
            <AlertDialogDescription>
              Se eliminará el comprobante{" "}
              <span className="font-mono font-medium text-foreground">{facturaAEliminar?.vou}</span>{" "}
              junto con sus asientos contables y su vinculación de empresa, área y concepto de
              gasto. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={eliminando}>Cancelar</AlertDialogCancel>
            <Button variant="destructive" onClick={confirmarEliminar} disabled={eliminando}>
              {eliminando ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Eliminando…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-1.5" /> Eliminar
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
