import { serve } from "bun";
import { Superwall } from "@superwall/server";
import index from "./index.html";

type Rarity = "Common" | "Rare" | "Epic" | "Legendary";

interface Horse {
  id: string;
  name: string;
  stable: string;
  rarity: Rarity;
  discipline: string;
  color: string;
  image: string;
  stats: {
    speed: number;
    grace: number;
    stamina: number;
  };
}

interface CollectionEntry {
  id: string;
  acquiredAt: string;
}

const REVIEW_LAB = process.env.SW_REVIEW_LAB_HOST;
const SUPERWALL_API_KEY = process.env.SUPERWALL_API_KEY ?? "pk_ZNLGF8AlO2V50YDvC1y0c";
const PROXY_HOSTS: Record<string, string> = REVIEW_LAB
  ? {
      api: `https://${REVIEW_LAB}`,
      collector: "https://collector.superwall.me",
      enrichment: `https://${REVIEW_LAB}`,
      subscriptions: `https://${REVIEW_LAB}`,
    }
  : {
      api: "https://api.superwall.me",
      collector: "https://collector.superwall.me",
      enrichment: "https://enrichment-api.superwall.com",
      subscriptions: "https://subscriptions-api.superwall.com",
    };

const horses: Horse[] = [
  {
    id: "sundown-dakota",
    name: "Sundown Dakota",
    stable: "Cactus Spur Ranch",
    rarity: "Legendary",
    discipline: "Desert endurance",
    color: "Buckskin",
    image:
      "https://images.unsplash.com/photo-1553284965-83fd3e82fa5a?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 92, grace: 84, stamina: 98 },
  },
  {
    id: "mesa-moon",
    name: "Mesa Moon",
    stable: "Red Mesa Outfit",
    rarity: "Epic",
    discipline: "Night trail",
    color: "Dapple gray",
    image:
      "https://images.unsplash.com/photo-1534773728080-33d31da27ae5?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 82, grace: 93, stamina: 86 },
  },
  {
    id: "iron-lariat",
    name: "Iron Lariat",
    stable: "Blacksmith Creek",
    rarity: "Rare",
    discipline: "Ranch sorting",
    color: "Bay",
    image:
      "https://images.unsplash.com/photo-1523895665936-7bfe172b757d?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 76, grace: 78, stamina: 88 },
  },
  {
    id: "prairie-ghost",
    name: "Prairie Ghost",
    stable: "Dustline Stables",
    rarity: "Epic",
    discipline: "Open range sprint",
    color: "White",
    image:
      "https://images.unsplash.com/photo-1566251037378-5e04e3bec343?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 95, grace: 90, stamina: 78 },
  },
  {
    id: "copper-belle",
    name: "Copper Belle",
    stable: "Hearthstone Corral",
    rarity: "Common",
    discipline: "Town parade",
    color: "Chestnut",
    image:
      "https://images.unsplash.com/photo-1598974357801-cbca100e65d3?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 65, grace: 82, stamina: 70 },
  },
  {
    id: "whiskey-river",
    name: "Whiskey River",
    stable: "Three Pines Ranch",
    rarity: "Rare",
    discipline: "Barrel turn",
    color: "Palomino",
    image:
      "https://images.unsplash.com/photo-1551098891-7a1c852f6c6b?auto=format&fit=crop&w=900&q=80",
    stats: { speed: 88, grace: 76, stamina: 74 },
  },
];

const collections = new Map<string, CollectionEntry[]>();

const sw = Superwall<Request>({
  apiKey: SUPERWALL_API_KEY,
  userId: (req) => req.headers.get("x-demo-user"),
  environment: REVIEW_LAB
    ? {
        custom: {
          base: REVIEW_LAB,
          enrichment: REVIEW_LAB,
          subscriptions: REVIEW_LAB,
          collector: "collector.superwall.me",
        },
      }
    : "release",
});

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });

const proxy = async (req: Request, target: string, rest: string): Promise<Response> => {
  const url = new URL(req.url);
  const upstream = `${target}${rest}${url.search}`;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  const response = await fetch(upstream, {
    method: req.method,
    headers,
    ...(req.method !== "GET" && req.method !== "HEAD" && { body: await req.arrayBuffer() }),
    redirect: "manual",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate");
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

const requireSubscription = async (req: Request): Promise<Response | null> => {
  const userId = req.headers.get("x-demo-user");
  if (!userId) {
    return json({ error: "user_required" }, { status: 401 });
  }

  let allowed = false;
  try {
    allowed = await sw.userHas(userId, "pro");
  } catch (error) {
    return json(
      {
        error: "entitlement_check_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
  return allowed ? null : json({ error: "subscription_required", entitlement: "pro" }, { status: 403 });
};

const port = Number(process.env.PORT ?? 3000);

const server = serve({
  routes: {
    "/": index,
    "/api/horses": () => json({ horses }),
    "/api/collection": {
      GET(req) {
        const userId = req.headers.get("x-demo-user") ?? "guest";
        return json({ collection: collections.get(userId) ?? [] });
      },
      async POST(req) {
        const rejection = await requireSubscription(req);
        if (rejection) return rejection;

        const userId = req.headers.get("x-demo-user") ?? "guest";
        const body = (await req.json().catch(() => null)) as { horseId?: string } | null;
        const horse = horses.find((item) => item.id === body?.horseId);
        if (!horse) {
          return json({ error: "horse_not_found" }, { status: 404 });
        }

        const current = collections.get(userId) ?? [];
        const next = current.some((item) => item.id === horse.id)
          ? current
          : [...current, { id: horse.id, acquiredAt: new Date().toISOString() }];
        collections.set(userId, next);
        return json({ collection: next });
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
  port,

  async fetch(req) {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (match && match[1] && PROXY_HOSTS[match[1]]) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }
      const target = PROXY_HOSTS[match[1]];
      if (!target) return new Response("Unknown proxy target", { status: 404 });
      return proxy(req, target, match[2] ?? "");
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return index;
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at ${server.url}`);
