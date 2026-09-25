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

const STATES_LINE = "@states 0=CLOSED,1=TENT,2=HALF_OPENED,3=OPENED,4=CONCURRENT_INNER_DEFAULT,5=CONCURRENT_OUTER_DEFAULT";

// Posture lines emitted around each segment's first packet, matching the M0
// probe timeline (opening walks 0 -> 1 -> 2 -> 3 within about a second).
// offsetMs is relative to the segment's own start time and is negative for
// every line that must lead the stream restart: on real hardware posture
// changes before the stream restarts at the new size, so HALF_OPENED (and
// the matching 1968x2184 size) arrives before the inner stream's first
// packet, not after it, and the same for the landscape rotation.
const POSTURE_BEFORE_SEGMENT = [
  [
    { offsetMs: 0, line: STATES_LINE },
    { offsetMs: 0, line: "0 | mRotation=0 | Physical size: 1080x2520" },
  ],
  [
    { offsetMs: -450, line: "1 | mRotation=0 | Physical size: 1080x2520" },
    { offsetMs: -300, line: "2 | mRotation=0 | Physical size: 1968x2184" },
    { offsetMs: -150, line: "3 | mRotation=0 | Physical size: 1968x2184" },
  ],
  [{ offsetMs: -150, line: "3 | mRotation=1 | Physical size: 1968x2184" }],
];

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

    for (const { offsetMs, line } of POSTURE_BEFORE_SEGMENT[segIndex]) {
      events.push({ t: t + offsetMs, kind: "posture-line", line });
    }

    const rawStream = renderSegment(seg, useDrawtext);
    const accessUnits = groupAccessUnits(splitNalUnits(rawStream));

    events.push({ t, kind: "video-packet", packet: { type: "session", width: seg.w, height: seg.h, isClientResize: false } });

    // Real scrcpy sends a configuration packet only when the encoder
    // (re)starts, not before every periodic keyframe; x264's repeat-headers
    // still reinserts SPS/PPS before every GOP boundary in the raw stream so
    // each keyframe is independently decodable, but only the first access
    // unit's config is surfaced as its own packet here, matching scrcpy's
    // cadence. See findings I2b.
    let configEmitted = false;
    for (const au of accessUnits) {
      if (au.config && !configEmitted) {
        events.push({ t, kind: "video-packet", packet: { type: "configuration", data: au.config } });
        configEmitted = true;
      }
      events.push({
        t,
        kind: "video-packet",
        packet: { type: "data", keyframe: au.keyframe, pts: frameIndex * FRAME_PTS_US, data: au.data },
      });
      frameIndex += 1;
      t += FRAME_MS;
    }
  }

  // Posture lines can now lead a segment's own events (negative offsets),
  // so the push order above is no longer chronological; sort so the
  // replay's own "last array element is the final frame" end-of-stream
  // check still lines up with the actual last thing that happens in time.
  events.sort((a, b) => a.t - b.t);

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
