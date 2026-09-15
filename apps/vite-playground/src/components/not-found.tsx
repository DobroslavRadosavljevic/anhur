import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type NotFoundProps = {
  children?: ReactNode;
};

export function NotFound({ children }: NotFoundProps) {
  return (
    <div className="space-y-4 py-8">
      <h1 className="font-heading text-2xl font-semibold">Not found</h1>
      <div className="text-muted-foreground text-sm">
        {children || <p>That route is not part of the Anhur playground.</p>}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => window.history.back()}>
          Go back
        </Button>
        <Link to="/" className={cn(buttonVariants())}>
          Home
        </Link>
      </div>
    </div>
  );
}
