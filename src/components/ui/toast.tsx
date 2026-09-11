"use client";

/**
 * Toasts, with Undo.
 *
 * Every mutation that removes data offers Undo here rather than a confirmation
 * dialog, per the PRD: archive over delete, and nothing is both silent and
 * irreversible. The Undo window is the toast lifetime.
 */

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { toastClass } from "./recipes";
import { Button } from "./primitives";

export interface Toast {
  id: string;
  title: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
  undo?: () => void;
  duration?: number;
}

interface Ctx { push: (t: Omit<Toast, "id">) => string; dismiss: (id: string) => void }
const ToastCtx = React.createContext<Ctx | null>(null);

export function useToast() {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timers = React.useRef(new Map<string, number>());

  const dismiss = React.useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const h = timers.current.get(id);
    if (h) { clearTimeout(h); timers.current.delete(id); }
  }, []);

  const push = React.useCallback((t: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2);
    // Undo toasts live longer, because reading and reacting takes time.
    const duration = t.duration ?? (t.undo ? 8000 : 5000);
    setToasts((prev) => [...prev.slice(-2), { ...t, id }]);
    timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
    return id;
  }, [dismiss]);

  const value = React.useMemo(() => ({ push, dismiss }), [push, dismiss]);

  // Cmd+Z triggers the most recent undoable toast.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z")) return;
      const last = [...toasts].reverse().find((t) => t.undo);
      if (!last) return;
      e.preventDefault();
      last.undo!();
      dismiss(last.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toasts, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-(--z-toast) flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cn(toastClass)} role="status">
            <span
              className={cn("mt-1.5 size-2 shrink-0 rounded-full",
                t.tone === "success" ? "bg-success"
                  : t.tone === "warning" ? "bg-warning"
                  : t.tone === "danger" ? "bg-danger"
                  : "bg-ink-tertiary")}
              aria-hidden
            />
            <div className="min-w-0 flex-1 text-base text-ink">{t.title}</div>
            {t.undo && (
              <Button variant="ghost" size="sm" onClick={() => { t.undo!(); dismiss(t.id); }}>Undo</Button>
            )}
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 text-ink-tertiary hover:text-ink">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
