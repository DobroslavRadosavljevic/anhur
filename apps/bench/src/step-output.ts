import { z } from "zod";

/** Time of one stage of a build. */
const StageSchema = z.object({ stage: z.string(), ms: z.number() });
export type Stage = z.infer<typeof StageSchema>;

/**
 * The stage times of a build result. Builds of `main` report none, so the
 * key is optional.
 */
export const BuildStagesSchema = z.object({
  timings: z.array(StageSchema).optional(),
});

/** One timed build or check. */
const StepRunSchema = z.object({
  ms: z.number(),
  stages: z.array(StageSchema),
});
export type StepRun = z.infer<typeof StepRunSchema>;

/** Every run of one scenario. */
const StepScenarioSchema = z.object({
  scenario: z.string(),
  runs: z.array(StepRunSchema),
});
export type StepScenario = z.infer<typeof StepScenarioSchema>;

/** What `step.ts` prints: its scenarios and the peak memory of its process. */
export const StepOutputSchema = z.object({
  scenarios: z.array(StepScenarioSchema),
  peakRssMb: z.number(),
});
export type StepOutput = z.infer<typeof StepOutputSchema>;
