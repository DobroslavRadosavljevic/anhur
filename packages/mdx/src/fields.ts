import {
  defineField,
  type FieldContext,
  type FieldInput,
} from "@anhur/core/plugin";
import { z } from "zod";
import { optionsCacheKey } from "./cache-key";
import {
  COMPILER_VERSION,
  compileMdx,
  compileMdxWithHeadings,
} from "./compile";
import {
  MDX_PLUGIN,
  assertSupportedOptions,
  bodyShareKey,
  resolveOptions,
  type MdxOptions,
} from "./plugin";

function isString(value: FieldInput): value is string {
  return typeof value === "string";
}

function cacheOf(field: MdxOptions) {
  return {
    version: `mdx-3;${COMPILER_VERSION}`,
    key: (context: FieldContext) =>
      optionsCacheKey(resolveOptions(context, field), context),
  };
}

/**
 * The document body compiled to an MDX function body. Render it with
 * `<MdxContent code={doc.body} />` from `@anhur/mdx/react`. Needs `mdx()` in
 * `plugins`.
 */
export function body(options: MdxOptions = {}): z.ZodString {
  assertSupportedOptions(options, "m.body()");
  return defineField(z.string(), {
    kind: "mdx",
    requires: MDX_PLUGIN,
    whenAbsent: "compile",
    cache: cacheOf(options),
    shares: (context: FieldContext) => [
      bodyShareKey(resolveOptions(context, options), context),
    ],
    compile: async (input: FieldInput, context: FieldContext) => {
      if (input !== undefined && input !== null) {
        throw new Error(
          "m.body() is compiled from the document body; remove this key from the file, or use m.mdx() for an MDX field.",
        );
      }
      const resolved = resolveOptions(context, options);
      // Shared with `s.toc()`, which reads the headings of this compile.
      const compiled = await context.share(
        bodyShareKey(resolved, context),
        (shared) => compileMdxWithHeadings(shared.body ?? "", resolved, shared),
      );
      return compiled.code;
    },
  });
}

/**
 * An MDX string field compiled to a function body (always MDX syntax, also
 * in `.md` files, unless `format` is set). A missing key stays missing.
 */
export function mdxField(options: MdxOptions = {}): z.ZodString {
  assertSupportedOptions(options, "m.mdx()");
  return defineField(z.string(), {
    kind: "mdx",
    requires: MDX_PLUGIN,
    whenAbsent: "skip",
    cache: cacheOf(options),
    compile: (input: FieldInput, context: FieldContext) => {
      if (!isString(input)) throw new Error("m.mdx() needs a string.");
      return compileMdx(
        input,
        resolveOptions(context, options),
        context,
        "field",
      );
    },
  });
}

/**
 * MDX field helpers. Import as `import { schema as m } from "@anhur/mdx"`.
 *
 * - `m.body()` — the document body
 * - `m.mdx()` — an MDX string field
 */
export const schema = {
  body,
  mdx: mdxField,
};
