import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ExtractInput = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  fileSize: z
    .number()
    .int()
    .nonnegative()
    .max(20 * 1024 * 1024),
  base64: z.string().min(1),
  threadId: z.string().min(1).max(100),
  empresaCodigo: z.string().max(20).optional(),
  conceptoGastoId: z.number().int().positive().optional(),
  areaId: z.number().int().positive().optional(),
  periodo: z.string().max(10).optional(),
  // Nombre de usuario a usar en el correlativo (AUSER/MTV en GGO, ComUsuC en GF).
  // Si no se manda, se usa el prefijo del email (comportamiento anterior).
  usuario: z.string().max(10).optional(),
  token: z.string().min(1),
});

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

export const extractInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ExtractInput.parse(input))
  .handler(
    // Igual que en auth-middleware.ts: el tipo real de { data, context } lo infiere
    // la librería con genéricos que no se pueden replicar sin romper el build.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ data, context }: any) => {
      const binaryBuffer = Buffer.from(data.base64, "base64");
      const blob = new Blob([binaryBuffer], { type: data.mimeType });

      const formData = new FormData();
      formData.append("factura", blob, data.filename);
      formData.append("usuario", data.usuario || context?.userId || "WEB");
      if (data.empresaCodigo) formData.append("empresa_codigo", data.empresaCodigo);
      if (data.conceptoGastoId) formData.append("concepto_gasto_id", String(data.conceptoGastoId));
      if (data.areaId) formData.append("area_id", String(data.areaId));
      if (data.periodo) formData.append("periodo", data.periodo);

      const res = await fetch(`${BACKEND_URL}/api/facturas`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.token}` },
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Backend error (${res.status}): ${errText.slice(0, 500)}`);
      }

      const result = await res.json();

      return {
        invoice: {
          id: result.voucher,
          filename: data.filename,
          vendor: result.resumen?.emisor ?? null,
          invoice_number: result.resumen?.serie_numero ?? null,
          invoice_date: result.resumen?.fecha ?? null,
          total: result.resumen?.total ?? null,
          currency: result.resumen?.moneda ?? null,
          ruc: result.resumen?.ruc ?? null,
          thread_id: data.threadId,
          extracted: result.resumen,
          sunat: result.sunat ?? null,
          validacion_sunat: result.validacion_sunat ?? null,
          advertencia_sunat: result.advertencia_sunat ?? null,
        },
      };
    },
  );

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ token: z.string().min(1) }).parse(input))
  .handler(async ({ data }: { data: { token: string } }) => {
    const res = await fetch(`${BACKEND_URL}/api/facturas`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    if (!res.ok) throw new Error("Error obteniendo facturas");
    const result = await res.json();
    return { invoices: result.facturas ?? [] };
  });
