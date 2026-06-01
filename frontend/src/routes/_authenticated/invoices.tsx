import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { threadsStore, subscribeThreads, type ChatThread } from "@/lib/threads";
import { FileText, MessageSquarePlus, Trash2, LogOut, Database } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/invoices")({
  component: ChatLayout,
});

function ChatLayout() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    const refresh = () => setThreads(threadsStore.list());
    refresh();
    return subscribeThreads(refresh);
  }, []);

  useEffect(() => {
    if (pathname === "/chat") {
      const list = threadsStore.list();
      const target = list[0] ?? threadsStore.create();
      navigate({ to: "/chat/$threadId", params: { threadId: target.id }, replace: true });
    }
  }, [pathname, navigate]);

  const newThread = () => {
    const t = threadsStore.create();
    navigate({ to: "/chat/$threadId", params: { threadId: t.id } });
  };

  const removeThread = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    threadsStore.delete(id);
    if (pathname.includes(id)) {
      const remaining = threadsStore.list();
      const next = remaining[0]?.id ?? threadsStore.create().id;
      navigate({ to: "/chat/$threadId", params: { threadId: next }, replace: true });
    }
  };

  return (
    <div className="flex h-screen bg-background">
      <aside className="flex w-64 flex-col border-r bg-muted/20">
        <div className="flex items-center gap-2 px-4 py-4 font-semibold">
          <img src="/logo-grupo-global.png" alt="Grupo Global" className="h-7 w-auto" style={{ mixBlendMode: 'multiply' }} />
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
          <Link to="/invoices" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
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
      <main className="flex-1 overflow-hidden"><Outlet /></main>
    </div>
  );
}