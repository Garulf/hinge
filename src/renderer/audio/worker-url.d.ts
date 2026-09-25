/**
 * Vite's `?worker&url` suffix bundles the referenced module as its own
 * entry (resolving its imports, transpiling it) and gives back the built
 * file's URL as a string, instead of a Worker constructor. Used to load
 * pcm-worklet.ts via AudioContext.audioWorklet.addModule(), which needs a
 * URL to a real compiled script, not raw TypeScript source.
 */
declare module "*?worker&url" {
  const url: string;
  export default url;
}
