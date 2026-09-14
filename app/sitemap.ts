/** Sitemap of every registered public page — the page registry is the only
 * source, so a page cannot be public without being listed. */
import type { MetadataRoute } from "next";
import { publicPageUrls } from "@/lib/marketing/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPageUrls().map((p) => ({
    url: p.url,
    lastModified: p.updated,
    changeFrequency: p.section === "research" ? "monthly" : "weekly",
    priority: p.url.endsWith("/") ? 1 : p.section === "research" ? 0.8 : 0.7,
  }));
}
