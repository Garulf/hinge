import { expect, test } from "vitest";
import { guardNavigation } from "../../src/main/navigation-guard";

test("a hinge page can neither navigate away nor open new windows", () => {
  const handlers = new Map<string, (e: { preventDefault(): void }) => void>();
  let openHandler: (() => { action: string }) | null = null;
  guardNavigation({
    on: (event: string, fn: (e: { preventDefault(): void }) => void) => handlers.set(event, fn),
    setWindowOpenHandler: (fn: () => { action: "deny" }) => {
      openHandler = fn;
    },
  });

  let prevented = false;
  handlers.get("will-navigate")!({ preventDefault: () => (prevented = true) });

  expect(prevented).toBe(true);
  expect(openHandler!()).toEqual({ action: "deny" });
});
