import { Effect } from "effect";

/** Promise edge used by Node hosts (Vite plugins, watch controllers). */
export const runEffectPromise = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(effect);
