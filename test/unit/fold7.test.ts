import { expect, test } from "vitest";
import { classifyScreen } from "../../src/shared/fold7";

test("cover portrait, cover landscape, inner portrait, inner landscape", () => {
  expect(classifyScreen(1080, 2520, null)).toEqual({ screen: "cover", rotated: false });
  expect(classifyScreen(2520, 1080, null)).toEqual({ screen: "cover", rotated: true });
  expect(classifyScreen(1968, 2184, null)).toEqual({ screen: "inner", rotated: false });
  expect(classifyScreen(2184, 1968, null)).toEqual({ screen: "inner", rotated: true });
});

test("scaled streams classify by aspect, not absolute size", () => {
  expect(classifyScreen(544, 1264, null).screen).toBe("cover");
  expect(classifyScreen(984, 1092, null).screen).toBe("inner");
});

test("ambiguous aspect keeps the previous screen kind", () => {
  expect(classifyScreen(1000, 1450, { screen: "inner", rotated: false }).screen).toBe("inner");
  expect(classifyScreen(1000, 1450, { screen: "cover", rotated: false }).screen).toBe("cover");
  expect(classifyScreen(1000, 1450, null).screen).toBe("inner");
});
