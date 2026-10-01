import { locales, type Locale } from "anhur/generated";

/** True when `value` is one of the configured content locales. */
export function isLocale(value: string): value is Locale {
  return locales.some((locale) => locale === value);
}
