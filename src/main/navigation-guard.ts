export interface GuardedContents {
  on(event: "will-navigate", fn: (e: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(fn: () => { action: "deny" }): void;
}

/** A hinge page holds a live control port, so nothing (a dropped file, a link) may replace it with another page or open one. */
export function guardNavigation(contents: GuardedContents): void {
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
