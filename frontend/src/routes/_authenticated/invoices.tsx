import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Loader2, Database, LogOut, MessageSquarePlus, Trash2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { threadsStore, subscribeThreads, type ChatThread } from "@/lib/threads";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/invoices")({
  component: InvoicesPage,
});

const BACKEND_URL = "http://localhost:3001";

function fmtMoney(total: any, moneda: string) {
  const n = parseFloat(total || 0);
  if (isNaN(n)) return "—";
  const cur = (moneda || "").toUpperCase();
  if (cur === "D") return `US$ ${n.toFixed(2)}`;
  return `S/ ${n.toFixed(2)}`;
}

function fmtFecha(fecha: string) {
  if (!fecha) return "—";
  return new Date(fecha).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function InvoicesPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paginacion, setPaginacion] = useState({ total: 0, pagina: 1, porPagina: 20, totalPaginas: 0 });
  const [filtroRuc, setFiltroRuc] = useState("");
  const [filtroNumero, setFiltroNumero] = useState("");
  const [filtroFechaDesde, setFiltroFechaDesde] = useState("");
  const [filtroFechaHasta, setFiltroFechaHasta] = useState("");

  useEffect(() => {
    const refresh = () => setThreads(threadsStore.list());
    refresh();
    return subscribeThreads(refresh);
  }, []);

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

  useEffect(() => {
    cargarFacturas(1);
  }, []);

  const buscar = () => cargarFacturas(1);

  const limpiarFiltros = () => {
    setFiltroRuc("");
    setFiltroNumero("");
    setFiltroFechaDesde("");
    setFiltroFechaHasta("");
    setTimeout(() => cargarFacturas(1), 100);
  };

  const newThread = () => {
    const t = threadsStore.create();
    navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
  };

  const removeThread = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    threadsStore.delete(id);
    const remaining = threadsStore.list();
    const next = remaining[0]?.id ?? threadsStore.create().id;
    navigate({ to: "/chat/$threadId", params: { threadId: next }, replace: true });
  };

  return (
    <div className="flex h-screen bg-background">
      <aside className="flex w-64 flex-col border-r bg-muted/20">
        <div className="flex items-center gap-2 px-4 py-4 font-semibold">
          <img src="/logo-grupo-global.png" alt="Grupo Global" className="h-7 w-auto" style={{ mixBlendMode: "multiply" }} />
          <span>InvoiceGG</span>
        </div>
        <div className="px-3">
          <Button onClick={newThread} className="w-full justify-start gap-2" size="sm">
            <MessageSquarePlus className="h-4 w-4" /> Nueva conversación
          </Button>
        </div>
        <nav className="mt-4 flex-1 overflow-y-auto px-2">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Conversaciones</p>
          {threads.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">Sin conversaciones aún.</p>
          )}
          <ul className="space-y-0.5">
            {threads.map((t) => {
              const active = pathname.endsWith(t.id);
              return (
                <li key={t.id} className={cn(
                  "group flex items-center justify-between gap-1 rounded-md pr-1 hover:bg-accent",
                  active && "bg-accent",
                )}>
                  <Link
                    to="/chat/$threadId"
                    params={{ threadId: t.id }}
                    className={cn("flex-1 truncate px-2 py-1.5 text-sm", active && "font-medium")}
                  >
                    {t.title || "Sin título"}
                  </Link>
                  <button
                    onClick={(e) => removeThread(t.id, e)}
                    className="invisible rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive group-hover:visible"
                    aria-label="Eliminar conversación"
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t p-2">
          <Link to="/invoices" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent bg-accent">
            <Database className="h-4 w-4" /> Todas las facturas
          </Link>
          <div className="mt-1 flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground">
            <span className="truncate">{auth.user?.email}</span>
            <button
              onClick={() => auth.signOut()}
              className="rounded p-1 hover:bg-accent hover:text-foreground"
              aria-label="Cerrar sesión"
              type="button"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden flex flex-col">
        <header className="border-b px-6 py-3 flex items-center gap-4">
          <Link to="/chat">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
          </Link>
          <div>
            <h2 className="text-sm font-semibold">Todas las facturas</h2>
            <p className="text-xs text-muted-foreground">
              {paginacion.total > 0 ? `${paginacion.total} comprobantes registrados` : "Comprobantes registrados en el sistema"}
            </p>
          </div>
        </header>

        <div className="border-b px-6 py-3 bg-muted/10">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">RUC</label>
              <Input
                placeholder="Buscar por RUC..."
                value={filtroRuc}
                onChange={(e) => setFiltroRuc(e.target.value)}
                className="h-8 w-40 text-sm"
                onKeyDown={(e) => e.key === "Enter" && buscar()}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Número</label>
              <Input
                placeholder="Nº comprobante..."
                value={filtroNumero}
                onChange={(e) => setFiltroNumero(e.target.value)}
                className="h-8 w-44 text-sm"
                onKeyDown={(e) => e.key === "Enter" && buscar()}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Fecha desde</label>
              <Input
                type="date"
                value={filtroFechaDesde}
                onChange={(e) => setFiltroFechaDesde(e.target.value)}
                className="h-8 w-36 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Fecha hasta</label>
              <Input
                type="date"
                value={filtroFechaHasta}
                onChange={(e) => setFiltroFechaHasta(e.target.value)}
                className="h-8 w-36 text-sm"
              />
            </div>
            <Button onClick={buscar} size="sm" className="h-8">
              <Search className="h-3.5 w-3.5 mr-1" /> Buscar
            </Button>
            <Button onClick={limpiarFiltros} size="sm" variant="outline" className="h-8">
              <X className="h-3.5 w-3.5 mr-1" /> Limpiar
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
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
              <p className="mt-1 text-sm text-muted-foreground">Sube una factura desde el chat para verla aquí.</p>
            </div>
          )}

          {!loading && facturas.length > 0 && (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Voucher</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Número</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Glosa</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">RUC</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Fecha</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Total</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Usuario</th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">PDF</th>
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
                        <td className="px-4 py-3 text-right font-medium">{fmtMoney(f.TOTAL, f.MONEDA)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{f.AUSER}</td>
                        <td className="px-4 py-3">
                          <a
                            href={`${BACKEND_URL}/api/facturas/pdf/${encodeURIComponent(f.NUMERO)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                          >
                            📄 PDF
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  Mostrando {((paginacion.pagina - 1) * paginacion.porPagina) + 1} — {Math.min(paginacion.pagina * paginacion.porPagina, paginacion.total)} de {paginacion.total} facturas
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={paginacion.pagina <= 1}
                    onClick={() => cargarFacturas(paginacion.pagina - 1)}
                  >
                    ← Anterior
                  </Button>
                  <span className="text-xs text-muted-foreground">
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
      </main>
    </div>
  );
}