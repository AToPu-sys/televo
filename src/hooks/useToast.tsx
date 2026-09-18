import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: string;
  kind: ToastKind;
  message: string;
  /** Optional second line — e.g. the reason a send failed. */
  detail?: string;
  /** Label for the single trailing action, if any. */
  actionLabel?: string;
  onAction?: () => void;
};

type ToastContextValue = {
  toast: Toast | null;
  /** Shows a toast, replacing any toast currently on screen. Returns its id
   * so a caller can dismiss its own toast without racing a newer one. */
  show: (input: Omit<Toast, "id">) => string;
  dismiss: (id?: string) => void;
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

/** How long each kind stays up. Errors linger: they usually carry an action
 * ("Retry"), and dismissing one before it can be read makes a failure look
 * like nothing happened at all. */
const DURATION: Record<ToastKind, number> = {
  success: 2000,
  info: 2600,
  error: 4500,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counterRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(
    (id?: string) => {
      // An id-scoped dismiss must not kill a NEWER toast: by the time a
      // caller's own timeout or retry resolves, the user may have triggered
      // something else, and blanking that would look like a dropped action.
      setToast((current) => {
        if (id && current?.id !== id) return current;
        clearTimer();
        return null;
      });
    },
    [clearTimer]
  );

  const show = useCallback(
    (input: Omit<Toast, "id">) => {
      counterRef.current += 1;
      const id = `toast-${counterRef.current}`;
      clearTimer();

      setToast({ ...input, id });
      timerRef.current = setTimeout(() => dismiss(id), DURATION[input.kind]);
      return id;
    },
    [clearTimer, dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toast, show, dismiss }),
    [toast, show, dismiss]
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
