import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command";
import {
  Paperclip,
  Send,
  FileText,
  Loader2,
  Bot,
  User as UserIcon,
  ChevronsUpDown,
  Check,
  Tag,
} from "lucide-react";
import { threadsStore, subscribeThreads, type ChatThread, type ChatMessage } from "@/lib/threads";
import { extractInvoice } from "@/lib/invoices.functions";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BACKEND_URL } from "@/lib/backend-url";

// Normalized line endings to remove stray carriage-return characters.

export const Route = createFileRoute("/_authenticated/chat/$threadId")({
  component: ChatThreadPage,
});

const ACCEPT =
  ".pdf,.xml,.jpg,.jpeg,.png,application/pdf,text/xml,application/xml,image/jpeg,image/png";
const MAX_BYTES = 20 * 1024 * 1024;

// Persistencia del estado del flujo por conversación (para restaurar burbujas al recargar)
const FLOW_KEY = (id: string) => `invoice-chat:flow:v1:${id}`;
function saveFlow(threadId: string, data: FlowState) {
  try {
    localStorage.setItem(FLOW_KEY(threadId), JSON.stringify(data));
  } catch {
    // Ignore localStorage write failures.
  }
}
function loadFlow(threadId: string): FlowState | null {
  try {
    const r = localStorage.getItem(FLOW_KEY(threadId));
    return r ? (JSON.parse(r) as FlowState) : null;
  } catch {
    return null;
  }
}

type Empresa = { id: number; codigo: string; nombre: string };
type Area = { id: number; codigo: string; nombre: string };
type ConceptoGasto = { id: number; nombre: string; cuenta?: string; descripcion?: string };
type ChatStep =
  | "idle"
  | "esperando_empresa"
  | "esperando_periodo"
  | "esperando_area"
  | "esperando_concepto"
  | "esperando_factura"
  | "procesando";
type PeriodoOpcion = { value: string; label: string };
type FlowState = {
  step?: ChatStep;
  empresa?: Empresa | null;
  periodo?: string | null;
  area?: Area | null;
  concepto?: ConceptoGasto | null;
};

const MESES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];
const DIA_LIMITE_PERIODO_ANTERIOR = 10;

// Contabilidad tiene hasta el día 10 de cada mes para seguir registrando comprobantes
// del mes anterior — mismo límite que valida el backend (resolverPeriodoGF), esto solo
// decide qué opciones mostrar en el combo.
function opcionesPeriodo(ahora: Date = new Date()): PeriodoOpcion[] {
  const actual: PeriodoOpcion = {
    value: `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`,
    label: `${MESES[ahora.getMonth()]} ${ahora.getFullYear()}`,
  };
  const opciones = [actual];
  if (ahora.getDate() <= DIA_LIMITE_PERIODO_ANTERIOR) {
    const anterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
    opciones.push({
      value: `${anterior.getFullYear()}-${String(anterior.getMonth() + 1).padStart(2, "0")}`,
      label: `${MESES[anterior.getMonth()]} ${anterior.getFullYear()}`,
    });
  }
  return opciones;
}

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

function fmtMoney(total: string | number | null | undefined, currency: string | null | undefined) {
  const n = parseFloat(String(total));
  if (isNaN(n)) return "—";
  const cur = (currency || "PEN").toUpperCase();
  if (cur === "USD" || cur === "D") return `US$ ${n.toFixed(2)}`;
  return `S/ ${n.toFixed(2)}`;
}

function ChatThreadPage() {
  const { threadId } = Route.useParams();
  const extract = useServerFn(extractInvoice);
  const { user } = useAuth();
  const [thread, setThread] = useState<ChatThread | undefined>(() => threadsStore.get(threadId));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<ChatStep>("idle");
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [conceptos, setConceptos] = useState<ConceptoGasto[]>([]);
  const [empresaSeleccionada, setEmpresaSeleccionada] = useState<Empresa | null>(null);
  const [periodoSeleccionado, setPeriodoSeleccionado] = useState<string | null>(null);
  const [areaSeleccionada, setAreaSeleccionada] = useState<Area | null>(null);
  const [conceptoSeleccionado, setConceptoSeleccionado] = useState<ConceptoGasto | null>(null);
  const iniciado = useRef<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("invoicegg_token");
    Promise.all([
      fetch(`${BACKEND_URL}/api/facturas/empresas`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
      fetch(`${BACKEND_URL}/api/facturas/areas`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
      fetch(`${BACKEND_URL}/api/facturas/conceptos-gasto`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json()),
    ])
      .then(([empData, areaData, concData]) => {
        setEmpresas(empData.empresas || []);
        setAreas(areaData.areas || []);
        setConceptos(concData.conceptos || []);
      })
      .catch(() => {
        // Si falla la carga, se reintenta al cambiar de hilo (dep del efecto de init)
      });
  }, []);

  useEffect(() => {
    const refresh = () => setThread(threadsStore.get(threadId));
    refresh();
    return subscribeThreads(refresh);
  }, [threadId]);

  // Al cambiar de conversación: restaurar el flujo persistido (o limpiar si no hay)
  useEffect(() => {
    const flow = loadFlow(threadId);
    if (flow?.step) {
      setStep(flow.step);
      setEmpresaSeleccionada(flow.empresa ?? null);
      setPeriodoSeleccionado(flow.periodo ?? null);
      setAreaSeleccionada(flow.area ?? null);
      setConceptoSeleccionado(flow.concepto ?? null);
    } else {
      setStep("idle");
      setEmpresaSeleccionada(null);
      setPeriodoSeleccionado(null);
      setAreaSeleccionada(null);
      setConceptoSeleccionado(null);
    }
  }, [threadId]);

  // Iniciar el flujo por cada hilo nuevo/vacío sin flujo previo (una vez por threadId)
  useEffect(() => {
    if (empresas.length === 0) return;
    if (iniciado.current === threadId) return;
    iniciado.current = threadId;
    const current = threadsStore.get(threadId);
    if ((!current || current.messages.length === 0) && !loadFlow(threadId)) {
      setStep("esperando_empresa");
      saveFlow(threadId, { step: "esperando_empresa" });
      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "¡Hola! Antes de registrar el documento, dime: ¿A qué empresa corresponde?",
        createdAt: Date.now(),
      });
    }
  }, [empresas, threadId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length, busy, step]);

  const messages = thread?.messages ?? [];

  const resetFlow = (mensaje?: string) => {
    setEmpresaSeleccionada(null);
    setPeriodoSeleccionado(null);
    setAreaSeleccionada(null);
    setConceptoSeleccionado(null);
    setStep("esperando_empresa");
    saveFlow(threadId, { step: "esperando_empresa" });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: mensaje || "¿Deseas registrar otro documento? ¿A qué empresa corresponde?",
      createdAt: Date.now(),
    });
  };

  const verificarPresupuesto = async (empresaId: number, areaId: number) => {
    try {
      const token = localStorage.getItem("invoicegg_token");
      const res = await fetch(`${BACKEND_URL}/api/facturas/presupuesto/${empresaId}/${areaId}`, {
        headers: { Authorization: `Bearer ${token}` },
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

  const procesarFactura = async (
    file: File,
    empresa: Empresa,
    area: Area,
    concepto?: ConceptoGasto | null,
    periodo?: string | null,
  ) => {
    setBusy(true);
    setStep("procesando");

    try {
      const token = localStorage.getItem("invoicegg_token") || "";
      const base64 = await fileToBase64(file);
      const mt = (file.type || "").toLowerCase();
      const lower = file.name.toLowerCase();
      const mimeType =
        mt ||
        (lower.endsWith(".pdf")
          ? "application/pdf"
          : lower.endsWith(".xml")
            ? "application/xml"
            : lower.endsWith(".png")
              ? "image/png"
              : "image/jpeg");

      // Cada empresa lleva su propio correlativo por usuario (AUSER/MTV en Global Go,
      // ComUsuC en Global Factoring) — si el usuario logueado tiene un nombre propio
      // configurado para esta empresa (usuario_gf/usuario_ggo), se usa ese en vez del
      // prefijo del email (comportamiento por defecto cuando no está configurado).
      const usuarioPorEmpresa = empresa.codigo === "GF" ? user?.usuario_gf : user?.usuario_ggo;

      const res = await extract({
        data: {
          filename: file.name,
          mimeType,
          fileSize: file.size,
          base64,
          threadId,
          empresaCodigo: empresa.codigo,
          conceptoGastoId: concepto?.id,
          areaId: area.id,
          periodo: periodo ?? undefined,
          usuario: usuarioPorEmpresa || undefined,
          token,
        },
      });
      const inv = res.invoice;

      // La bitácora (factura_empresa_area) se registra automáticamente en el backend
      // al procesar el documento — ya no se llama a /vincular por separado.

      const partes = (inv?.invoice_number || "").split("-");
      const numeroFactura =
        partes.length === 2
          ? partes[0] + partes[1].replace(/^0+/, "").padStart(8, "0")
          : (inv?.invoice_number || "").replace(/-/g, "");
      const totalRes = await fetch(
        `${BACKEND_URL}/api/facturas/total/${encodeURIComponent(numeroFactura)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then((r) => r.json());

      const totalReal = totalRes.total || 0;
      const monedaReal = totalRes.moneda === "D" ? "USD" : "PEN";

      const tipoDocMap: Record<string, string> = {
        "01": "Factura",
        "02": "RxH",
        "03": "Boleta",
        "07": "Nota Crédito",
        "08": "Nota Débito",
      };
      const tipoDoc =
        tipoDocMap[
          inv?.extracted?.tipo === "FACTURA"
            ? "01"
            : inv?.extracted?.tipo === "BOLETA"
              ? "03"
              : inv?.extracted?.tipo === "RECIBO_HONORARIOS"
                ? "02"
                : inv?.extracted?.tipo === "NOTA_CREDITO"
                  ? "07"
                  : inv?.extracted?.tipo === "NOTA_DEBITO"
                    ? "08"
                    : "01"
        ] || "Documento";

      const summary = [
        inv?.vendor ? `${inv.vendor}` : null,
        inv?.invoice_number ? `${tipoDoc} #${inv.invoice_number}` : null,
        totalReal > 0 ? `Total: ${fmtMoney(totalReal, monedaReal)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const alerta = await verificarPresupuesto(empresa.id, area.id);
      const advertenciaSunat = inv?.advertencia_sunat || null;
      const validacionSunat = inv?.validacion_sunat;

      // Mensaje de validación SUNAT
      const estadoCpTexto = validacionSunat?.estadoCp ? ` (${validacionSunat.estadoCp})` : "";
      const mensajeSunat =
        validacionSunat?.estado === "OK"
          ? `🟢 *Comprobante validado en SUNAT*${estadoCpTexto} — Emisor activo, habido y comprobante aceptado.`
          : validacionSunat?.estado === "NO_DISPONIBLE"
            ? `🟡 *SUNAT no disponible* — ${advertenciaSunat || "No se pudo verificar el comprobante."}`
            : validacionSunat?.estado === "NO_ENCONTRADO"
              ? `🟡 *Comprobante no encontrado en SUNAT*${estadoCpTexto} — Se registró de todas formas.`
              : validacionSunat?.estado === "NO_CONFIGURADO"
                ? `🟢 *RUC validado* — Emisor activo y habido.`
                : null;

      if (mensajeSunat) {
        threadsStore.appendMessage(threadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          text: mensajeSunat,
          createdAt: Date.now(),
        });
      }

      let texto = `✅ Documento registrado en *${empresa.nombre}* — *${area.nombre}*.\n${summary || ""}`;
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

      setTimeout(
        () => resetFlow("¿Deseas registrar otra factura? ¿A qué empresa corresponde?"),
        1500,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error al procesar";
      const esDuplicado = msg.includes("409") || msg.includes("ya fue registrado");

      // Intentar extraer el mensaje real del backend del formato "Backend error (4xx): {...}"
      let textoBackend: string | null = null;
      const jsonMatch = msg.match(/Backend error \(\d+\): (.+)/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.error) textoBackend = parsed.error;
        } catch {
          // El backend no devolvió JSON válido — se usa el mensaje genérico de abajo.
        }
      }

      const texto = esDuplicado
        ? "⚠️ Esta factura ya fue registrada anteriormente en el sistema. No se realizó un registro duplicado."
        : textoBackend
          ? `❌ ${textoBackend}`
          : "❌ Ocurrió un error al procesar la factura. Por favor intenta nuevamente.";

      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: texto,
        createdAt: Date.now(),
      });
      toast.error(esDuplicado ? "Factura duplicada" : "Error al procesar");

      setTimeout(
        () => resetFlow("¿Deseas intentar con otra factura? ¿A qué empresa corresponde?"),
        1500,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File) => {
    if (step !== "esperando_factura") {
      toast.error("Primero selecciona la empresa y el área.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Archivo muy grande (máx 20 MB)");
      return;
    }
    const mt = (file.type || "").toLowerCase();
    const nameOk = /\.(pdf|xml|jpe?g|png)$/i.test(file.name);
    const allowed = [
      "application/pdf",
      "text/xml",
      "application/xml",
      "image/jpeg",
      "image/jpg",
      "image/png",
    ];
    if (!allowed.includes(mt) && !nameOk) {
      toast.error("Formato no soportado. Usa PDF, XML, JPG o PNG.");
      return;
    }

    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: `Archivo subido: ${file.name}`,
      attachment: {
        filename: file.name,
        mimeType: mt || "application/octet-stream",
        size: file.size,
      },
      createdAt: Date.now(),
    });

    if (empresaSeleccionada && areaSeleccionada) {
      procesarFactura(
        file,
        empresaSeleccionada,
        areaSeleccionada,
        conceptoSeleccionado,
        periodoSeleccionado,
      );
    }
  };

  const seleccionarEmpresa = (empresa: Empresa) => {
    setEmpresaSeleccionada(empresa);
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: empresa.nombre,
      createdAt: Date.now(),
    });

    // Los conceptos de gasto son distintos por empresa (cada una tiene su propio
    // plan de cuentas), así que se recargan según la empresa recién elegida.
    const token = localStorage.getItem("invoicegg_token");
    fetch(`${BACKEND_URL}/api/facturas/conceptos-gasto?empresa_id=${empresa.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => setConceptos(data.conceptos || []))
      .catch(() => {});

    // El período contable (mes actual / mes anterior hasta el día 10) solo aplica
    // hoy a Global Factoring — el resto de empresas pasa directo a elegir área.
    if (empresa.codigo === "GF") {
      setStep("esperando_periodo");
      saveFlow(threadId, { step: "esperando_periodo", empresa });
      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Perfecto. ¿A qué período contable corresponde este documento?`,
        createdAt: Date.now(),
      });
    } else {
      setStep("esperando_area");
      saveFlow(threadId, { step: "esperando_area", empresa });
      threadsStore.appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        text: `Perfecto. ¿A qué área de *${empresa.nombre}* corresponde la factura?`,
        createdAt: Date.now(),
      });
    }
  };

  const seleccionarPeriodo = (opcion: PeriodoOpcion) => {
    setPeriodoSeleccionado(opcion.value);
    setStep("esperando_area");
    saveFlow(threadId, {
      step: "esperando_area",
      empresa: empresaSeleccionada,
      periodo: opcion.value,
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: opcion.label,
      createdAt: Date.now(),
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Perfecto. ¿A qué área de *${empresaSeleccionada?.nombre}* corresponde la factura?`,
      createdAt: Date.now(),
    });
  };

  const seleccionarArea = (area: Area) => {
    setAreaSeleccionada(area);
    setStep("esperando_concepto");
    saveFlow(threadId, {
      step: "esperando_concepto",
      empresa: empresaSeleccionada,
      periodo: periodoSeleccionado,
      area,
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: area.nombre,
      createdAt: Date.now(),
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Perfecto. ¿Cuál es el concepto de gasto?`,
      createdAt: Date.now(),
    });
  };

  const seleccionarConcepto = (concepto: ConceptoGasto) => {
    setConceptoSeleccionado(concepto);
    setStep("esperando_factura");
    saveFlow(threadId, {
      step: "esperando_factura",
      empresa: empresaSeleccionada,
      periodo: periodoSeleccionado,
      area: areaSeleccionada,
      concepto,
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: concepto.nombre,
      createdAt: Date.now(),
    });
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "assistant",
      text: `Listo. Ahora sube el documento de *${empresaSeleccionada?.nombre}* — *${areaSeleccionada?.nombre}* — *${concepto.nombre}* usando el clip 📎`,
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
    threadsStore.appendMessage(threadId, {
      id: crypto.randomUUID(),
      role: "user",
      text: text.trim(),
      createdAt: Date.now(),
    });
    setText("");
    // El chat es un flujo de registro: si el usuario escribe estando inactivo,
    // reiniciamos la selección de empresa para que pueda continuar (en español).
    resetFlow("Para registrar un documento, dime: ¿A qué empresa corresponde?");
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
          backgroundImage: `url('${import.meta.env.BASE_URL}fondo-chat.jpg')`,
          backgroundSize: "300%",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 md:gap-6">
          {messages.map((m) => (
            <Bubble key={m.id} m={m} />
          ))}

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

          {step === "esperando_periodo" && (
            <div className="flex flex-wrap gap-2 pl-0 md:pl-10">
              {opcionesPeriodo().map((o) => (
                <button
                  key={o.value}
                  onClick={() => seleccionarPeriodo(o)}
                  className="rounded-full border border-blue-300 bg-white/90 px-3 py-1.5 text-xs md:text-sm font-medium text-blue-700 hover:bg-blue-50 backdrop-blur-sm shadow-sm"
                >
                  {o.label}
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

          {step === "esperando_concepto" && (
            <div className="pl-0 md:pl-10">
              <ConceptoCombobox conceptos={conceptos} onSelect={seleccionarConcepto} />
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
              <div
                className="flex h-5 w-5 items-center justify-center rounded-[6px] text-white"
                style={{ background: "linear-gradient(135deg, #1a56db, #1e3a8a)" }}
              >
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
              if (f)
                handleFile(f).finally(() => {
                  if (fileRef.current) fileRef.current.value = "";
                });
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label="Adjuntar factura"
            className="shrink-0"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe un mensaje…"
            disabled={busy}
            className="text-sm"
          />
          <Button type="submit" disabled={busy} aria-label="Enviar" className="shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConceptoCombobox({
  conceptos,
  onSelect,
}: {
  conceptos: ConceptoGasto[];
  onSelect: (c: ConceptoGasto) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-blue-300 bg-white/90 px-4 py-1.5 text-xs md:text-sm font-medium text-blue-700 hover:bg-blue-50 backdrop-blur-sm shadow-sm"
        >
          <Tag className="h-3.5 w-3.5" />
          Selecciona el concepto de gasto…
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,440px)] p-0" align="start">
        <Command
          filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder="Buscar por nombre, cuenta o descripción…" />
          <CommandList className="max-h-72">
            <CommandEmpty>Sin resultados.</CommandEmpty>
            {conceptos.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.nombre} ${c.descripcion ?? ""} ${c.cuenta ?? ""}`}
                onSelect={() => {
                  setOpen(false);
                  onSelect(c);
                }}
                className="py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{c.nombre}</span>
                  {c.cuenta && (
                    <span className="text-xs text-muted-foreground font-mono">
                      Cuenta {c.cuenta}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === "user";
  return (
    <div className={cn("flex gap-2 md:gap-3", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div
          className="mt-1 flex h-6 w-6 md:h-7 md:w-7 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: "linear-gradient(135deg, #1a56db, #1e3a8a)" }}
        >
          <Bot className="h-3 w-3 md:h-4 md:w-4" />
        </div>
      )}
      <div className="max-w-[85%] md:max-w-[80%] space-y-1 md:space-y-2">
        {m.attachment && (
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-md border bg-white/90 backdrop-blur-sm px-2 py-1.5 text-xs",
              isUser && "ml-auto",
            )}
          >
            <FileText className="h-3 w-3 md:h-4 md:w-4 text-primary shrink-0" />
            <span className="font-medium truncate max-w-37.5 md:max-w-none">
              {m.attachment.filename}
            </span>
            <span className="text-muted-foreground shrink-0">
              {(m.attachment.size / 1024).toFixed(1)} KB
            </span>
          </div>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs md:text-sm shadow-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-white/90 backdrop-blur-sm text-foreground",
          )}
        >
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
