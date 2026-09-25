import { Float32PlanerPcmPlayer } from "@yume-chan/pcm-player";
import type { PcmPlayerFactory } from "./audio-pipe";

/**
 * The only file that imports `@yume-chan/pcm-player`, kept isolated so
 * AudioPipe itself stays buildable and testable without the package (see
 * pcm-player.d.ts for why it is not installed in this worktree). Wire this
 * factory in wherever a real PcmPlayerLike is needed.
 */
export const pcmPlayerFactory: PcmPlayerFactory = (sampleRate, channelCount) => new Float32PlanerPcmPlayer(sampleRate, channelCount);
