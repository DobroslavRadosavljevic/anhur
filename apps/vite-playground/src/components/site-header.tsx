import { Link } from "@tanstack/react-router";
import { settings } from "anhur/generated";
import { buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

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
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Overview
          </Link>
          <Link
            to="/search"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Search
          </Link>
          <Link
            to="/posts"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Posts
          </Link>
          <Link
            to="/pages"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Pages
          </Link>
          <Link
            to="/authors"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Authors
          </Link>
          <Link
            to="/products"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Products
          </Link>
          <Link
            to="/changelog"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            Changelog
          </Link>
          <Link
            to="/about"
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
            activeProps={{
              className: cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
              ),
            }}
          >
            About
          </Link>
        </nav>
      </div>
    </header>
  );
}
