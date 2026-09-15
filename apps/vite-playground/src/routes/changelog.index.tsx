import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { allChangelogs, getChangelog } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export const Route = createFileRoute("/changelog/")({
  loader: async () => {
    const entries = (
      await Promise.all(
        allChangelogs.map((entry) => getChangelog({ id: entry._meta.id })),
      )
    ).filter((entry) => entry != null);
    return { entries };
  },
  component: ChangelogPage,
});

function ChangelogPage() {
  const { entries } = useLoaderData({ from: "/changelog/" });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Changelog
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Monolingual Markdown collection — list sorted by{" "}
          <code>generate.listSort</code>; full bodies via{" "}
          <code>getChangelog()</code>.
        </p>
        <FeatureBadges
          items={[
            "localized: false",
            "md.markdown()",
            "listSort desc",
            "getChangelog()",
          ]}
        />
      </div>

      <div className="space-y-4">
        {entries.map((entry) => (
          <Card key={entry._meta.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>{entry.title}</CardTitle>
                <Badge variant="secondary">{entry.date}</Badge>
              </div>
              <CardDescription>{entry._meta.relativePath}</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="prose-anhur"
                dangerouslySetInnerHTML={{ __html: entry.body }}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
