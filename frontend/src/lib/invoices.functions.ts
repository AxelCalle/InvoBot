import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const ExtractInput = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  fileSize: z.number().int().nonnegative().max(20 * 1024 * 1024),
  base64: z.string().min(1),
  threadId: z.string().min(1).max(100),
});

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";


export const extractInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ExtractInput.parse(input))
  .handler(async ({ data, context }: any) => {

    const binaryBuffer = Buffer.from(data.base64, "base64");
    const blob = new Blob([binaryBuffer], { type: data.mimeType });

    const formData = new FormData();
    formData.append("factura", blob, data.filename);
    formData.append("usuario", context?.userId || "WEB");

    const res = await fetch(`${BACKEND_URL}/api/facturas`, {
      method: "POST",
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
        thread_id: data.threadId,
        extracted: result.resumen,
      }
    };
  });

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context: _context }: any) => {
    const res = await fetch(`${BACKEND_URL}/api/facturas`);
    if (!res.ok) throw new Error("Error obteniendo facturas");
    const result = await res.json();
    return { invoices: result.facturas ?? [] };
  });