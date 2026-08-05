import { Badge } from "~/components/ui/badge";

export function FeatureBadge({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className="font-mono text-[0.7rem]">
      {children}
    </Badge>
  );
}

export function FeatureBadges({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <FeatureBadge key={item}>{item}</FeatureBadge>
      ))}
    </div>
  );
}
