import { Link, createFileRoute } from "@tanstack/react-router";
import { allPages } from "anhur/generated";
import { FeatureBadges } from "~/components/feature-badges";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/pages/")({
  component: PagesPage,
});

function PagesPage() {
  const locales = [
    ...new Set(allPages.map((p) => p._meta.locale ?? "default")),
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Pages
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Localized Markdown pages compiled to HTML with{" "}
          <code>md.markdown()</code>. Relative body images are copied via
          assets.
        </p>
        <FeatureBadges
          items={["md.markdown()", "folder i18n", "body assets", "s.unique()"]}
        />
      </div>

      <Tabs defaultValue={locales[0]}>
        <TabsList>
          {locales.map((locale) => (
            <TabsTrigger key={locale} value={locale}>
              {locale}
            </TabsTrigger>
          ))}
        </TabsList>
        {locales.map((locale) => {
          const pages = allPages.filter(
            (p) => (p._meta.locale ?? "default") === locale,
          );
          return (
            <TabsContent key={locale} value={locale} className="space-y-3">
              {pages.map((page) => (
                <Card key={`${page._meta.locale}-${page._meta.id}`}>
                  <CardHeader>
                    <CardTitle>{page.title}</CardTitle>
                    <CardDescription>{page.slug}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Link
                      to="/pages/$locale/$slug"
                      params={{
                        locale: String(page._meta.locale ?? "en"),
                        slug: page.slug,
                      }}
                      className={cn(buttonVariants({ size: "sm" }))}
                    >
                      View page
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
