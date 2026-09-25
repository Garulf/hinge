import { expect, test } from "vitest";
import { AudioPipe, type AudioDecoderFactory, type AudioDecoderHandle, type DecodedAudioLike, type PcmPlayerFactory, type PcmPlayerLike } from "../../src/renderer/audio-pipe";
import type { AudioStreamInfo, WireAudioPacket } from "../../src/shared/wire";

function fakeDecoded(durationMs: number, sampleRate: number, channels: number): DecodedAudioLike {
  const numberOfFrames = Math.round((durationMs / 1000) * sampleRate);
  return {
    numberOfFrames,
    numberOfChannels: channels,
    sampleRate,
    copyTo: (dest) => dest.fill(0),
    close: () => {},
  };
}

function fakeDecoderFactory(): { factory: AudioDecoderFactory; configs: unknown[]; decodes: unknown[]; emit: (data: DecodedAudioLike) => void; fail: (e: Error) => void } {
  const configs: unknown[] = [];
  const decodes: unknown[] = [];
  let output!: (data: DecodedAudioLike) => void;
  let onError!: (e: Error) => void;
  const factory: AudioDecoderFactory = (options) => {
    configs.push({ codec: options.codec, sampleRate: options.sampleRate, numberOfChannels: options.numberOfChannels });
    output = options.output;
    onError = options.error;
    const handle: AudioDecoderHandle = {
      decode: (chunk) => decodes.push(chunk),
      close: () => {},
    };
    return handle;
  };
  return { factory, configs, decodes, emit: (data) => output(data), fail: (e) => onError(e) };
}

interface FakePlayerHandle {
  factory: PcmPlayerFactory;
  fed: Float32Array[][];
  calls: [number, number][];
  stopped: () => number;
}

function fakePlayer(): FakePlayerHandle {
  const fed: Float32Array[][] = [];
  const calls: [number, number][] = [];
  let stopped = 0;
  const factory: PcmPlayerFactory = (sampleRate, channelCount) => {
    calls.push([sampleRate, channelCount]);
    const player: PcmPlayerLike = {
      start: async () => {},
      feed: (planes) => fed.push(planes),
      stop: () => {
        stopped++;
      },
    };
    return player;
  };
  return { factory, fed, calls, stopped: () => stopped };
}

const INFO: AudioStreamInfo = { codec: "opus", sampleRate: 48000, channels: 2 };

test("start() configures the decoder and creates the player from the stream's own metadata, not hardcoded values", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory });

  pipe.start({ codec: "opus", sampleRate: 24000, channels: 1 });

  expect(decoder.configs).toEqual([{ codec: "opus", sampleRate: 24000, numberOfChannels: 1 }]);
  expect(player.calls).toEqual([[24000, 1]]);
});

test("push() decodes data packets and skips configuration packets", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory });
  pipe.start(INFO);

  const configPacket: WireAudioPacket = { type: "configuration", data: new Uint8Array([1]) };
  const dataPacket: WireAudioPacket = { type: "data", pts: 123, data: new Uint8Array([2, 3]) };
  pipe.push(configPacket);
  pipe.push(dataPacket);

  expect(decoder.decodes).toEqual([{ timestamp: 123, data: new Uint8Array([2, 3]) }]);
});

test("a decoded chunk is converted to planar Float32Arrays, one per channel, and fed to the player", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory, now: () => 0 });
  pipe.start(INFO);

  decoder.emit(fakeDecoded(20, 48000, 2));

  expect(player.fed).toHaveLength(1);
  expect(player.fed[0]).toHaveLength(2);
  expect(player.fed[0][0]).toBeInstanceOf(Float32Array);
  expect(player.fed[0][0].length).toBe(960); // 20ms @ 48kHz
});

test("buffer policy: feeding audio far faster than it can be playing never lets the estimated buffer exceed 120ms", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  let clock = 0;
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory, now: () => clock });
  pipe.start(INFO);

  // A burst: 40 chunks of 20ms each (800ms of audio) arriving back-to-back
  // while the fake clock barely advances, simulating decode/receipt far
  // outpacing real-time playback.
  for (let i = 0; i < 40; i++) {
    decoder.emit(fakeDecoded(20, 48000, 2));
    expect(pipe.bufferedMs()).toBeLessThanOrEqual(120);
    clock += 1; // a little wall-clock time passes between arrivals, not enough to drain 20ms
  }

  expect(player.fed.length).toBe(40); // every chunk still reaches the player; only our own backlog accounting drops
});

test("buffer policy: once real time catches up, the estimated buffer drains back toward the target instead of staying pinned high", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  let clock = 0;
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory, now: () => clock });
  pipe.start(INFO);

  for (let i = 0; i < 10; i++) decoder.emit(fakeDecoded(20, 48000, 2)); // 200ms decoded instantly at clock=0
  expect(pipe.bufferedMs()).toBeLessThanOrEqual(120);

  clock += 200; // real time catches all the way up
  expect(pipe.bufferedMs()).toBe(0);
});

test("a decode error turns audio off (further push()es are ignored) and reports exactly one error", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const errors: string[] = [];
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory, onError: (m) => errors.push(m) });
  pipe.start(INFO);

  decoder.fail(new Error("codec panic"));
  decoder.fail(new Error("a second failure, e.g. a late callback"));
  pipe.push({ type: "data", pts: 1, data: new Uint8Array([1]) });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("codec panic");
  expect(decoder.decodes).toEqual([]);
  expect(player.stopped()).toBe(1);
});

test("end() stops the player and decoder and start() on a new stream resets the buffer clock", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  let clock = 0;
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory, now: () => clock });
  pipe.start(INFO);
  decoder.emit(fakeDecoded(100, 48000, 2));
  expect(pipe.bufferedMs()).toBeGreaterThan(0);

  pipe.end();
  expect(player.stopped()).toBe(1);
  expect(pipe.bufferedMs()).toBe(0);

  clock = 1000;
  pipe.start(INFO);
  expect(pipe.bufferedMs()).toBe(0);
});
