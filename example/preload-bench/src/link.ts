// A shaped "cellular link" for Bun.serve responses: every body streams
// through one shared bandwidth budget, split evenly between the responses in
// flight, after a fixed per-request latency. Browser-side throttling
// (DevTools / CDP) doesn't reliably cover iframe navigations, so the
// benchmark shapes on the server instead. A response the browser abandons
// (e.g. a removed iframe) stops consuming bandwidth immediately.

const TICK_MS = 10;
const CHUNK = 16 * 1024;

interface Flow {
  readonly body: Uint8Array;
  sent: number;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly onSent: (n: number) => void;
  closed: boolean;
}

export interface LinkProfile {
  /** Bytes per second, shared by all responses in flight. */
  readonly bytesPerSecond: number;
  /** Delay before a response starts streaming. */
  readonly latencyMs: number;
}

export const createLink = () => {
  let profile: LinkProfile = { bytesPerSecond: Infinity, latencyMs: 0 };
  const flows = new Set<Flow>();
  let carry = 0;

  setInterval(() => {
    if (flows.size === 0) {
      carry = 0;
      return;
    }
    let budget = carry + (profile.bytesPerSecond * TICK_MS) / 1000;
    // Water-fill: even shares, leftovers from short flows go to the rest.
    let active = [...flows];
    while (budget >= 1 && active.length > 0) {
      const share = Math.max(1, Math.floor(budget / active.length));
      const next: Flow[] = [];
      for (const f of active) {
        const n = Math.min(share, f.body.length - f.sent, CHUNK * 8, Math.floor(budget));
        if (n <= 0) continue;
        try {
          f.controller.enqueue(f.body.subarray(f.sent, f.sent + n));
          f.sent += n;
          budget -= n;
          f.onSent(n);
        } catch {
          // The browser abandoned it; those bytes never went out.
          f.closed = true;
        }
        if (f.closed || f.sent >= f.body.length) {
          flows.delete(f);
          if (!f.closed) {
            f.closed = true;
            try {
              f.controller.close();
            } catch {}
          }
        } else {
          next.push(f);
        }
      }
      active = next;
    }
    carry = Math.min(budget, profile.bytesPerSecond); // don't bank more than 1s
  }, TICK_MS).unref();

  return {
    setProfile(p: LinkProfile) {
      profile = p;
    },
    /** Stream `body` over the link. `onSent` reports bytes as they leave. */
    stream(body: Uint8Array, onSent: (n: number) => void): ReadableStream<Uint8Array> {
      let flow: Flow | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => {
            flow = { body, sent: 0, controller, onSent, closed: false };
            if (body.length === 0) controller.close();
            else flows.add(flow);
          }, profile.latencyMs);
        },
        cancel() {
          if (timer) clearTimeout(timer);
          if (flow) {
            flow.closed = true;
            flows.delete(flow);
          }
        },
      });
    },
  };
};
