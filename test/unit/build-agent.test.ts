import { expect, test } from "vitest";
import { TARGETS, javacArgs, d8Args } from "../../scripts/build-agent.mjs";

test("fetches exactly two sdk archives", () => {
  expect(TARGETS).toHaveLength(2);
});

test.each(TARGETS.map((t) => [t.file, t]))("%s is pinned to an https dl.google.com url and a sha1", (_file, target) => {
  expect(new URL(target.url).protocol).toBe("https:");
  expect(new URL(target.url).hostname).toBe("dl.google.com");
  expect(target.algo).toBe("sha1");
  expect(target.sum).toMatch(/^[0-9a-f]{40}$/);
});

test("keeps d8.jar from build-tools and android.jar from the platform", () => {
  expect(TARGETS.map((t) => t.keep)).toEqual([["d8.jar"], ["android.jar"]]);
});

test("javac compiles for release 11 against android.jar into the classes dir", () => {
  const args = javacArgs({
    androidJar: "sdk/android.jar",
    classesDir: "agent/build/classes",
    sources: ["agent/src/net/garulf/hinge/Agent.java", "agent/src/net/garulf/hinge/SystemContext.java"],
  });
  expect(args).toEqual([
    "--release",
    "11",
    "-cp",
    "sdk/android.jar",
    "-d",
    "agent/build/classes",
    "agent/src/net/garulf/hinge/Agent.java",
    "agent/src/net/garulf/hinge/SystemContext.java",
  ]);
});

test("d8 runs from its jar with java and dexes the classes into the output jar", () => {
  const args = d8Args({
    d8Jar: "sdk/d8.jar",
    androidJar: "sdk/android.jar",
    outputJar: "vendor/hinge-agent.jar",
    classFiles: ["agent/build/classes/net/garulf/hinge/Agent.class", "agent/build/classes/net/garulf/hinge/SystemContext.class"],
  });
  expect(args).toEqual([
    "-cp",
    "sdk/d8.jar",
    "com.android.tools.r8.D8",
    "--release",
    "--min-api",
    "30",
    "--lib",
    "sdk/android.jar",
    "--output",
    "vendor/hinge-agent.jar",
    "agent/build/classes/net/garulf/hinge/Agent.class",
    "agent/build/classes/net/garulf/hinge/SystemContext.class",
  ]);
});
