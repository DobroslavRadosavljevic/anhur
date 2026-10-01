import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { createSearcher, type Searcher } from "@anhur/orama/client";
import {
  loadSearchIndex,
  locales,
  type AnhurSearchField,
  type AnhurSearchStores,
  type Locale,
} from "anhur/generated";
import { searchContent } from "~/lib/search-api";
import { isLocale } from "~/lib/locale";
import { readHitStore, type HitStore } from "~/lib/search-store";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select } from "~/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

/** A hit as shown in the list (store narrowed to the displayed fields). */
type DisplayHit = {
  readonly id: string;
  readonly score: number;
  readonly collection: string;
  readonly documentId: string;
  readonly store: HitStore;
};

const COLLECTIONS = ["all", "posts", "pages", "products", "changelog"] as const;

function isCollection(value: string): value is (typeof COLLECTIONS)[number] {
  return (
    value === "all" ||
    value === "posts" ||
    value === "pages" ||
    value === "products" ||
    value === "changelog"
  );
}

function isSearchMode(value: string): value is "client" | "server" {
  return value === "client" || value === "server";
}

function hitTitle(hit: DisplayHit): string {
  return hit.store.title ?? hit.documentId;
}

export const Route = createFileRoute("/search/")({
  component: SearchPage,
});

function SearchPage() {
  const [term, setTerm] = useState("hello");
  const [collection, setCollection] =
    useState<(typeof COLLECTIONS)[number]>("all");
  const [mode, setMode] = useState<"client" | "server">("client");
  const [locale, setLocale] = useState<Locale>("en");
  const [clientSearcher, setClientSearcher] = useState<Searcher<
    AnhurSearchStores,
    AnhurSearchField
  > | null>(null);
  const [clientHits, setClientHits] = useState<DisplayHit[]>([]);
  const [clientMeta, setClientMeta] = useState({ count: 0, elapsed: "" });
  const [serverHits, setServerHits] = useState<DisplayHit[]>([]);
  const [serverMeta, setServerMeta] = useState({ count: 0, elapsed: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setClientSearcher(null);
    setError(null);
    void loadSearchIndex(locale)
      .then(createSearcher)
      .then(
        (searcher) => {
          if (!cancelled) setClientSearcher(searcher);
        },
        (cause: unknown) => {
          if (!cancelled) {
            setError(
              `Cannot load the ${locale} search index: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [locale]);

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
        const result = await clientSearcher
          .search({ term, collection: collectionFilter, limit: 20 })
          .catch((cause: unknown) => {
            if (!cancelled) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
            return null;
          });
        if (cancelled || !result) return;
        setClientHits(
          result.hits.map((hit) => ({
            ...hit,
            store: readHitStore(hit.store),
          })),
        );
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
            locale,
            collection: collectionFilter,
            limit: 20,
          },
        });
        if (cancelled) return;
        setServerHits(result.hits);
        setServerMeta({ count: result.count, elapsed: result.elapsed });
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
  }, [term, mode, locale, collectionFilter, clientSearcher]);

  const activeHits = mode === "client" ? clientHits : serverHits;
  const activeMeta = mode === "client" ? clientMeta : serverMeta;

  const indexedCollections = useMemo(
    () => clientSearcher?.collections ?? [],
    [clientSearcher],
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Search
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Full-text Orama index per locale, built by the <code>orama()</code>{" "}
          plugin. The same generated module powers browser search and a server
          function.
        </p>
        <FeatureBadges
          items={[
            "@anhur/orama",
            "loadSearchIndex(locale)",
            "unicode tokenizer",
            "createServerFn",
            ...indexedCollections.map((name) => `index:${name}`),
          ]}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Label className="flex-1">
          <span className="text-muted-foreground">Query</span>
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search posts, pages, products…"
          />
        </Label>
        <Label className="w-full sm:w-28">
          <span className="text-muted-foreground">Locale</span>
          <Select
            value={locale}
            items={locales.map((name) => ({ value: name, label: name }))}
            onValueChange={(value) => {
              if (isLocale(value)) setLocale(value);
            }}
          />
        </Label>
        <Label className="w-full sm:w-44">
          <span className="text-muted-foreground">Collection</span>
          <Select
            value={collection}
            items={COLLECTIONS.map((name) => ({ value: name, label: name }))}
            onValueChange={(value) => {
              if (isCollection(value)) {
                setCollection(value);
              }
            }}
          />
        </Label>
        <Button type="button" variant="secondary" disabled={pending}>
          {pending ? "Searching…" : "Live"}
        </Button>
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          if (isSearchMode(value)) {
            setMode(value);
          }
        }}
      >
        <TabsList>
          <TabsTrigger value="client">Browser</TabsTrigger>
          <TabsTrigger value="server">Server function</TabsTrigger>
        </TabsList>
        <TabsContent value="client" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Loads <code>loadSearchIndex(locale)</code> from{" "}
            <code>anhur/generated</code> and searches it in the browser.
          </p>
        </TabsContent>
        <TabsContent value="server" className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Calls <code>searchContent</code>: the same generated module, on the
            server.
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
                  <Badge variant="outline">{locale}</Badge>
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
