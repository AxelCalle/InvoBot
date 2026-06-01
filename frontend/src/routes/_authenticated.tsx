import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated) {
      navigate({ to: "/login", replace: true });
    }
  }, [auth.isAuthenticated, auth.isLoading, navigate]);

  if (auth.isLoading || !auth.isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <Outlet />;
}
