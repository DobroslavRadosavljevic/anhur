import { Link } from "@tanstack/react-router";
import { settings } from "anhur/generated";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const nav = [
  { to: "/", label: "Overview", exact: true },
  { to: "/posts", label: "Posts" },
  { to: "/pages", label: "Pages" },
  { to: "/authors", label: "Authors" },
  { to: "/products", label: "Products" },
  { to: "/changelog", label: "Changelog" },
  { to: "/about", label: "About" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            to="/"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            {settings.siteName}
          </Link>
          <p className="text-muted-foreground text-sm">{settings.tagline}</p>
        </div>
        <nav className="flex flex-wrap gap-1">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={
                "exact" in item ? { exact: item.exact } : undefined
              }
              className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              activeProps={{
                className: cn(
                  buttonVariants({ variant: "secondary", size: "sm" }),
                ),
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
