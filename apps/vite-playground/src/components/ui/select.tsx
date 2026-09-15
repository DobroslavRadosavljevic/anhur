import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

type SelectItem = {
  value: string;
  label: string;
};

function Select({
  className,
  items,
  onValueChange,
  ...props
}: Omit<ComponentProps<"select">, "onChange"> & {
  items: readonly SelectItem[];
  onValueChange: (value: string) => void;
}) {
  return (
    <select
      data-slot="select"
      className={cn(
        "border-input bg-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
      onChange={(event) => onValueChange(event.target.value)}
      {...props}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

export { Select };
