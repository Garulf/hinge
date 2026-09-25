import { expect, test } from "vitest";
import { wrapText } from "../../src/renderer/wrap-text";

function charWidth(width: number): (s: string) => number {
  return (s) => s.length * width;
}

test("keeps short text on a single line", () => {
  expect(wrapText(charWidth(1), "Connect your phone", 100)).toEqual(["Connect your phone"]);
});

test("wraps at word boundaries once the running line would exceed maxWidth", () => {
  const lines = wrapText(charWidth(5), "one two three four five", 55);
  expect(lines).toEqual(["one two", "three four", "five"]);
});

test("never drops a single word longer than maxWidth", () => {
  expect(wrapText(charWidth(10), "supercalifragilisticexpialidocious", 50)).toEqual(["supercalifragilisticexpialidocious"]);
});

test("reassembles to the original words in order", () => {
  const text = "Lost connection to the adb server, reconnecting in 4s";
  const lines = wrapText(charWidth(8), text, 120);
  expect(lines.join(" ")).toBe(text);
});

test("empty text produces one empty line", () => {
  expect(wrapText(charWidth(1), "", 100)).toEqual([""]);
});
