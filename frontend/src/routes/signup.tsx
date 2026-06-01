import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Crear cuenta — InvoiceGG" }] }),
  component: SignupPage,
});

function SignupPage() {
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
      await auth.signUp(email, password);
      toast.success("Cuenta creada correctamente");
      navigate({ to: "/chat", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al crear la cuenta");
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
          <h1 className="text-2xl font-semibold">Crear cuenta</h1>
          <p className="text-sm text-muted-foreground">Empieza a registrar facturas en segundos</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Correo electrónico</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@empresa.com" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Contraseña</Label>
          <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 6 caracteres" />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creando cuenta…" : "Crear cuenta"}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          ¿Ya tienes cuenta? <Link to="/login" className="text-primary hover:underline">Iniciar sesión</Link>
        </p>
      </form>
    </div>
  );
}