import { createMiddleware } from "@tanstack/react-start";

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  // El tipo real de estos argumentos lo infiere @tanstack/react-start con genéricos
  // que no se pueden replicar aquí sin romper la inferencia de la librería — `any`
  // es intencional en este punto puntual, no un descuido.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ next, request }: any) => {
    try {
      const authHeader =
        request?.headers?.get?.("authorization") || request?.headers?.authorization || "";
      const token = authHeader.replace("Bearer ", "");

      if (token) {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
          );
          return next({
            context: {
              userId: payload.email?.split("@")[0] || "WEB",
              userEmail: payload.email || "",
              supabase: null,
            },
          });
        }
      }
    } catch {
      // Token ilegible/malformado — se sigue con el contexto anónimo de abajo.
    }

    return next({
      context: { userId: "WEB", userEmail: "", supabase: null },
    });
  },
);
