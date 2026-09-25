import { expect, test } from "vitest";
import { buildInit, DEFAULT_STREAM_SETTINGS } from "../../src/main/scrcpy-init";

test("first attempt uses the chosen codec with encoder constraints respected", () => {
  const init = buildInit({ ...DEFAULT_STREAM_SETTINGS, videoCodec: "h265" }, 0);
  expect(init).toMatchObject({ video: true, control: true, videoCodec: "h265", ignoreVideoEncoderConstraints: false, clipboardAutosync: true, sendFrameMeta: true });
});

test("forwards, rather than reverses, the tunnel so no firewall prompt appears on Windows", () => {
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0)).toMatchObject({ tunnelForward: true });
});

test("retry ladder: ignore constraints, then fall back to h264", () => {
  expect(buildInit({ ...DEFAULT_STREAM_SETTINGS, videoCodec: "h265" }, 1)).toMatchObject({ videoCodec: "h265", ignoreVideoEncoderConstraints: true });
  expect(buildInit({ ...DEFAULT_STREAM_SETTINGS, videoCodec: "h265" }, 2)).toMatchObject({ videoCodec: "h264", ignoreVideoEncoderConstraints: true });
});

test("zero max size and fps are passed through as unlimited", () => {
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0)).toMatchObject({ maxSize: 0, maxFps: 0 });
});

test("audio is on by default, and off follows the setting", () => {
  expect(DEFAULT_STREAM_SETTINGS.audio).toBe(true);
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0)).toMatchObject({ audio: true });
  expect(buildInit({ ...DEFAULT_STREAM_SETTINGS, audio: false }, 0)).toMatchObject({ audio: false });
});
