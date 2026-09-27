import { expect, test } from "vitest";
import { afterPopoutClosed, onMainWindowClose } from "../../src/main/lifecycle";

test("closing the main window hides it while pop-outs are open, and quits otherwise", () => {
  expect(onMainWindowClose({ popouts: 0 })).toBe("quit");
  expect(onMainWindowClose({ popouts: 1 })).toBe("hide");
});

test("the last pop-out closing quits only when the main window is hidden", () => {
  expect(afterPopoutClosed({ mainVisible: false, popouts: 0 })).toBe("quit");
  expect(afterPopoutClosed({ mainVisible: false, popouts: 1 })).toBe("stay");
  expect(afterPopoutClosed({ mainVisible: true, popouts: 0 })).toBe("stay");
  expect(afterPopoutClosed({ mainVisible: true, popouts: 1 })).toBe("stay");
});
