import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Iniciar sesión — InvoiceGG" }] }),
  component: LoginPage,
});

function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.isAuthenticated) navigate({ to: "/chat", replace: true });
  }, [auth.isAuthenticated, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.signIn(email, password);
      navigate({ to: "/chat", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al iniciar sesión");
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
      <form onSubmit={onSubmit} className="relative z-10 w-full max-w-sm space-y-5 rounded-xl border border-white/10 bg-white/95 p-8 shadow-lg">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <img src="/logo-grupo-global.png" alt="Grupo Global" className="h-8 w-auto" style={{ mixBlendMode: 'multiply' }} />
          <span>InvoiceGG</span>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">Bienvenido</h1>
          <p className="text-sm text-muted-foreground">Inicia sesión en tu cuenta</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Correo electrónico</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@empresa.com" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Contraseña</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">
              ¿Olvidaste tu contraseña?
            </Link>
          </div>
          <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Iniciando sesión…" : "Iniciar sesión"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          ¿No tienes cuenta? <Link to="/signup" className="text-primary hover:underline">Crear una</Link>
        </p>
      </form>
    </div>
  );
}