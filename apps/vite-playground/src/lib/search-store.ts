import { z } from "zod";

const HitStoreSchema = z.object({
  title: z.string().optional(),
  summary: z.string().optional(),
  sku: z.string().optional(),
  price: z.string().optional(),
  date: z.string().optional(),
  href: z.string().optional(),
});

/** Fields this UI shows from a search hit's `store` payload. */
export type HitStore = z.infer<typeof HitStoreSchema>;

/** Read the display fields from a hit store (unknown fields are ignored). */
export function readHitStore(store: unknown): HitStore {
  const parsed = HitStoreSchema.safeParse(store);
  return parsed.success ? parsed.data : {};
}
