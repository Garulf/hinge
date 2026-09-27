import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppShell, SHOW_MAIN_WITHOUT_POPOUT_MS } from "../../src/main/app-shell";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function harness(startHidden: boolean, openResult: "opened" | "queued" = "queued") {
  const calls: string[] = [];
  const notices: string[] = [];
  const companion: boolean[] = [];
  const opened: string[] = [];
  let count = 0;
  const countListeners: ((n: number) => void)[] = [];
  const shell = new AppShell(
    {
      showWindow: () => calls.push("show"),
      hideWindow: () => calls.push("hide"),
      setMainVideo: (on) => calls.push(`video ${on}`),
      companionWanted: (on) => companion.push(on),
      popouts: {
        count: () => count,
        open: (pkg) => {
          opened.push(pkg);
          return openResult;
        },
        onCountChanged: (cb) => countListeners.push(cb),
      },
      quit: () => calls.push("quit"),
      notice: (text) => notices.push(text),
      log: () => {},
    },
    { startHidden },
  );
  const setCount = (n: number) => {
    count = n;
    for (const cb of countListeners) cb(n);
  };
  return { shell, calls, companion, opened, setCount, notices };
}

test("the companion is wanted as soon as the shell starts with the main window shown, without waiting for a show event", () => {
  const { shell, companion } = harness(false);

  shell.start();

  expect(companion.at(-1)).toBe(true);
});

test("with the main window hidden at launch the companion waits for a pop-out", () => {
  const { shell, companion, setCount } = harness(true);
  shell.start();
  expect(companion.at(-1)).toBe(false);

  setCount(1);

  expect(companion.at(-1)).toBe(true);
});

test("closing the main window with a pop-out open hides it and turns its video off, and the companion stays", () => {
  const { shell, calls, companion, setCount } = harness(false);
  shell.start();
  setCount(1);
  calls.length = 0;

  expect(shell.closeRequested()).toBe("hide");

  expect(calls).toEqual(["hide", "video false"]);
  expect(shell.mainVisible).toBe(false);
  expect(companion.at(-1)).toBe(true);
});

test("closing the main window with no pop-outs quits and hides nothing", () => {
  const { shell, calls } = harness(false);
  shell.start();

  expect(shell.closeRequested()).toBe("quit");
  expect(calls).toEqual([]);
});

test("the last pop-out closing quits only while the main window is hidden", () => {
  const shown = harness(false);
  shown.shell.start();
  shown.setCount(1);
  shown.setCount(0);
  expect(shown.calls).not.toContain("quit");

  const hidden = harness(true);
  hidden.shell.start();
  hidden.setCount(1);
  hidden.setCount(0);
  expect(hidden.calls).toContain("quit");
});

test("every way back to the main window shows it, turns its video on and counts it as shown", () => {
  const { shell, calls, setCount } = harness(true);
  shell.start();
  setCount(1);

  shell.showMain();
  expect(calls).toEqual(["show", "video true"]);
  expect(shell.mainVisible).toBe(true);

  setCount(0);
  expect(calls).not.toContain("quit");
});

test("a second launch with an app opens it, and without one shows the main window", () => {
  const { shell, calls, opened } = harness(true);
  shell.start();

  shell.launch("com.example.chat");
  expect(opened).toEqual(["com.example.chat"]);
  expect(calls).toEqual([]);

  shell.launch(null);
  expect(calls).toEqual(["show", "video true"]);
});

test("an --app launch still waiting for its pop-out after 5 s shows the main window", async () => {
  const { shell, calls } = harness(true);
  shell.start();

  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS - 1);
  expect(calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);

  expect(SHOW_MAIN_WITHOUT_POPOUT_MS).toBe(5000);
  expect(calls).toEqual(["show", "video true"]);
});

test("an --app launch whose pop-out opened in time keeps the main window hidden", async () => {
  const { shell, calls, setCount } = harness(true);
  shell.start();
  setCount(1);

  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS);

  expect(calls).toEqual([]);
});

test("a pop-out opening after the main window was shown for it leaves the main window shown", async () => {
  const { shell, calls, setCount } = harness(true);
  shell.start();
  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS);
  calls.length = 0;

  setCount(1);

  expect(calls).toEqual([]);
  expect(shell.mainVisible).toBe(true);
});

test("a normal launch never schedules the fallback show", async () => {
  const { shell, calls } = harness(false);
  shell.start();

  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS * 2);

  expect(calls).toEqual([]);
});

test("an --app pop-out that opens and closes before 5 s quits hinge and never brings the main window up", async () => {
  const { shell, calls, setCount } = harness(true);
  shell.start();
  setCount(1);
  setCount(0);

  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS);

  expect(calls).toEqual(["quit"]);
});

test("quitting before an --app launch's 5 s are up never brings the main window up", async () => {
  const { shell, calls } = harness(true);
  shell.start();

  shell.quitting();
  await vi.advanceTimersByTimeAsync(SHOW_MAIN_WITHOUT_POPOUT_MS * 2);

  expect(calls).toEqual([]);
});

test("a second launch whose app waits for the phone says so", () => {
  const { shell, notices } = harness(true, "queued");
  shell.start();

  shell.launch("com.example.chat");
  expect(notices).toEqual(["Waiting for the phone to open com.example.chat"]);
});

test("a second launch whose app opens at once needs no notice", () => {
  const { shell, notices } = harness(true, "opened");
  shell.start();

  shell.launch("com.example.chat");
  expect(notices).toEqual([]);
});

test("a launch asking for something that is not an app package opens nothing and shows the main window with a notice", () => {
  const { shell, calls, opened, notices } = harness(true);
  shell.start();

  shell.launch("x;reboot");
  expect(opened).toEqual([]);
  expect(calls).toEqual(["show", "video true"]);
  expect(notices).toEqual(["Not an app package: x;reboot"]);
});
