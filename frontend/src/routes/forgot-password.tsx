import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Recuperar contraseña — InvoiceGG" }] }),
  component: ForgotPasswordPage,
});

const BACKEND_URL = "http://localhost:3001";

function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [codigo, setCodigo] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCodigo(data.codigo);
      toast.success("Código temporal generado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al generar código");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{
        backgroundImage: "url('/grupo-global-bg.jpg')",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative z-10 w-full max-w-sm space-y-5 rounded-xl border border-white/10 bg-white/95 p-8 shadow-lg">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <img src="/logo-grupo-global.png" alt="Grupo Global" className="h-8 w-auto" style={{ mixBlendMode: 'multiply' }} />
          <span>InvoiceGG</span>
        </Link>

        {!codigo ? (
          <>
            <div>
              <h1 className="text-2xl font-semibold">Recuperar contraseña</h1>
              <p className="text-sm text-muted-foreground">Ingresa tu correo y te generaremos un código temporal</p>
            </div>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Correo electrónico</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="correo@empresa.com"
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Generando código…" : "Generar código temporal"}
              </Button>
            </form>
            <p className="text-center text-sm text-muted-foreground">
              <Link to="/login" className="text-primary hover:underline">Volver al inicio de sesión</Link>
            </p>
          </>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-semibold">¡Código generado!</h1>
              <p className="text-sm text-muted-foreground">Usa este código para iniciar sesión</p>
            </div>
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-center">
              <p className="text-xs text-blue-600 mb-1">Tu código temporal es:</p>
              <p className="text-3xl font-bold tracking-widest text-blue-800">{codigo}</p>
              <p className="text-xs text-blue-500 mt-2">Válido por 24 horas</p>
            </div>
            <p className="text-sm text-muted-foreground text-center">
              Una vez que inicies sesión podrás cambiar tu contraseña desde el chat.
            </p>
            <Button className="w-full" onClick={() => navigate({ to: "/login" })}>
              Ir al inicio de sesión
            </Button>
          </>
        )}
      </div>
    </div>
  );
}