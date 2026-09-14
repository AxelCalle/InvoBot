import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";

const INACTIVIDAD_MS = 30 * 60 * 1000; // 30 minutos
const AVISO_MS = 25 * 60 * 1000; // aviso a los 25 minutos (5 min antes de expirar)
const GRACIA_MS = INACTIVIDAD_MS - AVISO_MS; // tiempo restante tras el aviso
const GRACIA_MIN = Math.round(GRACIA_MS / 60000);

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
        `Tu sesión expirará en ${GRACIA_MIN} minutos por inactividad. Haz clic aquí para continuar.`,
        {
          duration: GRACIA_MS,
          action: {
            label: "Continuar sesión",
            onClick: () => resetTimers(),
          },
        },
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
