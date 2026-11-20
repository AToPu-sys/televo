// react-native-web ships Alert.alert as a no-op, so every confirmation,
// action menu and warning in the app (62 call sites) silently did nothing
// on the web. This renders a small Televo-styled dialog with the same API.
// Built with DOM + CSSOM only (no innerHTML), so titles and messages that
// contain user text are always treated as text.

type AlertButton = { text?: string; onPress?: (value?: string) => void; style?: "default" | "cancel" | "destructive" };
type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };

const queue: (() => void)[] = [];
let open = false;

function css(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

function show(title: string, message: string | undefined, buttons: AlertButton[], options?: AlertOptions) {
  open = true;
  const prevFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  css(overlay, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,0.55)", display: "flex",
    alignItems: "center", justifyContent: "center", zIndex: "2147483647", padding: "16px",
  });
  const box = document.createElement("div");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  css(box, {
    background: "#1F2A36", color: "#F4F6F8", borderRadius: "16px", width: "100%", maxWidth: "360px",
    boxShadow: "0 24px 60px rgba(0,0,0,0.5)", overflow: "hidden",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });
  const body = document.createElement("div");
  css(body, { padding: "20px 20px 14px", textAlign: "center" });
  const h = document.createElement("div");
  h.textContent = title;
  h.id = "televo-alert-title";
  box.setAttribute("aria-labelledby", h.id);
  css(h, { fontWeight: "700", fontSize: "17px", marginBottom: message ? "8px" : "0" });
  body.appendChild(h);
  if (message) {
    const p = document.createElement("div");
    p.textContent = message;
    css(p, { fontSize: "14.5px", lineHeight: "1.45", color: "#B7C1CC", whiteSpace: "pre-wrap" });
    body.appendChild(p);
  }
  box.appendChild(body);

  const list = buttons.length ? buttons : [{ text: "OK" }];
  const row = document.createElement("div");
  const stacked = list.length > 2;
  css(row, { display: "flex", flexDirection: stacked ? "column" : "row", borderTop: "1px solid #2E3B49" });

  const close = (after?: () => void) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    open = false;
    prevFocus?.focus?.();
    after?.();
    queue.shift()?.();
  };
  const cancelBtn = list.find((b) => b.style === "cancel");
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && (cancelBtn || options?.cancelable)) {
      e.preventDefault();
      close(() => (cancelBtn ? cancelBtn.onPress?.() : options?.onDismiss?.()));
    }
  };

  list.forEach((b, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.text ?? "OK";
    css(btn, {
      flex: "1", padding: "14px 12px", background: "transparent", border: "0", cursor: "pointer",
      fontSize: "16px", fontFamily: "inherit",
      fontWeight: b.style === "cancel" ? "600" : "500",
      color: b.style === "destructive" ? "#FF6B6B" : "#5EB5F7",
      borderLeft: !stacked && i > 0 ? "1px solid #2E3B49" : "0",
      borderTop: stacked && i > 0 ? "1px solid #2E3B49" : "0",
    });
    btn.addEventListener("click", () => close(() => b.onPress?.()));
    row.appendChild(btn);
  });
  box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && options?.cancelable) close(() => options?.onDismiss?.());
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  (row.querySelector("button") as HTMLButtonElement | null)?.focus();
}

const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) {
    if (typeof document === "undefined") return;
    const run = () => show(String(title ?? ""), message == null ? undefined : String(message), buttons ?? [], options);
    if (open) queue.push(run);
    else run();
  },
  prompt(title: string, message?: string, callbackOrButtons?: ((text: string) => void) | AlertButton[]) {
    const value = window.prompt([title, message].filter(Boolean).join("\n\n"));
    if (value == null) return;
    if (typeof callbackOrButtons === "function") callbackOrButtons(value);
    else callbackOrButtons?.find((b) => b.style !== "cancel")?.onPress?.(value);
  },
};

export default Alert;
