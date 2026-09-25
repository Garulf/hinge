/**
 * `@yume-chan/pcm-player@3.0.0-beta.3` (pinned, per the M5 plan) is not an
 * installed dependency in this worktree: node_modules is a symlink shared
 * with the main checkout and other worktrees running tests concurrently, so
 * `npm install` here would write into their shared tree. This ambient
 * declaration keeps audio-player-adapter.ts (the only file that imports the
 * real package) typecheck-safe without it being physically present; once
 * the package is installed for real, this file can be deleted and the real
 * `.d.ts` takes over the module's typing instead.
 */
declare module "@yume-chan/pcm-player" {
  export class Float32PlanerPcmPlayer {
    constructor(sampleRate: number, channelCount: number);
    start(): Promise<void>;
    stop(): void;
    feed(planes: Float32Array[]): void;
    readonly outputLatency: number;
  }
}
