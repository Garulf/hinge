import { wrapText } from "./wrap-text";

/** Dims the whole canvas and writes the status text, wrapped and centred, over it. */
export function paintStatus(ctx: CanvasRenderingContext2D, text: string, width: number, height: number): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = Math.max(12, Math.round(height * 0.05));
  ctx.font = `bold ${fontSize}px sans-serif`;
  const maxWidth = width * 0.85;
  const lines = wrapText((s) => ctx.measureText(s).width, text, maxWidth);
  const lineHeight = fontSize * 1.3;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], width / 2, startY + i * lineHeight, maxWidth);
}
