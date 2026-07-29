/**
 * Search-citation extraction from immutable raw payloads (all providers).
 * When a provider searched the web before answering, its payload names the
 * actual retrieval sources — the ground truth for "which pages feed the
 * answers", far stronger than URLs embedded in answer text. Extraction runs
 * at read time from raw_payload, so it works retroactively on every capture.
 *
 * Shapes handled (openai verified live 2026-07-28; others per API docs, to
 * be re-verified when those providers get keys):
 * - openai Responses API: output[].content[].annotations[] type=url_citation
 * - openai chat completions (gpt-*-search-api): choices[].message.annotations[]
 * - perplexity: citations[] (strings) and search_results[] ({url,title})
 * - anthropic: content[].citations[] ({url,title}) from the web_search tool
 * - google: candidates[].groundingMetadata.groundingChunks[].web.{uri,title}
 */
import { urlDomain } from "@/lib/parsing/prepass";
import type { ProviderId } from "@/lib/ai/types";

export interface SearchCitation {
  url: string;
  title: string | null;
  domain: string;
}

/** Strip provider tracking params (OpenAI appends ?utm_source=openai). */
function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete("utm_source");
    const s = url.toString();
    return s.endsWith("?") ? s.slice(0, -1) : s;
  } catch {
    return raw;
  }
}

function push(
  out: SearchCitation[],
  seen: Set<string>,
  rawUrl: unknown,
  title: unknown
): void {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return;
  const url = cleanUrl(rawUrl);
  const domain = urlDomain(url);
  if (!domain || seen.has(url)) return;
  seen.add(url);
  out.push({ url, title: typeof title === "string" ? title : null, domain });
}

// Loosely-typed payload walking: payloads are foreign JSON — every access is
// guarded, unknown shapes yield [] rather than throwing
/* eslint-disable @typescript-eslint/no-explicit-any */
export function extractCitations(
  provider: ProviderId | string,
  rawPayload: unknown
): SearchCitation[] {
  const out: SearchCitation[] = [];
  const seen = new Set<string>();
  const payload = rawPayload as any;
  if (!payload || typeof payload !== "object") return out;

  try {
    if (provider === "openai") {
      for (const item of payload.output ?? []) {
        for (const content of item?.content ?? []) {
          for (const ann of content?.annotations ?? []) {
            if (ann?.type === "url_citation") push(out, seen, ann.url, ann.title);
          }
        }
      }
      for (const choice of payload.choices ?? []) {
        for (const ann of choice?.message?.annotations ?? []) {
          if (ann?.type === "url_citation") {
            push(out, seen, ann.url_citation?.url ?? ann.url, ann.url_citation?.title ?? ann.title);
          }
        }
      }
    } else if (provider === "perplexity") {
      for (const url of payload.citations ?? []) push(out, seen, url, null);
      for (const result of payload.search_results ?? []) {
        push(out, seen, result?.url, result?.title);
      }
    } else if (provider === "anthropic") {
      for (const block of payload.content ?? []) {
        for (const citation of block?.citations ?? []) {
          push(out, seen, citation?.url, citation?.title);
        }
        if (block?.type === "web_search_tool_result") {
          for (const result of Array.isArray(block.content) ? block.content : []) {
            push(out, seen, result?.url, result?.title);
          }
        }
      }
    } else if (provider === "google") {
      for (const candidate of payload.candidates ?? []) {
        for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
          push(out, seen, chunk?.web?.uri, chunk?.web?.title);
        }
      }
    }
  } catch {
    return out;
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
