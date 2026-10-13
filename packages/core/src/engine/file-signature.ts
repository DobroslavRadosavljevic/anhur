import { statSync } from "node:fs";
import { stat } from "node:fs/promises";

/** What `stat` says about a file; equal signatures mean "probably unchanged". */
export type FileSignature = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly isFile: boolean;
};

/**
 * A file changed twice within the time step of the file system keeps its
 * size and timestamps the second time. A signature only proves "unchanged"
 * when the file was last modified this long before its content was read
 * (the coarsest common time step is 2 s, on FAT).
 */
const RACY_WINDOW_MS = 2500;

/** Signature of `file`, or `undefined` when it does not exist. */
export async function readSignature(
  file: string,
): Promise<FileSignature | undefined> {
  try {
    const info = await stat(file);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
      isFile: info.isFile(),
    };
  } catch {
    return undefined;
  }
}

export function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino &&
    a.isFile === b.isFile
  );
}

/** True when a file modified at `mtimeMs` cannot have changed unseen since `readAt`. */
export function isSettled(mtimeMs: number, readAt: number): boolean {
  return mtimeMs < readAt - RACY_WINDOW_MS;
}

/**
 * True when `now` proves the file still has the content read at `readAt`
 * (epoch milliseconds, taken before the read) with signature `then`.
 */
export function provesUnchanged(
  then: FileSignature,
  now: FileSignature,
  readAt: number,
): boolean {
  return sameSignature(then, now) && isSettled(now.mtimeMs, readAt);
}

/** Signature of `file` without waiting, or `undefined` when it does not exist. */
function readSignatureSync(file: string): FileSignature | undefined {
  const info = statSync(file, { throwIfNoEntry: false });
  if (!info) return undefined;
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
    isFile: info.isFile(),
  };
}

/** Stats of one build: every path is looked at once. */
export type SignatureMemo = {
  /** Finished stats (`undefined`: the file does not exist). */
  readonly known: Map<string, FileSignature | undefined>;
  /** Stats on their way. */
  readonly pending: Map<string, Promise<FileSignature | undefined>>;
};

export function createSignatureMemo(): SignatureMemo {
  return { known: new Map(), pending: new Map() };
}

/** Remember a signature read elsewhere, unless the path is already known. */
export function rememberSignature(
  memo: SignatureMemo,
  file: string,
  signature: FileSignature | undefined,
): void {
  if (!memo.known.has(file)) memo.known.set(file, signature);
}

export async function signatureOf(
  memo: SignatureMemo,
  file: string,
): Promise<FileSignature | undefined> {
  if (memo.known.has(file)) return memo.known.get(file);
  let pending = memo.pending.get(file);
  if (!pending) {
    pending = readSignature(file).then((signature) => {
      memo.known.set(file, signature);
      return signature;
    });
    memo.pending.set(file, pending);
  }
  return pending;
}

/**
 * {@link signatureOf} without waiting. One blocking stat is cheaper than a
 * round trip to the thread pool on a local disk; callers switch to the
 * waiting form when the disk is slow (see `Collector.validate`).
 */
export function signatureOfSync(
  memo: SignatureMemo,
  file: string,
): FileSignature | undefined {
  if (memo.known.has(file)) return memo.known.get(file);
  let signature: FileSignature | undefined;
  try {
    signature = readSignatureSync(file);
  } catch {
    signature = undefined;
  }
  memo.known.set(file, signature);
  return signature;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight; results
 * keep the order of `items`. The first rejection is rethrown after the
 * running workers settled.
 */
export async function mapPool<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  results.length = items.length;
  let next = 0;
  let failure: { readonly cause: unknown } | undefined;
  const run = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (cause) {
        failure ??= { cause };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  if (failure) throw failure.cause;
  return results;
}
