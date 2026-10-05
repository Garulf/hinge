import type { Box, Circle, UnlockLayout } from "./unlock-layout";
import type { UnlockView } from "./unlock-model";

export const SHAKE_MS = 400;
const BACKGROUND = "rgba(12, 12, 14, 0.97)";
const TEXT = "#f2f2f2";
const DIM = "rgba(242, 242, 242, 0.55)";
const KEY = "rgba(255, 255, 255, 0.08)";
const KEY_PRESSED = "rgba(255, 255, 255, 0.24)";
const ACCENT = "#5e9eff";
const ERROR = "#ff6b6b";
const FONT = '"SamsungOne", "Roboto", "Segoe UI", sans-serif';

export function shakeOffset(shakeSince: number | null, now: number, scale: number): number {
  if (shakeSince === null) return 0;
  const t = now - shakeSince;
  if (t < 0 || t >= SHAKE_MS) return 0;
  return Math.sin((t / SHAKE_MS) * Math.PI * 6) * (1 - t / SHAKE_MS) * 12 * scale;
}

/** Whether the pad changes with time alone (the spinner, a shake), so it must be redrawn every frame. */
export function animating(view: UnlockView, now: number): boolean {
  return view.busy || (view.shakeSince !== null && now - view.shakeSince < SHAKE_MS);
}

export function paintUnlock(ctx: CanvasRenderingContext2D, view: UnlockView, layout: UnlockLayout, size: { w: number; h: number }, now: number): void {
  const { w, h } = size;
  const s = layout.scale;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawLock(ctx, layout.icon, s);
  ctx.font = `${layout.promptSize}px ${FONT}`;
  ctx.fillStyle = view.error ? ERROR : TEXT;
  ctx.fillText(view.prompt, w / 2, layout.promptY, w * 0.9);
  if (view.hint) {
    ctx.font = `${layout.hint.size}px ${FONT}`;
    ctx.fillStyle = DIM;
    ctx.fillText(view.hint, w / 2, layout.hint.y, w * 0.9);
  }
  if (view.mode !== "pattern") drawEntry(ctx, view, layout.entry, shakeOffset(view.shakeSince, now, s), s, now);
  for (const { id, circle } of layout.keys) {
    ctx.fillStyle = view.pressed === id ? KEY_PRESSED : KEY;
    ctx.beginPath();
    ctx.arc(circle.cx, circle.cy, circle.r, 0, Math.PI * 2);
    ctx.fill();
    if (id === "back") drawBackspace(ctx, circle, s);
    else {
      ctx.fillStyle = id === "ok" ? (view.okEnabled ? ACCENT : DIM) : TEXT;
      ctx.font = id === "ok" ? `bold ${18 * s}px ${FONT}` : `${28 * s}px ${FONT}`;
      ctx.fillText(id === "ok" ? "OK" : id, circle.cx, circle.cy);
    }
  }
  if (layout.switchLink && view.switchLabel) drawLink(ctx, view.switchLabel, layout.switchLink, view.pressed === "switch", ACCENT, s);
  drawLink(ctx, "Cancel", layout.cancel, view.pressed === "cancel", TEXT, s);
}

function drawEntry(ctx: CanvasRenderingContext2D, view: UnlockView, box: Box, dx: number, s: number, now: number): void {
  const cx = box.x + box.w / 2 + dx;
  const cy = box.y + box.h / 2;
  if (view.busy) {
    const start = ((now / 1000) * Math.PI * 2.4) % (Math.PI * 2);
    ctx.strokeStyle = TEXT;
    ctx.lineWidth = 2.5 * s;
    ctx.beginPath();
    ctx.arc(cx, cy, 11 * s, start, start + Math.PI * 1.5);
    ctx.stroke();
    return;
  }
  if (view.mode === "password") {
    ctx.strokeStyle = view.error ? ERROR : DIM;
    ctx.lineWidth = 1.5 * s;
    ctx.strokeRect(box.x + dx, box.y, box.w, box.h);
    ctx.textAlign = "left";
    ctx.fillStyle = TEXT;
    ctx.font = `${20 * s}px ${FONT}`;
    const bullets = "•".repeat(view.entered);
    const left = box.x + 12 * s + dx;
    if (bullets) ctx.fillText(bullets, left, cy, box.w - 24 * s);
    const caretX = Math.min(left + ctx.measureText(bullets).width + 2 * s, box.x + box.w - 10 * s + dx);
    ctx.fillRect(caretX, cy - 10 * s, 1.5 * s, 20 * s);
    ctx.textAlign = "center";
    return;
  }
  ctx.strokeStyle = view.error ? ERROR : DIM;
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(box.x + dx, box.y + box.h);
  ctx.lineTo(box.x + box.w + dx, box.y + box.h);
  ctx.stroke();
  const gap = 22 * s;
  const first = cx - ((view.entered - 1) * gap) / 2;
  ctx.fillStyle = TEXT;
  for (let i = 0; i < view.entered; i++) {
    ctx.beginPath();
    ctx.arc(first + i * gap, cy, 6 * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLock(ctx: CanvasRenderingContext2D, icon: Circle, s: number): void {
  const { cx, cy, r } = icon;
  ctx.strokeStyle = TEXT;
  ctx.fillStyle = TEXT;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.2, r * 0.55, Math.PI, 0);
  ctx.stroke();
  ctx.fillRect(cx - r * 0.85, cy - r * 0.2, r * 1.7, r * 1.2);
}

function drawBackspace(ctx: CanvasRenderingContext2D, key: Circle, s: number): void {
  const r = key.r * 0.42;
  const { cx, cy } = key;
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx - r * 0.4, cy - r * 0.65);
  ctx.lineTo(cx + r, cy - r * 0.65);
  ctx.lineTo(cx + r, cy + r * 0.65);
  ctx.lineTo(cx - r * 0.4, cy + r * 0.65);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.05, cy - r * 0.3);
  ctx.lineTo(cx + r * 0.55, cy + r * 0.3);
  ctx.moveTo(cx + r * 0.55, cy - r * 0.3);
  ctx.lineTo(cx - r * 0.05, cy + r * 0.3);
  ctx.stroke();
}

function drawLink(ctx: CanvasRenderingContext2D, label: string, box: Box, pressed: boolean, colour: string, s: number): void {
  if (pressed) {
    ctx.fillStyle = KEY_PRESSED;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.fillStyle = colour;
  ctx.font = `${16 * s}px ${FONT}`;
  ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2, box.w);
}
