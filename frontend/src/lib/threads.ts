import { BACKEND_URL } from "./backend-url";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  invoiceId?: string;
  attachment?: { filename: string; mimeType: string; size: number };
  createdAt: number;
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

function getKey(): string {
  try {
    const user = localStorage.getItem("invoicegg_user");
    if (user) {
      const parsed = JSON.parse(user);
      return `invoice-chat:threads:v1:${parsed.id}`;
    }
  } catch {
    // Usuario guardado inválido/corrupto — se usa la clave de invitado de abajo.
  }
  return "invoice-chat:threads:v1:guest";
}

function readLocal(): ChatThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getKey());
    return raw ? (JSON.parse(raw) as ChatThread[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(threads: ChatThread[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getKey(), JSON.stringify(threads));
}

// Caché en memoria: arranca con lo último guardado en este navegador (para que
// la pantalla no aparezca vacía mientras se conecta al servidor), y se
// reemplaza en cuanto llega la respuesta real del servidor.
let cache: ChatThread[] = readLocal();

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("threads:changed"));
}

function authHeaders() {
  const token = typeof window !== "undefined" ? localStorage.getItem("invoicegg_token") : null;
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Cuando se crea una conversación y se le agrega un mensaje casi al instante
// (que es lo normal: se crea y de inmediato el bot saluda), las 2 peticiones al
// servidor viajan en paralelo — si la de "agregar mensaje" llega antes que la de
// "crear conversación", la base de datos la rechaza (llave foránea inválida).
// Este mapa deja que "agregar mensaje" espere a que "crear conversación" haya
// terminado, sin que eso bloquee la pantalla (que ya se actualizó al instante).
const creacionesPendientes = new Map<string, Promise<void>>();

/**
 * Descarga el historial real del servidor y reemplaza la caché local — se debe
 * llamar apenas se inicia sesión (o al abrir la app ya con sesión activa), para
 * que el historial se vea igual sin importar desde qué computadora se entre.
 */
export async function syncThreadsFromServer(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/chat/threads`, { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;
    cache = data.threads || [];
    writeLocal(cache);
    notify();
  } catch {
    // Sin conexión: se sigue usando lo último que quedó guardado en este navegador.
  }
}

export const threadsStore = {
  list(): ChatThread[] {
    return [...cache].sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): ChatThread | undefined {
    return cache.find((t) => t.id === id);
  },
  create(): ChatThread {
    const now = Date.now();
    const thread: ChatThread = {
      id: crypto.randomUUID(),
      title: "Nueva conversación",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    cache = [thread, ...cache];
    writeLocal(cache);
    notify();
    const creacion = fetch(`${BACKEND_URL}/api/chat/threads`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ id: thread.id, title: thread.title }),
    })
      .then(() => {})
      .catch(() => {});
    creacionesPendientes.set(thread.id, creacion);
    creacion.finally(() => {
      if (creacionesPendientes.get(thread.id) === creacion) creacionesPendientes.delete(thread.id);
    });
    return thread;
  },
  delete(id: string) {
    cache = cache.filter((t) => t.id !== id);
    writeLocal(cache);
    notify();
    fetch(`${BACKEND_URL}/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    }).catch(() => {});
  },
  rename(id: string, title: string) {
    cache = cache.map((t) => (t.id === id ? { ...t, title, updatedAt: Date.now() } : t));
    writeLocal(cache);
    notify();
    fetch(`${BACKEND_URL}/api/chat/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ title }),
    }).catch(() => {});
  },
  appendMessage(id: string, message: ChatMessage) {
    const idx = cache.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const thread = cache[idx];
    const updated: ChatThread = {
      ...thread,
      messages: [...thread.messages, message],
      updatedAt: Date.now(),
      title:
        message.role === "user" &&
        message.attachment &&
        (thread.title === "Nueva conversación" ||
          thread.title === "New conversation" ||
          thread.title === "Sin título")
          ? message.attachment.filename.replace(/\.[^/.]+$/, "").slice(0, 40)
          : thread.title,
    };
    cache = [...cache];
    cache[idx] = updated;
    writeLocal(cache);
    notify();
    const enviar = () =>
      fetch(`${BACKEND_URL}/api/chat/threads/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(message),
      }).catch(() => {});
    // Si la conversación se acaba de crear, espera a que esa petición termine
    // antes de mandar el mensaje (si no, pueden llegar en el orden equivocado).
    const creacionPendiente = creacionesPendientes.get(id);
    if (creacionPendiente) creacionPendiente.then(enviar);
    else enviar();
  },
};

export function subscribeThreads(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener("threads:changed", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("threads:changed", handler);
    window.removeEventListener("storage", handler);
  };
}
