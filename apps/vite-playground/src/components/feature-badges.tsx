import { FeatureBadge } from "~/components/feature-badge";

type FeatureBadgesProps = {
  items: string[];
};

export function FeatureBadges({ items }: FeatureBadgesProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <FeatureBadge key={item}>{item}</FeatureBadge>
      ))}
    </div>
  );
}
