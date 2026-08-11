// Browser Superscript loader — selected by the `browser` condition on the
// `#superscript-loader` subpath import in package.json. It statically
// references only `@superwall/superscript/browser`, so client bundlers never
// try to resolve the `/node` WASM glue (which `require`s `fs` and breaks
// browser builds, e.g. Next.js "Module not found: Can't resolve 'fs'").
import type { SuperscriptEvaluator } from "./superscript-loader.ts";

let evaluatorPromise: Promise<SuperscriptEvaluator> | null = null;

export const loadEvaluator = (): Promise<SuperscriptEvaluator> => {
  evaluatorPromise ??= import("@superwall/superscript/browser");
  return evaluatorPromise;
};
