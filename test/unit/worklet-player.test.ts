import { afterEach, expect, test, vi } from "vitest";
import { createWorkletPlayer } from "../../src/renderer/audio/worklet-player";

interface FakeAudioContext {
  audioWorklet: { addModule: (url: string) => Promise<void> };
  destination: object;
  close: () => Promise<void>;
  closeCalls: number;
}

function installFakeAudio(opts?: { gateAddModule?: boolean }): {
  contexts: FakeAudioContext[];
  nodes: { disconnectCalls: number; port: { postMessage: (m: unknown) => void; messages: unknown[] } }[];
  resolveAddModule: () => void;
} {
  const contexts: FakeAudioContext[] = [];
  const nodes: { disconnectCalls: number; port: { postMessage: (m: unknown) => void; messages: unknown[] } }[] = [];
  let resolveAddModule: () => void = () => {};
  const addModuleGate = opts?.gateAddModule
    ? new Promise<void>((resolve) => {
        resolveAddModule = resolve;
      })
    : Promise.resolve();

  class TestAudioContext {
    audioWorklet = { addModule: () => addModuleGate };
    destination = {};
    closeCalls = 0;
    constructor() {
      contexts.push(this as unknown as FakeAudioContext);
    }
    close(): Promise<void> {
      this.closeCalls++;
      return Promise.resolve();
    }
  }

  class TestAudioWorkletNode {
    disconnectCalls = 0;
    port = { messages: [] as unknown[], postMessage: (m: unknown) => nodes.at(-1)?.port.messages.push(m) };
    constructor() {
      nodes.push(this as unknown as (typeof nodes)[number]);
    }
    connect(): void {}
    disconnect(): void {
      this.disconnectCalls++;
    }
  }

  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("AudioWorkletNode", TestAudioWorkletNode);

  return { contexts, nodes, resolveAddModule: () => resolveAddModule() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("stop() called while start()'s addModule() is still pending closes the context instead of leaking it", async () => {
  const { contexts, nodes, resolveAddModule } = installFakeAudio({ gateAddModule: true });
  const player = createWorkletPlayer(48000, 2);

  const startPromise = player.start();
  expect(contexts).toHaveLength(1);
  expect(contexts[0].closeCalls).toBe(0);

  player.stop();
  resolveAddModule();
  await startPromise;

  expect(contexts[0].closeCalls).toBe(1);
  expect(nodes).toHaveLength(0); // never got far enough to create the worklet node
});

test("a normal start() then stop() still closes the context exactly once", async () => {
  const { contexts, nodes } = installFakeAudio();
  const player = createWorkletPlayer(48000, 2);

  await player.start();
  expect(contexts[0].closeCalls).toBe(0);

  player.stop();
  await Promise.resolve();

  expect(contexts[0].closeCalls).toBe(1);
  expect(nodes[0].disconnectCalls).toBe(1);
});

test("start() after a stop()-during-start() works normally: the stale stopped flag does not leak into the next start()", async () => {
  const { contexts, resolveAddModule } = installFakeAudio({ gateAddModule: true });
  const player = createWorkletPlayer(48000, 2);

  const first = player.start();
  player.stop();
  resolveAddModule();
  await first;
  expect(contexts[0].closeCalls).toBe(1);

  const { contexts: contexts2, nodes: nodes2 } = installFakeAudio();
  await player.start();
  expect(contexts2[0].closeCalls).toBe(0);
  expect(nodes2).toHaveLength(1);
});
