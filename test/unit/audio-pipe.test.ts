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

test("a decoded chunk is converted to planar Float32Arrays, one per channel, and fed to the player unconditionally (the buffer policy lives in the player)", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory });
  pipe.start(INFO);

  decoder.emit(fakeDecoded(20, 48000, 2));

  expect(player.fed).toHaveLength(1);
  expect(player.fed[0]).toHaveLength(2);
  expect(player.fed[0][0]).toBeInstanceOf(Float32Array);
  expect(player.fed[0][0].length).toBe(960); // 20ms @ 48kHz
});

test("every decoded chunk reaches the player even under a burst: this pipe never throttles or drops (that is the player's job)", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory });
  pipe.start(INFO);

  for (let i = 0; i < 40; i++) decoder.emit(fakeDecoded(20, 48000, 2));

  expect(player.fed.length).toBe(40);
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

test("end() stops the player and decoder, and start() on a new stream creates a fresh player and decoder", () => {
  const decoder = fakeDecoderFactory();
  const player = fakePlayer();
  const pipe = new AudioPipe({ createDecoder: decoder.factory, createPlayer: player.factory });
  pipe.start(INFO);
  decoder.emit(fakeDecoded(100, 48000, 2));
  expect(player.fed).toHaveLength(1);

  pipe.end();
  expect(player.stopped()).toBe(1);

  pipe.start(INFO);
  expect(player.calls).toHaveLength(2);
});
