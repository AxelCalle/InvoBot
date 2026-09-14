import { useEffect, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  MessageSquarePlus,
  Trash2,
  LogOut,
  Database,
  Menu,
  X,
  KeyRound,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { threadsStore, subscribeThreads, type ChatThread } from "@/lib/threads";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { BACKEND_URL } from "@/lib/backend-url";

function ResetPasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [passwordDeseada, setPasswordDeseada] = useState("");
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<{ email: string; nuevaPassword: string } | null>(null);
  const [copiado, setCopiado] = useState(false);

  const reset = () => {
    setEmail("");
    setPasswordDeseada("");
    setResultado(null);
    setCopiado(false);
  };

  const generarSugerencia = () => {
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const sugerida = btoa(String.fromCharCode(...bytes))
      .replace(/[+/=]/g, "")
      .slice(0, 12);
    setPasswordDeseada(sugerida);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordDeseada && passwordDeseada.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres");
      return;
    }
    setBusy(true);
    try {
      const token = localStorage.getItem("invoicegg_token");
      const res = await fetch(`${BACKEND_URL}/api/auth/admin/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, nuevaPasswordDeseada: passwordDeseada || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo resetear la contraseña");
      setResultado({ email: data.email, nuevaPassword: data.nuevaPassword });
      toast.success("Contraseña reseteada");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al resetear la contraseña");
    } finally {
      setBusy(false);
    }
  };

  const copiar = () => {
    if (!resultado) return;
    navigator.clipboard.writeText(resultado.nuevaPassword).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Resetear contraseña de usuario</DialogTitle>
          <DialogDescription>
            Genera una nueva contraseña permanente para el usuario. Cambia su clave real de
            inmediato — comunícasela por fuera del sistema.
          </DialogDescription>
        </DialogHeader>

        {!resultado ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reset-email">Correo del usuario</Label>
              <Input
                id="reset-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="usuario@empresa.com"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reset-password">Nueva contraseña (opcional)</Label>
              <div className="flex gap-2">
                <Input
                  id="reset-password"
                  type="text"
                  value={passwordDeseada}
                  onChange={(e) => setPasswordDeseada(e.target.value)}
                  placeholder="Déjalo vacío para generar una automática"
                  minLength={6}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={generarSugerencia}
                  className="shrink-0"
                >
                  Sugerir
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Escribe la contraseña que quieras asignar (mín. 6 caracteres), o déjalo vacío para
                que se genere una al azar.
              </p>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Reseteando…
                  </>
                ) : (
                  "Resetear contraseña"
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/50 border p-3">
              <p className="text-xs text-muted-foreground">Usuario</p>
              <p className="text-sm font-medium">{resultado.email}</p>
              <p className="text-xs text-muted-foreground mt-2">Nueva contraseña</p>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="flex-1 rounded bg-background border px-2 py-1 text-sm font-mono">
                  {resultado.nuevaPassword}
                </code>
                <button
                  type="button"
                  onClick={copiar}
                  className="rounded p-1.5 hover:bg-accent"
                  aria-label="Copiar"
                >
                  {copiado ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Ya funciona como su contraseña real (no es temporal). Comunícasela de forma segura.
            </p>
            <DialogFooter>
              <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
                Cerrar
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SidebarContent({ onNavigate }: { onNavigate: () => void }) {
  const navigate = useNavigate();
  const auth = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [resetOpen, setResetOpen] = useState(false);
  const esAdmin = auth.user?.rol === "admin";

  useEffect(() => {
    const refresh = () => setThreads(threadsStore.list());
    refresh();
    return subscribeThreads(refresh);
  }, []);

  const newThread = () => {
    const t = threadsStore.create();
    navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
    onNavigate();
  };

  const removeThread = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    threadsStore.delete(id);
    if (pathname.includes(id)) {
      const remaining = threadsStore.list();
      const next = remaining[0]?.id ?? threadsStore.create().id;
      navigate({
        to: "/chat/$threadId",
        params: { threadId: next },
        replace: true,
      });
    }
  };

  const invoicesActive = pathname.startsWith("/invoices");

  return (
    <>
      <div className="flex items-center justify-between px-4 py-4 font-semibold">
        <div className="flex items-center gap-2">
          <img
            src={`${import.meta.env.BASE_URL}logo-grupo-global.png`}
            alt="Grupo Global"
            className="h-7 w-auto"
            style={{ mixBlendMode: "multiply" }}
          />
          <span>InvoiceGG</span>
        </div>
        <button
          onClick={onNavigate}
          className="md:hidden rounded p-1 hover:bg-accent"
          type="button"
          aria-label="Cerrar menú"
        >
          <X className="h-4 w-4" />
        </button>
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
              <li
                key={t.id}
                className={cn(
                  "group flex items-center justify-between gap-1 rounded-md pr-1 hover:bg-accent",
                  active && "bg-accent",
                )}
              >
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: t.id }}
                  onClick={onNavigate}
                  className={cn("flex-1 truncate px-2 py-1.5 text-sm", active && "font-medium")}
                >
                  {t.title || "Sin título"}
                </Link>
                <button
                  onClick={(e) => removeThread(t.id, e)}
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive md:invisible md:group-hover:visible"
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
        <Link
          to="/invoices"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
            invoicesActive && "bg-accent font-medium",
          )}
        >
          <Database className="h-4 w-4" /> Todas las facturas
        </Link>
        {esAdmin && (
          <button
            onClick={() => setResetOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            type="button"
          >
            <KeyRound className="h-4 w-4" /> Resetear contraseña
          </button>
        )}
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
      {esAdmin && <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} />}
    </>
  );
}

/**
 * Marco responsive de la app: sidebar fijo en desktop y drawer deslizable en móvil.
 * Comparte el mismo sidebar entre el chat y la vista de facturas.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Cerrar el drawer al navegar en móvil
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const close = () => setSidebarOpen(false);

  return (
    <div className="flex h-screen bg-background">
      {/* Overlay móvil */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}

      {/* Sidebar desktop — siempre visible */}
      <aside className="hidden md:flex w-64 flex-col border-r bg-muted/20">
        <SidebarContent onNavigate={close} />
      </aside>

      {/* Sidebar móvil — slide in */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r bg-background transition-transform duration-200 md:hidden",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarContent onNavigate={close} />
      </aside>

      {/* Contenido principal */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Barra superior móvil */}
        <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded p-1.5 hover:bg-accent"
            type="button"
            aria-label="Abrir menú"
          >
            <Menu className="h-5 w-5" />
          </button>
          <img
            src={`${import.meta.env.BASE_URL}logo-grupo-global.png`}
            alt="Grupo Global"
            className="h-6 w-auto"
            style={{ mixBlendMode: "multiply" }}
          />
          <span className="text-sm font-semibold">InvoiceGG</span>
        </div>

        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
