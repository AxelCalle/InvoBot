import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";

const INACTIVIDAD_MS = 5 * 60 * 1000; // 5 minutos
const AVISO_MS = 3 * 60 * 1000;       // aviso a los 3 minutos

export function useSessionTimeout(onExpire: () => void) {
  const timerExpire = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerAviso = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef<string | number | null>(null);

  const resetTimers = useCallback(() => {
    if (timerExpire.current) clearTimeout(timerExpire.current);
    if (timerAviso.current) clearTimeout(timerAviso.current);
    if (toastId.current) toast.dismiss(toastId.current);

    timerAviso.current = setTimeout(() => {
      toastId.current = toast.warning(
        "Tu sesión expirará en 2 minutos por inactividad. Haz clic aquí para continuar.",
        {
          duration: 120000,
          action: {
            label: "Continuar sesión",
            onClick: () => resetTimers(),
          },
        }
      );
    }, AVISO_MS);

    timerExpire.current = setTimeout(() => {
      toast.error("Sesión expirada por inactividad.");
      onExpire();
    }, INACTIVIDAD_MS);
  }, [onExpire]);

  useEffect(() => {
    const eventos = ["mousedown", "mousemove", "keydown", "scroll", "touchstart", "click"];
    eventos.forEach((e) => window.addEventListener(e, resetTimers));
    resetTimers();

    return () => {
      eventos.forEach((e) => window.removeEventListener(e, resetTimers));
      if (timerExpire.current) clearTimeout(timerExpire.current);
      if (timerAviso.current) clearTimeout(timerAviso.current);
    };
  }, [resetTimers]);
}