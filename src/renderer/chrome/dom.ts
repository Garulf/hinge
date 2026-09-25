type Child = Node | string | null | undefined | false;

export interface ElementProps {
  className?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElementProps = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) {
    node.title = props.title;
    node.setAttribute("aria-label", props.title);
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [type, handler] of Object.entries(props.on ?? {})) node.addEventListener(type, handler as EventListener);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Icons are fixed markup from icons.ts, never user text, so parsing them as SVG is safe. */
export function svgIcon(markup: string): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}

const placed = new WeakMap<HTMLElement, { left: string; top: string; width: string | null }>();

/** Called every frame, so a style is only written when its rounded value changes; unchanged writes still cost the frame a style pass. */
export function place(node: HTMLElement, box: { x: number; y: number; w?: number }): void {
  const next = { left: `${Math.round(box.x)}px`, top: `${Math.round(box.y)}px`, width: box.w === undefined ? null : `${Math.round(box.w)}px` };
  const last = placed.get(node);
  placed.set(node, { ...next, width: next.width ?? last?.width ?? null });
  if (last?.left !== next.left) node.style.left = next.left;
  if (last?.top !== next.top) node.style.top = next.top;
  if (next.width !== null && last?.width !== next.width) node.style.width = next.width;
}
