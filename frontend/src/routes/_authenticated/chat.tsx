import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { threadsStore, syncThreadsFromServer } from "@/lib/threads";
import { AppShell } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/chat")({
  component: ChatLayout,
});

function ChatLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Trae el historial real del servidor una vez al entrar a /chat — así se ve
  // igual sin importar desde qué computadora se inició sesión. El resto de la
  // interfaz (barra lateral, conversación abierta) ya escucha el evento
  // "threads:changed" y se actualiza sola en cuanto llega la respuesta.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      await syncThreadsFromServer().catch(() => {});
      // Si justo se cayó en /chat "a secas" (sin threadId todavía), recién ahora
      // que el historial real ya llegó se decide a qué conversación entrar —
      // para no crear una conversación nueva de más mientras llegaba la sincronización.
      if (cancelado || pathname !== "/chat") return;
      const list = threadsStore.list();
      const target = list[0] ?? threadsStore.create();
      navigate({ to: "/chat/$threadId", params: { threadId: target.id }, replace: true });
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
