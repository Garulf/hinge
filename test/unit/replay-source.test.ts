import { expect, test } from "vitest";
import { ReplaySource, type Clock } from "../../src/main/replay-source";
import type { MediaSink } from "../../src/main/media-source";
import type { PostureReading } from "../../src/shared/posture";
import type { RecordedEvent } from "../../src/shared/recording";

class FakeClock implements Clock {
  now = 0; queue: { at: number; fn: () => void }[] = [];
  setTimeout(fn: () => void, ms: number) { const e = { at: this.now + ms, fn }; this.queue.push(e); return e; }
  clearTimeout(h: unknown) { this.queue = this.queue.filter((e) => e !== h); }
  advance(ms: number) {
    this.now += ms;
    for (;;) {
      const due = this.queue.filter((e) => e.at <= this.now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((e) => e !== due);
      due.fn();
    }
  }
}

function recordingSink() {
  const calls: string[] = [];
  const sink: MediaSink = {
    videoStart: (i) => calls.push(`start ${i.width}x${i.height}`),
    videoPacket: (p) => calls.push(`packet ${p.type}`),
    videoEnd: () => calls.push("end"),
    status: (s) => calls.push(`status ${s.state}`),
    postureLine: (l) => calls.push(`posture ${l}`),
  };
  return { sink, calls };
}

const events: RecordedEvent[] = [
  { t: 0, kind: "video-start", info: { codecId: 1, width: 10, height: 20, deviceName: null } },
  { t: 0, kind: "video-packet", packet: { type: "session", width: 10, height: 20, isClientResize: false } },
  { t: 100, kind: "posture-line", line: "OPENED" },
  { t: 250, kind: "video-packet", packet: { type: "data", keyframe: true, pts: 0, data: new Uint8Array([1]) } },
];

test("replays events on their recorded schedule then ends", async () => {
  const clock = new FakeClock();
  const src = new ReplaySource("f.hrec", events, { clock });
  const { sink, calls } = recordingSink();
  await src.start(sink);
  expect(calls).toEqual(["status replay", "start 10x20", "packet session"]);
  clock.advance(100);
  expect(calls.at(-1)).toBe("posture OPENED");
  clock.advance(150);
  expect(calls.slice(-2)).toEqual(["packet data", "end"]);
});

test("stop cancels pending events", async () => {
  const clock = new FakeClock();
  const src = new ReplaySource("f.hrec", events, { clock });
  const { sink, calls } = recordingSink();
  await src.start(sink);
  await src.stop();
  clock.advance(1000);
  expect(calls).not.toContain("packet data");
});

test("control intents are recorded, not dropped", async () => {
  const src = new ReplaySource("f.hrec", events, { clock: new FakeClock() });
  src.control({ type: "text", text: "hi" });
  expect(src.controls).toEqual([{ type: "text", text: "hi" }]);
});

test("feeds recorded posture lines through a PostureStream: a states line sets the table, other lines are samples split on ' | '", async () => {
  const postureEvents: RecordedEvent[] = [
    { t: 0, kind: "video-start", info: { codecId: 1, width: 10, height: 20, deviceName: null } },
    { t: 0, kind: "posture-line", line: "@states 0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED" },
    { t: 10, kind: "posture-line", line: "3 | mRotation=0" },
    { t: 20, kind: "posture-line", line: "2 | mRotation=0" },
  ];
  const clock = new FakeClock();
  const src = new ReplaySource("f.hrec", postureEvents, { clock });
  const postures: PostureReading[] = [];
  const rawLines: string[] = [];
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: () => {},
    videoEnd: () => {},
    status: () => {},
    postureLine: (l) => rawLines.push(l),
    posture: (r) => postures.push(r),
  };
  await src.start(sink);
  clock.advance(20);

  expect(rawLines).toEqual(["@states 0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED", "3 | mRotation=0", "2 | mRotation=0"]);
  expect(postures).toEqual([
    { stateId: 3, posture: "open", rotation: 0 },
    { stateId: 2, posture: "half", rotation: 0 },
  ]);
});

test("resets the PostureStream on loop so a posture repeated at the seam is not deduped away", async () => {
  const loopEvents: RecordedEvent[] = [
    { t: 0, kind: "video-start", info: { codecId: 1, width: 10, height: 20, deviceName: null } },
    { t: 0, kind: "posture-line", line: "@states 0=CLOSED,1=TENT" },
    { t: 0, kind: "posture-line", line: "0 | mRotation=0" },
    { t: 10, kind: "posture-line", line: "1 | mRotation=0" },
    { t: 20, kind: "posture-line", line: "0 | mRotation=0" },
  ];
  const clock = new FakeClock();
  const src = new ReplaySource("f.hrec", loopEvents, { clock, loop: true });
  const postures: PostureReading[] = [];
  const sink: MediaSink = {
    videoStart: () => {},
    videoPacket: () => {},
    videoEnd: () => {},
    status: () => {},
    posture: (r) => postures.push(r),
  };
  await src.start(sink);
  clock.advance(20);

  // First pass: CLOSED, TENT, CLOSED (three distinct readings, each unlike
  // its immediate predecessor). The loop's own t=0 events fire synchronously
  // right after, as part of the same advance() call: without the reset, the
  // second pass's first reading (CLOSED again) would be deduped away since
  // it repeats where the first pass left off.
  expect(postures).toHaveLength(4);
  expect(postures.at(-1)).toEqual({ stateId: 0, posture: "closed", rotation: 0 });
});
