import { type Locale } from "anhur/generated";

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "de";
}
