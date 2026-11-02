import { Predicate } from "effect";
import type {
  AnyContent,
  ScopeContext,
  TransformDocument,
} from "../define/types";
import { errorDiagnostic, messageOf, type Diagnostic } from "../diagnostics";
import { toExport } from "./list-rows";
import { describeValue } from "./transform";
import type { ResolvedScope } from "./resolve";
import type { FinalDocument, SourceDocuments } from "./types";

/**
 * The document a `where` callback gets, by final document. Final documents
 * are frozen and stay the same object while their file does not change, so
 * a rebuild reuses the exports of every document it did not touch.
 */
const exports = new WeakMap<FinalDocument, TransformDocument>();

function exportOf(document: FinalDocument): TransformDocument {
  let exported = exports.get(document);
  if (!exported) {
    exported = toExport(document);
    exports.set(document, exported);
  }
  return exported;
}

/** The documents one scope keeps, and the problems its callbacks had. */
export type ScopedSources = {
  readonly sources: SourceDocuments<FinalDocument>[];
  readonly diagnostics: readonly Diagnostic[];
};

/**
 * Applies the `where` callbacks of a scope to the documents of a build.
 * Each source gets a new group with a new array, so the stages after this
 * one (references replace the array) never touch the main output's groups.
 * A callback that throws or returns something other than a boolean is an
 * error on that document.
 */
export function scopeSources(
  scope: ResolvedScope,
  sources: readonly SourceDocuments<FinalDocument>[],
  defaultLocale: string | undefined,
): ScopedSources {
  const diagnostics: Diagnostic[] = [];
  const byName = new Map(sources.map((group) => [group.source.name, group]));
  const exportsByName = new Map<string, readonly TransformDocument[]>();
  const exportsOf = (name: string): readonly TransformDocument[] => {
    let list = exportsByName.get(name);
    if (!list) {
      const group = byName.get(name);
      if (!group) {
        throw new Error(
          `documents(): "${name}" is not a collection or singleton of this config.`,
        );
      }
      list = Object.freeze(group.documents.map(exportOf));
      exportsByName.set(name, list);
    }
    return list;
  };
  const context: ScopeContext = {
    scope: scope.name,
    documents: (source: AnyContent | string) =>
      exportsOf(typeof source === "string" ? source : source.name),
  };
  const scoped = sources.map((group): SourceDocuments<FinalDocument> => {
    const filter = scope.where.get(group.source.name);
    if (!filter)
      return { source: group.source, documents: [...group.documents] };
    const exported = exportsOf(group.source.name);
    const documents = group.documents.filter((document, index) => {
      const failed = (message: string, cause?: unknown) => {
        diagnostics.push(
          errorDiagnostic("scope-failed", message, {
            file: document.file.absPath,
            source: group.source.name,
            cause,
          }),
        );
        return false;
      };
      let keep: unknown;
      try {
        keep = filter(exported[index], context);
      } catch (cause) {
        return failed(
          `Scope "${scope.name}": where.${group.source.name} threw: ${messageOf(cause)}`,
          cause,
        );
      }
      if (!Predicate.isBoolean(keep)) {
        return failed(
          `Scope "${scope.name}": where.${group.source.name} must return true or false, got ${describeValue(keep)}.`,
        );
      }
      return keep;
    });
    // `settings` (the default-locale document) is typed as always there,
    // unless the singleton is optional: a scope may drop other locales only.
    if (
      group.source.kind === "singleton" &&
      group.source.definition.optional !== true
    ) {
      const isDefault = (document: FinalDocument) =>
        !group.source.localized || document.file.locale === defaultLocale;
      const main = group.documents.find(isDefault);
      if (main && !documents.some(isDefault)) {
        diagnostics.push(
          errorDiagnostic(
            "scope-failed",
            `Scope "${scope.name}" leaves out ${group.source.localized ? `the ${defaultLocale} document` : "the document"} of singleton "${group.source.name}", which its output always has.`,
            {
              file: main.file.absPath,
              source: group.source.name,
              hint: "Keep that document in the scope, or set optional: true on the singleton.",
            },
          ),
        );
      }
    }
    return { source: group.source, documents };
  });
  return { sources: scoped, diagnostics };
}

/** Names the scope in each problem of one of its build stages. */
export function inScope(
  name: string,
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.message.startsWith(`Scope "${name}"`)
      ? diagnostic
      : {
          ...diagnostic,
          message: `Scope "${name}": ${diagnostic.message}`,
          hint:
            diagnostic.code === "reference-failed"
              ? `${diagnostic.hint ? `${diagnostic.hint} ` : ""}The target may be a document this scope leaves out: keep it in the scope, or leave out the documents that point to it.`
              : diagnostic.hint,
        },
  );
}
