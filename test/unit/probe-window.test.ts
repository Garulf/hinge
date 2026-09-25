import { expect, test } from "vitest";
import { recordProgressHtml, recordResultHtml } from "../../src/main/probe-window";

test("the progress pre element wraps long lines instead of overflowing the fixed-width window", () => {
  expect(recordProgressHtml()).toMatch(/<pre id="t" style="white-space:pre-wrap">/);
});

test("the result page shows the log path when given one", () => {
  const html = recordResultHtml("/home/user/Desktop/hinge-probe.json", "/home/user/.config/hinge/logs/hinge.log");
  expect(html).toContain("/home/user/Desktop/hinge-probe.json");
  expect(html).toContain("/home/user/.config/hinge/logs/hinge.log");
});

test("the result page omits the log block when no log path is given", () => {
  const html = recordResultHtml("/home/user/Desktop/hinge-probe.json");
  expect(html).not.toContain("Log:");
});
