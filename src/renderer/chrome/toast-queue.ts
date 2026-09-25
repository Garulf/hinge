export type ToastTone = "info" | "error";

export interface ToastInput {
  /** A toast shown again with the same id replaces the old one in place, e.g. a transfer's progress. */
  id?: string;
  text: string;
  tone?: ToastTone;
  /** 0..1 draws a progress bar. */
  progress?: number;
  /** Stays until updated or dismissed, e.g. while a transfer is still running. */
  sticky?: boolean;
}

export interface Toast {
  id: string;
  text: string;
  tone: ToastTone;
  progress: number | null;
  expiresAtMs: number | null;
}

export const TOAST_LIFE_MS = 3000;
const MAX_TOASTS = 4;

/** The toasts on screen, oldest first; each lasts three seconds from its latest update unless sticky. */
export class ToastQueue {
  #toasts: Toast[] = [];
  #nextId = 0;

  show(input: ToastInput, nowMs: number): string {
    const id = input.id ?? `toast-${++this.#nextId}`;
    const toast: Toast = {
      id,
      text: input.text,
      tone: input.tone ?? "info",
      progress: input.progress ?? null,
      expiresAtMs: input.sticky ? null : nowMs + TOAST_LIFE_MS,
    };
    const index = this.#toasts.findIndex((t) => t.id === id);
    if (index >= 0) this.#toasts[index] = toast;
    else this.#toasts.push(toast);
    this.#trim();
    return id;
  }

  dismiss(id: string): void {
    this.#toasts = this.#toasts.filter((t) => t.id !== id);
  }

  visible(nowMs: number): Toast[] {
    this.#toasts = this.#toasts.filter((t) => t.expiresAtMs === null || t.expiresAtMs > nowMs);
    return [...this.#toasts];
  }

  /** When the next toast runs out, so the view knows when to redraw; null when nothing will expire. */
  nextExpiryMs(): number | null {
    const times = this.#toasts.map((t) => t.expiresAtMs).filter((t): t is number => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** Too many at once drops the oldest non-sticky toast first. */
  #trim(): void {
    while (this.#toasts.length > MAX_TOASTS) {
      const index = this.#toasts.findIndex((t) => t.expiresAtMs !== null);
      this.#toasts.splice(index >= 0 ? index : 0, 1);
    }
  }
}
