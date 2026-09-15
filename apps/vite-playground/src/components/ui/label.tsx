import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

function Label({
  className,
  children,
  ...props
}: ComponentProps<"label"> & { children: ReactNode }) {
  return (
    <label
      data-slot="label"
      className={cn("flex min-w-0 flex-col gap-1.5 text-sm", className)}
      {...props}
    >
      {children}
    </label>
  );
}

export { Label };
