import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Paperclip, Send, FileText, Loader2, Bot, User as UserIcon } from "lucide-react";
import { threadsStore, subscribeThreads, type ChatThread, type ChatMessage } from "@/lib/threads";
import { extractInvoice } from "@/lib/invoices.functions";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  component: ChatThreadPage,
});

const ACCEPT = ".pdf,.xml,.jpg,.jpeg,.png,application/pdf,text/xml,application/xml,image/jpeg,image/png";
const MAX_BYTES = 20 * 1024 * 1024;
const BACKEND_URL = "http://localhost:3001";

type Empresa = { id: number; codigo: string; nombre: string };
type Area = { id: number; codigo: string; nombre: string };
type ChatStep = "idle" | "esperando_empresa" | "esperando_area" | "esperando_factura" | "procesando";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      const i = r.indexOf(",");
      resolve(i >= 0 ? r.slice(i + 1) : r);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fmtMoney(total: any, currency: string | null | undefined) {
  const n = parseFloat(String(total));
  if (isNaN(n)) return "—";
  const cur = (currency || "PEN").toUpperCase();
  if (cur === "USD" || cur === "D") return `US$ ${n.toFixed(2)}`;
  return `S/ ${n.toFixed(2)}`;
}

function ChatThreadPage() {
  const { threadId } = Route.useParams();
  const extract = useServerFn(extractInvoice);
  const [thread, setThread] = useState<ChatThread | undefined>(() => threadsStore.get(threadId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<ChatStep>("idle");
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [empresaSeleccionada, setEmpresaSeleccionada] = useState<Empresa | null>(null);
  const [areaSeleccionada, setAreaSeleccionada] = useState<Area | null>(null);
  const iniciado = useRef(false);

  useEffect(() => {
    const token = localStorage.getItem("invoicegg_token");
    Promise.all([
      fetch(`${BACKEND_URL}/api/facturas/empresas`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${BACKEND_URL}/api/facturas/areas`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([empData, areaData]) => {
      setEmpresas(empData.empresas || []);
      setAreas(areaData.areas || []);
    });
  }, []);

  useEffect(() => {
    const refresh = () => setThread(threadsStore.get(threadId));
    refresh();
    return subscribeThreads(refresh);
  }, [threadId]);

  useEffect(() => {
    if (!iniciado.current && empresas.length > 0) {
      const current = threadsStore.get(threadId);
      if (!current || current.messages.length === 0) {
        iniciado.current = true;
        setStep("esperando_empresa");
        threadsStore.appendMessage(threadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "¡Hola! Antes de registrar la factura, dime: ¿A qué empresa corresponde?",
          createdAt: Date.now(),
        });
      }
    }
  }, [empresas, threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length, busy, step]);

  const messages = thread?.messages ?? [];
  const isSpanish = (t: string) => /[áéíóúñ¿¡]/i.test(t) || !t.trim();

  const resetFlow = (mensaje?: string) => {
    setEmpresaSeleccionada(null);
    setAreaSeleccionada(null);
    setStep("esperando_empresa");
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: mensaje || "¿Deseas registrar otra factura? ¿A qué empresa corresponde?",
      createdAt: Date.now(),
    });
  };

  const verificarPresupuesto = async (empresaId: number, areaId: number) => {
    try {
      const token = localStorage.getItem("invoicegg_token");
      const res = await fetch(`${BACKEND_URL}/api/facturas/presupuesto/${empresaId}/${areaId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!data.ok || data.presupuesto === 0) return null;
      if (data.excedido) {
        return `⚠️ *Presupuesto excedido*: Has gastado S/ ${data.gastado.toFixed(2)} de S/ ${data.presupuesto.toFixed(2)} (${data.porcentaje}%) este mes.`;
      } else if (data.alerta) {
        return `⚠️ *Alerta de presupuesto*: Has usado el ${data.porcentaje}% del presupuesto mensual (S/ ${data.gastado.toFixed(2)} de S/ ${data.presupuesto.toFixed(2)}).`;
      }
      return null;
    } catch {
      return null;
    }
  };

  const procesarFactura = async (file: File, empresa: Empresa, area: Area) => {
    setBusy(true);
    setStep("procesando");

    try {
      const base64 = await fileToBase64(file);
      const mt = (file.type || "").toLowerCase();
      const lower = file.name.toLowerCase();
      const mimeType = mt || (lower.endsWith(".pdf") ? "application/pdf"
        : lower.endsWith(".xml") ? "application/xml"
        : lower.endsWith(".png") ? "image/png" : "image/jpeg");

      const res = await extract({ data: { filename: file.name, mimeType, fileSize: file.size, base64, threadId } });
      const inv = res.invoice;

      const token = localStorage.getItem("invoicegg_token");

      await fetch(`${BACKEND_URL}/api/facturas/vincular`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vou: inv?.id,
          empresa_id: empresa.id,
          area_id: area.id,
          monto: 0,
          moneda: inv?.currency || "PEN",
        }),
      });

      const numeroFactura = (inv?.invoice_number || "").replace(/-/g, "");
      const totalRes = await fetch(
        `${BACKEND_URL}/api/facturas/total/${encodeURIComponent(numeroFactura)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.json());

      const totalReal = totalRes.total || 0;
      const monedaReal = totalRes.moneda === 'D' ? 'USD' : 'PEN';

      const summary = [
        inv?.vendor ? `${inv.vendor}` : null,
        inv?.invoice_number ? `Factura #${inv.invoice_number}` : null,
        totalReal > 0 ? `Total: ${fmtMoney(totalReal, monedaReal)}` : null,
      ].filter(Boolean).join(" · ");

      const alerta = await verificarPresupuesto(empresa.id, area.id);
      const advertenciaSunat = inv?.advertencia_sunat || null;

      let texto = `✅ Factura registrada en *${empresa.nombre}* — *${area.nombre}*.\n${summary || ""}`;
      if (alerta) texto += `\n\n${alerta}`;
      if (advertenciaSunat) texto += `\n\n${advertenciaSunat}`;

      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: texto,
        invoiceId: inv?.id,
        createdAt: Date.now(),
      });
      toast.success("Factura registrada correctamente");

      setTimeout(() => resetFlow("¿Deseas registrar otra factura? ¿A qué empresa corresponde?"), 1500);

    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al procesar";
      const esDuplicado = msg.includes("409") || msg.includes("ya fue registrado");
      const esIlegible = msg.includes("422") || msg.includes("datos mínimos");

      const texto = esDuplicado
        ? "⚠️ Esta factura ya fue registrada anteriormente en el sistema. No se realizó un registro duplicado."
        : esIlegible
        ? "📄 No pude leer correctamente el documento. Intenta con una imagen más nítida o en formato PDF."
        : "❌ Ocurrió un error al procesar la factura. Por favor intenta nuevamente.";

      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: texto,
        createdAt: Date.now(),
      });
      toast.error(esDuplicado ? "Factura duplicada" : "Error al procesar");

      setTimeout(() => resetFlow("¿Deseas intentar con otra factura? ¿A qué empresa corresponde?"), 1500);

    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    if (step !== "esperando_factura") {
      toast.error("Primero selecciona la empresa y el área.");
      return;
    }
    if (file.size > MAX_BYTES) { toast.error("Archivo muy grande (máx 20 MB)"); return; }
    const mt = (file.type || "").toLowerCase();
    const nameOk = /\.(pdf|xml|jpe?g|png)$/i.test(file.name);
    const allowed = ["application/pdf", "text/xml", "application/xml", "image/jpeg", "image/jpg", "image/png"];
    if (!allowed.includes(mt) && !nameOk) {
      toast.error("Formato no soportado. Usa PDF, XML, JPG o PNG.");
      return;
    }

    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: `Archivo subido: ${file.name}`,
      attachment: { filename: file.name, mimeType: mt || "application/octet-stream", size: file.size },
      createdAt: Date.now(),
    });

    if (empresaSeleccionada && areaSeleccionada) {
      procesarFactura(file, empresaSeleccionada, areaSeleccionada);
    }
  };

  const seleccionarEmpresa = (empresa: Empresa) => {
    setEmpresaSeleccionada(empresa);
    setStep("esperando_area");
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: empresa.nombre,
      createdAt: Date.now(),
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Perfecto. ¿A qué área de *${empresa.nombre}* corresponde la factura?`,
      createdAt: Date.now(),
    });
  };

  const seleccionarArea = (area: Area) => {
    setAreaSeleccionada(area);
    setStep("esperando_factura");
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: area.nombre,
      createdAt: Date.now(),
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Listo. Ahora sube la factura de *${empresaSeleccionada?.nombre}* — *${area.nombre}* usando el clip 📎`,
      createdAt: Date.now(),
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (file) {
      await handleFile(file);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (!text.trim() || step !== "idle") return;
    threadsStore.appendMessage(threadId, { id: crypto.randomUUID(), role: "user", text: text.trim(), createdAt: Date.now() });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: isSpanish(text)
        ? "Adjunta una factura con el clip 📎 y la registraré automáticamente."
        : "Attach an invoice with the paperclip 📎 and I'll process it automatically.",
      createdAt: Date.now(),
    });
    setText("");
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-3 md:px-6 py-2 md:py-3">
        <h2 className="text-sm font-semibold truncate">{thread?.title || "Conversación"}</h2>
        <p className="text-xs text-muted-foreground hidden md:block">
          Sube facturas en PDF, JPG, PNG o XML. InvoBot las lee y guarda los datos automáticamente.
        </p>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 md:px-6 py-4 md:py-6"
        style={{
          backgroundImage: "url('/fondo-chat.jpg')",
          backgroundSize: "300%",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 md:gap-6">
          {messages.map((m) => <Bubble key={m.id} m={m} />)}

          {step === "esperando_empresa" && (
            <div className="flex flex-wrap gap-2 pl-0 md:pl-10">
              {empresas.map((e) => (
                <button
                  key={e.id}
                  onClick={() => seleccionarEmpresa(e)}
                  className="rounded-full border border-blue-300 bg-white/90 px-3 py-1.5 text-xs md:text-sm font-medium text-blue-700 hover:bg-blue-50 backdrop-blur-sm shadow-sm"
                >
                  {e.nombre}
                </button>
              ))}
            </div>
          )}

          {step === "esperando_area" && (
            <div className="flex flex-wrap gap-2 pl-0 md:pl-10">
              {areas.map((a) => (
                <button
                  key={a.id}
                  onClick={() => seleccionarArea(a)}
                  className="rounded-full border border-blue-300 bg-white/90 px-3 py-1.5 text-xs md:text-sm font-medium text-blue-700 hover:bg-blue-50 backdrop-blur-sm shadow-sm"
                >
                  {a.nombre}
                </button>
              ))}
            </div>
          )}

          {step === "esperando_factura" && !busy && (
            <div className="pl-0 md:pl-10">
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 rounded-full border border-blue-300 bg-white/90 px-4 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 backdrop-blur-sm shadow-sm"
              >
                <Paperclip className="h-4 w-4" /> Subir factura
              </button>
            </div>
          )}

          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-white/80 backdrop-blur-sm rounded-lg px-3 py-2 w-fit">
              <div className="flex h-5 w-5 items-center justify-center rounded-[6px] text-white" style={{ background: 'linear-gradient(135deg, #1a56db, #1e3a8a)' }}>
                <Bot className="h-3 w-3" />
              </div>
              <span className="text-xs md:text-sm">InvoBot está leyendo la factura…</span>
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          )}
        </div>
      </div>

      <form onSubmit={onSubmit} className="border-t bg-background px-3 md:px-6 py-3 md:py-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f).finally(() => { if (fileRef.current) fileRef.current.value = ""; });
            }}
          />
          <Button type="button" variant="outline" size="icon" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Adjuntar factura" className="shrink-0">
            <Paperclip className="h-4 w-4" />
          </Button>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe un mensaje…" disabled={busy} className="text-sm" />
          <Button type="submit" disabled={busy} aria-label="Enviar" className="shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={cn("flex gap-2 md:gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="mt-1 flex h-6 w-6 md:h-7 md:w-7 shrink-0 items-center justify-center rounded-[8px] text-white" style={{ background: 'linear-gradient(135deg, #1a56db, #1e3a8a)' }}>
          <Bot className="h-3 w-3 md:h-4 md:w-4" />
        </div>
      )}
      <div className="max-w-[85%] md:max-w-[80%] space-y-1 md:space-y-2">
        {m.attachment && (
          <div className={cn("inline-flex items-center gap-2 rounded-md border bg-white/90 backdrop-blur-sm px-2 py-1.5 text-xs", isUser && "ml-auto")}>
            <FileText className="h-3 w-3 md:h-4 md:w-4 text-primary shrink-0" />
            <span className="font-medium truncate max-w-[150px] md:max-w-none">{m.attachment.filename}</span>
            <span className="text-muted-foreground shrink-0">{(m.attachment.size / 1024).toFixed(1)} KB</span>
          </div>
        )}
        <div className={cn(
          "whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs md:text-sm shadow-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-white/90 backdrop-blur-sm text-foreground",
        )}>
          {m.text}
        </div>
      </div>
      {isUser && (
        <div className="mt-1 flex h-6 w-6 md:h-7 md:w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UserIcon className="h-3 w-3 md:h-4 md:w-4" />
        </div>
      )}
    </div>
  );
}