import {
  ErrorComponent,
  Link,
  useLocation,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { Button, buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

type DefaultCatchBoundaryProps = ErrorComponentProps;

export function DefaultCatchBoundary({ error }: DefaultCatchBoundaryProps) {
  const router = useRouter();
  const isRoot = useLocation({
    select: (location) => location.pathname === "/",
  });

  console.error("DefaultCatchBoundary Error:", error);

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 p-4">
      <ErrorComponent error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => router.invalidate()}>
          Try again
        </Button>
        {isRoot ? (
          <Link to="/" className={cn(buttonVariants())}>
            Home
          </Link>
        ) : (
          <Button variant="secondary" onClick={() => window.history.back()}>
            Go back
          </Button>
        )}
      </div>
    </div>
  );
}
