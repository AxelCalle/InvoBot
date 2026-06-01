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
    const user = localStorage.getItem('invoicegg_user');
    if (user) {
      const parsed = JSON.parse(user);
      return `invoice-chat:threads:v1:${parsed.id}`;
    }
  } catch {}
  return 'invoice-chat:threads:v1:guest';
}

function read(): ChatThread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getKey());
    return raw ? (JSON.parse(raw) as ChatThread[]) : [];
  } catch {
    return [];
  }
}

function write(threads: ChatThread[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getKey(), JSON.stringify(threads));
  window.dispatchEvent(new Event("threads:changed"));
}

export const threadsStore = {
  list(): ChatThread[] {
    return read().sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): ChatThread | undefined {
    return read().find((t) => t.id === id);
  },
  create(): ChatThread {
    const now = Date.now();
    const thread: ChatThread = {
      id: crypto.randomUUID(),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    write([thread, ...read()]);
    return thread;
  },
  delete(id: string) {
    write(read().filter((t) => t.id !== id));
  },
  rename(id: string, title: string) {
    write(read().map((t) => (t.id === id ? { ...t, title, updatedAt: Date.now() } : t)));
  },
  appendMessage(id: string, message: ChatMessage) {
    const threads = read();
    const idx = threads.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const thread = threads[idx];
    const updated: ChatThread = {
      ...thread,
      messages: [...thread.messages, message],
      updatedAt: Date.now(),
      title:
        thread.messages.length === 0 && message.role === "user" && message.attachment
          ? message.attachment.filename.slice(0, 40)
          : thread.title,
    };
    threads[idx] = updated;
    write(threads);
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