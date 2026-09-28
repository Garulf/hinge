import { expect, test } from "vitest";
import { buildCompanionInit, buildInit, DEFAULT_STREAM_SETTINGS, toStreamSettings, type SessionRole } from "../../src/main/scrcpy-init";
import { DEFAULT_SETTINGS } from "../../src/main/settings";

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

test("toStreamSettings maps the persisted settings' codec/bitrate/size/fps/audio into StreamSettings, not the coded defaults", () => {
  const custom = { ...DEFAULT_SETTINGS, videoCodec: "h265" as const, videoBitRate: 4_000_000, maxSize: 1280, maxFps: 30, audio: false };
  expect(toStreamSettings(custom)).toEqual({ videoCodec: "h265", videoBitRate: 4_000_000, maxSize: 1280, maxFps: 30, audio: false });
});

test("toStreamSettings on the default settings matches DEFAULT_STREAM_SETTINGS", () => {
  expect(toStreamSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_STREAM_SETTINGS);
});

const POPOUT: SessionRole = { kind: "popout", pkg: "com.example.app", geometry: { width: 400, height: 856, dpi: 160 } };

test("a pop-out session asks for a new display sized to its window and leaves audio, clipboard and the main screen alone", () => {
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0, POPOUT)).toMatchObject({
    video: true,
    control: true,
    newDisplay: "400x856/160",
    audio: false,
    clipboardAutosync: false,
    maxSize: 0,
    vdSystemDecorations: false,
    vdDestroyContent: false,
    displayImePolicy: "hide",
    powerOn: false,
  });
});

test("a pop-out display is a flex display, because the server throws on a resize of any other and takes the session down with it", () => {
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0, POPOUT)).toMatchObject({ flexDisplay: true });
});

test("a pop-out session keeps the user's codec, bitrate and fps and the retry ladder", () => {
  const settings = { ...DEFAULT_STREAM_SETTINGS, videoCodec: "h265" as const, videoBitRate: 4_000_000, maxSize: 1280, maxFps: 30 };
  expect(buildInit(settings, 0, POPOUT)).toMatchObject({ videoCodec: "h265", videoBitRate: 4_000_000, maxFps: 30, maxSize: 0, ignoreVideoEncoderConstraints: false });
  expect(buildInit(settings, 1, POPOUT)).toMatchObject({ videoCodec: "h265", ignoreVideoEncoderConstraints: true });
  expect(buildInit(settings, 2, POPOUT)).toMatchObject({ videoCodec: "h264", ignoreVideoEncoderConstraints: true });
});

test("a main session with a companion leaves audio and clipboard to it and is otherwise unchanged", () => {
  const alone = buildInit(DEFAULT_STREAM_SETTINGS, 1, { kind: "main" });
  const withCompanion = buildInit(DEFAULT_STREAM_SETTINGS, 1, { kind: "main" }, true);
  expect(withCompanion).toEqual({ ...alone, audio: false, clipboardAutosync: false });
});

test("a main session with no role given is the plain main session", () => {
  expect(buildInit(DEFAULT_STREAM_SETTINGS, 0, { kind: "main" }, false)).toEqual(buildInit(DEFAULT_STREAM_SETTINGS, 0));
});

test("the companion session carries only audio, control and the clipboard", () => {
  expect(buildCompanionInit({ ...DEFAULT_STREAM_SETTINGS, audio: false })).toEqual({
    video: false,
    audio: false,
    control: true,
    clipboardAutosync: true,
    tunnelForward: true,
    sendDeviceMeta: false,
    powerOn: false,
    stayAwake: false,
  });
  expect(buildCompanionInit(DEFAULT_STREAM_SETTINGS)).toMatchObject({ audio: true });
});
