/** Renders one or more JSON-LD objects. `<` is escaped so page data can never
 * close the script tag (the standard JSON-in-HTML injection guard). */
import type { JsonLdObject } from "@/lib/marketing/seo";

export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function JsonLd({ data }: { data: JsonLdObject | JsonLdObject[] }) {
  return (
    <script
      type="application/ld+json"
      // JSON-LD is data for crawlers, not markup; serialized with `<` escaped.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
