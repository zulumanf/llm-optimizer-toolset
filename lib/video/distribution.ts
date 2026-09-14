/**
 * Distribution (spec 138) is separate from creation. The canonical MP4 is
 * the artifact; an adapter publishes a reference to it. V1 ships the
 * storage-backed adapter (served later through the private report's
 * session gate). Unlisted YouTube is declared, labelled SHAREABLE_BY_LINK
 * (never "private"), and refuses until credentials exist.
 */
import { ClassifiedError } from "@/lib/errors";
import type { VideoDistributionKind } from "@/lib/video/constants";

export type DistributionVisibility = "ACCESS_GATED" | "SHAREABLE_BY_LINK";
export interface DistributionResult { kind: VideoDistributionKind; visibility: DistributionVisibility; reference: string; url: string | null }
export interface DistributionAdapter {
  kind: VideoDistributionKind;
  visibility: DistributionVisibility;
  configured(env: Record<string, string | undefined>): boolean;
  /** Can a prospect actually reach what `publish` produced from THIS
   * deployment? Local storage on a worker without a shared, durable volume
   * is a canonical artifact the web app cannot serve — release fails closed
   * until the operator asserts otherwise. */
  deliverable(env: Record<string, string | undefined>): { ok: boolean; detail: string };
  publish(a: { artifactId: string; storageKey: string; sha256: string; path: string }, env: Record<string, string | undefined>): Promise<DistributionResult>;
}

export const localStorageDistribution: DistributionAdapter = {
  kind: "local_storage",
  visibility: "ACCESS_GATED",
  configured: () => true,
  deliverable: (env) =>
    env.NODE_ENV !== "production" || env.VIDEO_LOCAL_STORAGE_SERVABLE === "true"
      ? { ok: true, detail: env.NODE_ENV === "production" ? "VIDEO_LOCAL_STORAGE_SERVABLE asserted by the operator" : "non-production" }
      : { ok: false, detail: "local_storage on this deployment is worker-local and ephemeral; set VIDEO_LOCAL_STORAGE_SERVABLE=true only once the evidence root is a shared durable volume the web app serves" },
  async publish(a) {
    return { kind: "local_storage", visibility: "ACCESS_GATED", reference: a.storageKey, url: null };
  },
};

export const unlistedYouTubeDistribution: DistributionAdapter = {
  kind: "unlisted_youtube",
  visibility: "SHAREABLE_BY_LINK",
  configured: (env) => Boolean(env.YOUTUBE_OAUTH_REFRESH_TOKEN && env.YOUTUBE_OAUTH_CLIENT_ID && env.YOUTUBE_OAUTH_CLIENT_SECRET),
  deliverable: () => ({ ok: false, detail: "unlisted YouTube upload is not implemented" }),
  async publish() {
    throw new ClassifiedError("validation", "Unlisted YouTube upload is not implemented; canonical MP4 remains valid.");
  },
};

const ADAPTERS: Record<VideoDistributionKind, DistributionAdapter> = { local_storage: localStorageDistribution, unlisted_youtube: unlistedYouTubeDistribution };
export function distributionAdapter(kind: VideoDistributionKind): DistributionAdapter { return ADAPTERS[kind]; }
