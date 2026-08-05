import { createFileRoute } from "@tanstack/react-router";
import { about } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import { Separator } from "~/components/ui/separator";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

function AboutPage() {
  return (
    <article className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {about.title}
        </h1>
        <p className="text-muted-foreground text-sm">
          Singleton loaded from a single <code>filePath</code> with{" "}
          <code>localized: false</code>.
        </p>
        <FeatureBadges
          items={["singleton", "filePath", "localized: false", "s.raw()"]}
        />
      </div>
      <Separator />
      <p className="max-w-2xl whitespace-pre-wrap text-sm leading-relaxed">
        {about.body}
      </p>
      <p className="text-muted-foreground font-mono text-xs">
        {about._meta.filePath}
      </p>
    </article>
  );
}
