import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Crown, Plus, Search, Sparkles, UserRound } from "lucide-react";
import { usePlacement, useSignal, useSuperwall, useUser } from "@superwall/paywalls-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import "./index.css";

interface Horse {
  id: string;
  name: string;
  stable: string;
  rarity: "Common" | "Rare" | "Epic" | "Legendary";
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

interface CollectionResponse {
  collection: CollectionEntry[];
}

const USERS = [
  { id: "rider_ava", name: "Ava Reed", role: "Territory rancher" },
  { id: "rider_miles", name: "Miles Chen", role: "Trail boss" },
  { id: "rider_noor", name: "Noor Patel", role: "Frontier breeder" },
] as const;

const rarityStyles: Record<Horse["rarity"], string> = {
  Common: "border-stone-200 bg-stone-50 text-stone-700",
  Rare: "border-sky-200 bg-sky-50 text-sky-700",
  Epic: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
  Legendary: "border-amber-200 bg-amber-50 text-amber-800",
};

const fmtDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export function App() {
  const sw = useSuperwall();
  const user = useUser();
  const subscriptionStatus = useSignal(sw.subscriptionStatus);
  const isConfigured = useSignal(sw.isConfigured);
  const { register, state } = usePlacement();
  const [horses, setHorses] = useState<Horse[]>([]);
  const [collection, setCollection] = useState<CollectionEntry[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>(USERS[0].id);
  const [query, setQuery] = useState("");
  const [activeRarity, setActiveRarity] = useState<Horse["rarity"] | "All">("All");
  const [pendingHorseId, setPendingHorseId] = useState<string | null>(null);
  const [notice, setNotice] = useState("The saloon catalog is open to every rider. Claiming a horse card takes a Pro pass.");

  const selectedUser = USERS.find((item) => item.id === selectedUserId) ?? USERS[0];
  const hasSubscription = subscriptionStatus.status === "ACTIVE";
  const collectionIds = useMemo(() => new Set(collection.map((item) => item.id)), [collection]);
  const collectionValue = useMemo(
    () =>
      collection.reduce((total, entry) => {
        const horse = horses.find((item) => item.id === entry.id);
        if (!horse) return total;
        return total + (horse.rarity === "Legendary" ? 220 : horse.rarity === "Epic" ? 140 : horse.rarity === "Rare" ? 85 : 40);
      }, 0),
    [collection, horses],
  );

  const filteredHorses = horses.filter((horse) => {
    const haystack = `${horse.name} ${horse.stable} ${horse.discipline}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (activeRarity === "All" || horse.rarity === activeRarity);
  });

  useEffect(() => {
    void user.identify(selectedUserId, { restorePaywallAssignments: true });
    setNotice(`${selectedUser.name} is browsing the frontier market.`);
  }, [selectedUserId]);

  useEffect(() => {
    fetch("/api/horses")
      .then((res) => res.json() as Promise<{ horses: Horse[] }>)
      .then((data) => setHorses(data.horses))
      .catch(() => setNotice("The frontier market could not be loaded."));
  }, []);

  useEffect(() => {
    fetch("/api/collection", { headers: { "x-demo-user": selectedUserId } })
      .then((res) => res.json() as Promise<CollectionResponse>)
      .then((data) => setCollection(data.collection))
      .catch(() => setCollection([]));
  }, [selectedUserId]);

  const showPaywall = async (reason: string) => {
    setNotice(reason);
    const result = await register({
      placement: "home",
    });

    if (result.type === "error") {
      setNotice(result.error.message);
      return false;
    }

    const subscribed = sw.subscriptionStatus.value.status === "ACTIVE";
    setNotice(
      subscribed
        ? "Pro pass active. You can claim horse cards."
        : "A Pro pass is required before claiming cards.",
    );
    return subscribed;
  };

  const buyProPass = () => {
    void showPaywall("Opening the Superwall paywall for a Pro pass.");
  };

  const claimHorse = async (horse: Horse) => {
    setPendingHorseId(horse.id);
    setNotice(`A Pro pass is required to claim ${horse.name}.`);

    let claimed = false;
    let claimMessage = "The server did not confirm a Pro entitlement.";
    const result = await register({
      placement: "home",
      params: { horse_id: horse.id, rarity: horse.rarity },
      feature: async () => {
        const response = await fetch("/api/collection", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-demo-user": selectedUserId,
          },
          body: JSON.stringify({ horseId: horse.id }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
          claimMessage = body?.message ?? claimMessage;
          return;
        }

        const data = (await response.json()) as CollectionResponse;
        setCollection(data.collection);
        claimMessage = `${horse.name} was claimed for ${selectedUser.name}'s ranch book.`;
        claimed = true;
      },
    });

    if (result.type === "error") {
      setNotice(result.error.message);
      setPendingHorseId(null);
      return;
    }

    setNotice(
      claimed
        ? claimMessage
        : result.type === "presented" && result.result.type === "declined"
          ? "Claim cancelled. A Pro pass is required before the server will stamp this card."
          : claimMessage,
    );
    setPendingHorseId(null);
  };

  return (
    <main className="min-h-screen bg-[#f1dfbf] text-[#24170f]">
      <section className="border-b-2 border-[#7a3f1a] bg-[#fff7e8] shadow-[0_2px_0_rgba(80,37,14,0.12)]">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-[#8a3d12]">
                <BadgeCheck className="size-4" />
                Superwall Frontier SaaS
              </div>
              <h1 className="mt-2 text-3xl font-bold tracking-normal sm:text-4xl">Dusty Spur Horse Ledger</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                className="h-10 rounded-md border border-[#b87a41] bg-white px-3 text-sm shadow-xs"
              >
                {USERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <Button variant={hasSubscription ? "secondary" : "default"} onClick={buyProPass}>
                {hasSubscription ? <BadgeCheck /> : <Crown />}
                {hasSubscription ? "Pro Pass Active" : "Buy Pro Pass"}
              </Button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Catalog" value={horses.length.toString()} />
            <Metric label="Collection" value={collection.length.toString()} />
            <Metric label="Est. value" value={`$${collectionValue}`} />
            <Metric label="SDK" value={isConfigured ? "Ready" : "Loading"} />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_360px] lg:px-8">
        <div className="space-y-5">
          <div className="flex flex-col gap-3 rounded-lg border-2 border-[#7a3f1a] bg-[#fff7e8] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[#b87a41] bg-white/70 px-3">
              <Search className="size-4 text-[#7a3f1a]" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search horses, ranches, trail talents"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {(["All", "Common", "Rare", "Epic", "Legendary"] as const).map((rarity) => (
                <Button
                  key={rarity}
                  variant={activeRarity === rarity ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveRarity(rarity)}
                >
                  {rarity}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredHorses.map((horse) => (
              <HorseCard
                key={horse.id}
                horse={horse}
                owned={collectionIds.has(horse.id)}
                pending={pendingHorseId === horse.id}
                onAdd={() => void claimHorse(horse)}
              />
            ))}
          </div>
        </div>

        <aside className="space-y-5">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UserRound className="size-5" />
                {selectedUser.name}
              </CardTitle>
              <CardDescription>{selectedUser.role}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">{notice}</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <StatusItem label="User" value={user.isLoggedIn ? user.id : "Guest"} />
                <StatusItem label="Plan" value={hasSubscription ? "Pro Pass" : "Free Rider"} />
                <StatusItem label="Placement" value={state.type} />
                <StatusItem label="Entitlement" value={user.entitlements[0]?.id ?? "None"} />
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="size-5" />
                Collection
              </CardTitle>
              <CardDescription>Claims stamped through the gated API route.</CardDescription>
            </CardHeader>
            <CardContent>
              {collection.length === 0 ? (
                <div className="rounded-md border border-dashed border-stone-300 p-4 text-sm text-stone-500">
                  No horse cards claimed yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {collection.map((entry) => {
                    const horse = horses.find((item) => item.id === entry.id);
                    if (!horse) return null;
                    return (
                      <div key={entry.id} className="flex items-center gap-3">
                        <img src={horse.image} alt="" className="size-12 rounded-md object-cover" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{horse.name}</div>
                          <div className="text-xs text-stone-500">{fmtDate(entry.acquiredAt)}</div>
                        </div>
                        <span className={`rounded-full border px-2 py-1 text-xs ${rarityStyles[horse.rarity]}`}>
                          {horse.rarity}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </section>
    </main>
  );
}

function HorseCard({
  horse,
  owned,
  pending,
  onAdd,
}: {
  horse: Horse;
  owned: boolean;
  pending: boolean;
  onAdd: () => void;
}) {
  return (
    <Card className="overflow-hidden rounded-lg pt-0">
      <img src={horse.image} alt={horse.name} className="aspect-[4/3] w-full object-cover" />
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-xl">{horse.name}</CardTitle>
            <CardDescription>{horse.stable}</CardDescription>
          </div>
          <span className={`rounded-full border px-2 py-1 text-xs font-medium ${rarityStyles[horse.rarity]}`}>
            {horse.rarity}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-stone-600">{horse.discipline}</div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <StatusItem label="Speed" value={horse.stats.speed.toString()} />
          <StatusItem label="Grace" value={horse.stats.grace.toString()} />
          <StatusItem label="Stamina" value={horse.stats.stamina.toString()} />
        </div>
        <Button className="w-full" variant={owned ? "secondary" : "default"} disabled={owned || pending} onClick={onAdd}>
          {owned ? <BadgeCheck /> : <Plus />}
          {owned ? "Claimed" : pending ? "Stamping" : "Claim card"}
        </Button>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-normal text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-normal text-stone-500">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-stone-900">{value}</div>
    </div>
  );
}

export default App;
