import { createMiddleware } from "@tanstack/react-start";

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next, request }: any) => {
    try {
      const authHeader = request?.headers?.get?.("authorization") || 
                         request?.headers?.authorization || "";
      const token = authHeader.replace("Bearer ", "");

      if (token) {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
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
    } catch {}

    return next({
      context: { userId: "WEB", userEmail: "", supabase: null },
    });
  }
);