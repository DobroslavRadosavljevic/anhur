import { Effect, Schema } from "effect";
import { messageOf } from "../diagnostics";

/** File work of the engine itself failed or did not finish. */
export class FileWorkError extends Schema.TaggedError<FileWorkError>()(
  "FileWorkError",
  { message: Schema.String },
) {}

const FILE_WORK_TIMEOUT = "10 minutes";

/**
 * Run file-system work of the engine itself (stats, cache reads and
 * writes, listings; never user code). These functions handle the failures
 * a build can live with themselves, so a rejection or a hang here is a bug
 * or a broken disk: it ends the build as an internal error.
 */
export function fileWork<A>(run: () => Promise<A>): Effect.Effect<A> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new FileWorkError({ message: messageOf(cause) }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: FILE_WORK_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new FileWorkError({
            message: `File work did not finish within ${FILE_WORK_TIMEOUT}.`,
          }),
        ),
    }),
    Effect.orDie,
  );
}
