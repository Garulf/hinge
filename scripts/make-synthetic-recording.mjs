import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import { groupAccessUnits, splitNalUnits } from "../src/shared/annexb.ts";
import { encodeEvent, RECORDING_MAGIC } from "../src/shared/recording.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outFile = join(repoRoot, "test/fixtures/synthetic-fold.hrec");
const FFMPEG = process.env.FFMPEG ?? join(process.env.HOME ?? "", ".local/bin/ffmpeg");
const FRAME_MS = 33;
const FRAME_PTS_US = 33333;
const DEVICE_NAME = "synthetic-fold7";

const SEGMENTS = [
  { w: 544, h: 1264, secs: 2, label: "COVER" },
  { w: 984, h: 1092, secs: 2, label: "INNER" },
  { w: 1092, h: 984, secs: 1, label: "INNER LAND" },
];

const POSTURE_BETWEEN_SEGMENTS = ["synthetic: OPENED", "synthetic: ROTATION 1"];

function drawtextIsAvailable() {
  const filters = execFileSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf8" });
  return filters.includes("drawtext");
}

function renderSegment(seg, useDrawtext) {
  const args = ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${seg.w}x${seg.h}:rate=30`, "-t", String(seg.secs)];
  if (useDrawtext) {
    args.push("-vf", `drawtext=text='${seg.label}':fontsize=48:x=20:y=20:fontcolor=white:box=1:boxcolor=black`);
  }
  args.push(
    "-c:v", "libx264",
    "-profile:v", "baseline",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-bf", "0",
    "-g", "30",
    // repeat-headers=0 makes this build's raw h264 muxer drop SPS/PPS
    // entirely, even before the first keyframe, so no config packets would
    // ever be produced. The default repeats them before every keyframe,
    // matching how a real device stream behaves.
    "-x264-params", "slices=1",
    "-b:v", "400k",
    "-bsf:v", "h264_mp4toannexb",
    "-f", "h264", "-",
  );
  return execFileSync(FFMPEG, args, { maxBuffer: 64 * 1024 * 1024 });
}

function buildEvents() {
  const useDrawtext = drawtextIsAvailable();
  const events = [];
  let t = 0;
  let frameIndex = 0;

  events.push({
    t,
    kind: "video-start",
    info: { codecId: ScrcpyVideoCodecId.H264, width: SEGMENTS[0].w, height: SEGMENTS[0].h, deviceName: DEVICE_NAME },
  });

  for (let segIndex = 0; segIndex < SEGMENTS.length; segIndex++) {
    const seg = SEGMENTS[segIndex];
    console.log(`rendering segment ${seg.label} (${seg.w}x${seg.h}, ${seg.secs}s)`);
    const rawStream = renderSegment(seg, useDrawtext);
    const accessUnits = groupAccessUnits(splitNalUnits(rawStream));

    events.push({ t, kind: "video-packet", packet: { type: "session", width: seg.w, height: seg.h, isClientResize: false } });

    for (const au of accessUnits) {
      if (au.config) {
        events.push({ t, kind: "video-packet", packet: { type: "configuration", data: au.config } });
      }
      events.push({
        t,
        kind: "video-packet",
        packet: { type: "data", keyframe: au.keyframe, pts: frameIndex * FRAME_PTS_US, data: au.data },
      });
      frameIndex += 1;
      t += FRAME_MS;
    }

    if (segIndex < SEGMENTS.length - 1) {
      events.push({ t, kind: "posture-line", line: POSTURE_BETWEEN_SEGMENTS[segIndex] });
    }
  }

  return events;
}

function main() {
  const events = buildEvents();
  const encoded = events.map(encodeEvent);
  const totalLength = encoded.reduce((n, e) => n + e.length, RECORDING_MAGIC.length);
  const bytes = new Uint8Array(totalLength);
  bytes.set(RECORDING_MAGIC, 0);
  let offset = RECORDING_MAGIC.length;
  for (const chunk of encoded) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, bytes);

  const sizeKb = (bytes.length / 1024).toFixed(1);
  console.log(`wrote ${outFile} (${sizeKb} KiB, ${events.length} events)`);
  if (bytes.length > 2 * 1024 * 1024) {
    console.error("fixture exceeds 2 MiB, lower -b:v");
    process.exit(1);
  }
}

main();
