import { type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";

type FeatureBadgeProps = {
  children: ReactNode;
};

export function FeatureBadge({ children }: FeatureBadgeProps) {
  return (
    <Badge variant="secondary" className="font-mono text-[0.7rem]">
      {children}
    </Badge>
  );
}
