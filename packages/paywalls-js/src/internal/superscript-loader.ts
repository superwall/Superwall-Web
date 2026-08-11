// Default (Node/Bun) Superscript loader.
//
// Browser bundles never load this module: `#superscript-loader` resolves to
// `superscript-loader.browser.ts` via the `browser` condition on the subpath
// import in package.json, keeping the `@superwall/superscript/node` specifier
// (whose WASM glue calls `require('fs')`) out of client bundles entirely.
//
// The runtime check below is a fallback for tools that resolve the `default`
// condition while still executing in a browser: the `/node` entry loads WASM
// via `fs.readFileSync` (works in Bun/Node, breaks in browsers); the
// `/browser` entry uses bundler `import './*.wasm'` glue. The Rust core is
// identical — only the loader differs. Cache the resolved module per process.
import type {
  ExecutionContext,
  WasmHostContext,
} from "@superwall/superscript/node";

export interface SuperscriptEvaluator {
  /** Superscript ≥1.0 returns `Promise<string>` (a JSON `{Ok|Err}` envelope);
   *  ≤0.2 returned a string/boolean synchronously. */
  readonly evaluateWithContext: (
    input: ExecutionContext,
    host: WasmHostContext,
  ) => Promise<string> | string | boolean;
}

let evaluatorPromise: Promise<SuperscriptEvaluator> | null = null;

export const loadEvaluator = (): Promise<SuperscriptEvaluator> => {
  if (evaluatorPromise) return evaluatorPromise;
  // `typeof window/document` is unreliable — happy-dom + jsdom register both
  // as globals in Bun/Node test runtimes. The presence of `Bun` or `process`
  // is the actual signal we're outside a browser.
  const isBunOrNode =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
    typeof (globalThis as { process?: { versions?: { node?: string } } })
      .process?.versions?.node === "string";
  evaluatorPromise = isBunOrNode
    ? import("@superwall/superscript/node")
    : import("@superwall/superscript/browser");
  return evaluatorPromise;
};
