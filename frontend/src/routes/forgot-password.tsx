import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Recuperar contraseña — InvoiceGG" }] }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{
        backgroundImage: `url('${import.meta.env.BASE_URL}grupo-global-bg.jpg')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative z-10 w-full max-w-sm space-y-5 rounded-xl border border-white/10 bg-white/95 p-8 shadow-lg">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <img
            src={`${import.meta.env.BASE_URL}logo-grupo-global.png`}
            alt="Grupo Global"
            className="h-8 w-auto"
            style={{ mixBlendMode: "multiply" }}
          />
          <span>InvoiceGG</span>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">Recuperar contraseña</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Por seguridad, el restablecimiento de contraseña lo realiza un administrador del
            sistema. Contacta al administrador de InvoiceGG en tu empresa y te asignará una nueva
            contraseña.
          </p>
        </div>
        <Button asChild className="w-full">
          <Link to="/login">Volver al inicio de sesión</Link>
        </Button>
      </div>
    </div>
  );
}
