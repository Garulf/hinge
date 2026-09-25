import { expect, test } from "vitest";
import { place } from "../../src/renderer/chrome/dom";

function countingNode() {
  const writes: string[] = [];
  const style = {} as Record<string, string>;
  for (const prop of ["left", "top", "width"]) {
    let value = "";
    Object.defineProperty(style, prop, {
      get: () => value,
      set: (v: string) => {
        value = v;
        writes.push(`${prop}=${v}`);
      },
    });
  }
  return { node: { style } as unknown as HTMLElement, writes };
}

test("place writes a node's position only when the rounded position actually changes", () => {
  const { node, writes } = countingNode();
  place(node, { x: 10.2, y: 20, w: 100 });
  expect(writes).toEqual(["left=10px", "top=20px", "width=100px"]);
  place(node, { x: 10.4, y: 20, w: 100 });
  expect(writes).toHaveLength(3);
  place(node, { x: 11, y: 20, w: 100 });
  expect(writes.slice(3)).toEqual(["left=11px"]);
  place(node, { x: 11, y: 20 });
  expect(writes).toHaveLength(4);
});
