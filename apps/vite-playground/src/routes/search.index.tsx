import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  createSearcher,
  type AnhurOramaIndex,
  type SearchHit,
  type Searcher,
} from "@anhur/orama/client";
import { searchContent } from "~/lib/search-api";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

// Written by integrations: [orama({…})] during Anhur build.
import searchIndex from "../../.anhur/generated/search/orama.json";

type HitStore = {
  title?: string;
  name?: string;
  slug?: string;
  summary?: string;
  sku?: string;
  price?: string;
  date?: string;
  href?: string;
};

const COLLECTIONS = ["all", "posts", "pages", "products", "changelog"] as const;

export const Route = createFileRoute("/search/")({
  component: SearchPage,
});

function hitTitle(hit: SearchHit<HitStore>): string {
  return hit.store.title ?? hit.store.name ?? hit.documentId;
}

function SearchPage() {
  const [term, setTerm] = useState("hello");
  const [collection, setCollection] =
    useState<(typeof COLLECTIONS)[number]>("all");
  const [mode, setMode] = useState<"client" | "server">("client");
  const [clientSearcher, setClientSearcher] = useState<Searcher | null>(null);
  const [clientHits, setClientHits] = useState<SearchHit<HitStore>[]>([]);
  const [clientMeta, setClientMeta] = useState({ count: 0, elapsed: "" });
  const [serverHits, setServerHits] = useState<SearchHit<HitStore>[]>([]);
  const [serverMeta, setServerMeta] = useState({ count: 0, elapsed: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void createSearcher(searchIndex as AnhurOramaIndex).then((searcher) => {
      if (!cancelled) setClientSearcher(searcher);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const collectionFilter = collection === "all" ? undefined : collection;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!term.trim()) {
        if (mode === "client") {
          setClientHits([]);
          setClientMeta({ count: 0, elapsed: "" });
        } else {
          setServerHits([]);
          setServerMeta({ count: 0, elapsed: "" });
        }
        return;
      }

      if (mode === "client") {
        if (!clientSearcher) return;
        const result = await clientSearcher.search({
          term,
          collection: collectionFilter,
          limit: 20,
        });
        if (cancelled) return;
        setClientHits(result.hits as SearchHit<HitStore>[]);
        setClientMeta({
          count: result.count,
          elapsed: result.elapsed.formatted,
        });
        return;
      }

      setPending(true);
      setError(null);
      try {
        const result = await searchContent({
          data: {
            term,
            collection: collectionFilter,
            limit: 20,
          },
        });
        if (cancelled) return;
        setServerHits(
          result.hits.map((hit) => ({
            id: hit.id,
            score: hit.score,
            collection: hit.collection,
            locale: hit.locale,
            documentId: hit.documentId,
            store: hit.store,
          })),
        );
        setServerMeta({
          count: result.count,
          elapsed: result.elapsed.formatted,
        });
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setPending(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [term, mode, collectionFilter, clientSearcher]);

  const activeHits = mode === "client" ? clientHits : serverHits;
  const activeMeta = mode === "client" ? clientMeta : serverMeta;

  const indexedCollections = useMemo(
    () => (searchIndex as AnhurOramaIndex).collections,
    [],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Search
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Full-text Orama index built in Anhur <code>complete</code>. Same
          snapshot powers browser search and a server function.
        </p>
        <FeatureBadges
          items={[
            "@anhur/orama",
            "complete hook",
            "client restore",
            "createServerFn",
            ...indexedCollections.map((name) => `index:${name}`),
          ]}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">Query</span>
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search posts, pages, products…"
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </label>
        <label className="flex w-full flex-col gap-1.5 text-sm sm:w-44">
          <span className="text-muted-foreground">Collection</span>
          <select
            value={collection}
            onChange={(event) =>
              setCollection(event.target.value as (typeof COLLECTIONS)[number])
            }
            className="border-input bg-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            {COLLECTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="secondary" disabled={pending}>
          {pending ? "Searching…" : "Live"}
        </Button>
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => setMode(value as "client" | "server")}
      >
        <TabsList>
          <TabsTrigger value="client">Browser</TabsTrigger>
          <TabsTrigger value="server">Server function</TabsTrigger>
        </TabsList>
        <TabsContent value="client" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Restores <code>.anhur/generated/search/orama.json</code> in the
            browser via <code>createSearcher</code>.
          </p>
        </TabsContent>
        <TabsContent value="server" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Calls <code>searchContent</code> — same index file, Node restore.
          </p>
        </TabsContent>
      </Tabs>

      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <span>
          {activeMeta.count} hit{activeMeta.count === 1 ? "" : "s"}
        </span>
        {activeMeta.elapsed ? <span>· {activeMeta.elapsed}</span> : null}
        {!clientSearcher && mode === "client" ? (
          <span>· loading index…</span>
        ) : null}
      </div>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="space-y-3">
        {activeHits.length === 0 ? (
          <p className="text-muted-foreground text-sm">No results.</p>
        ) : (
          activeHits.map((hit) => (
            <Card key={`${hit.collection}-${hit.id}`}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">{hitTitle(hit)}</CardTitle>
                  <Badge variant="secondary">{hit.collection}</Badge>
                  <Badge variant="outline">{hit.locale}</Badge>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    score {hit.score.toFixed(2)}
                  </span>
                </div>
                {hit.store.summary || hit.store.sku || hit.store.date ? (
                  <CardDescription>
                    {hit.store.summary ??
                      (hit.store.sku
                        ? `${hit.store.sku}${hit.store.price ? ` · ${hit.store.price}` : ""}`
                        : hit.store.date)}
                  </CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                {hit.store.href ? (
                  <a
                    href={hit.store.href}
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    Open
                  </a>
                ) : null}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
