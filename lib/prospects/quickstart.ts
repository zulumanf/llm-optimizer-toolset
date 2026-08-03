/**
 * One-click market quick-start (spec 040/032 composition): install a city
 * pack's geography into the markets tree and open a launch on the city —
 * the two-step prerequisite dance ("markets exist elsewhere, then a launch
 * here") collapsed into the single obvious action the prospecting flow
 * starts with.
 */
import { z } from "zod";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import type { CurrentUser } from "@/lib/auth";
import { installMarketPack } from "@/lib/markets/install";
import { getMarketPack } from "@/lib/markets/packs";
import { createLaunch } from "@/lib/prospects/service";

export async function quickStartLaunch(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ launchId: string; cityName: string }>> {
  const parsed = z
    .object({
      packKey: z.string().min(1),
      priceSegment: z.string().trim().max(120).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A market pack is required."));
  }
  const pack = getMarketPack(parsed.data.packKey);
  if (!pack) {
    return fail(new ClassifiedError("not_found", `Unknown market pack "${parsed.data.packKey}".`));
  }
  const installed = await installMarketPack(user, { packKey: pack.key });
  if (!installed.ok) return installed;
  if (!installed.data.cityMarketId) {
    return fail(new ClassifiedError("internal", "The pack installed but its city node was not found."));
  }
  const segment = parsed.data.priceSegment ?? "luxury";
  const launch = await createLaunch(user, {
    name: `${pack.cityName} — ${segment} residential`,
    marketId: installed.data.cityMarketId,
    priceSegment: segment,
    serviceCategory: "residential brokerage",
  });
  if (!launch.ok) {
    // A second quick-start on the same pack trips the launch-name unique —
    // surface it as "already started", which is what it means.
    if (launch.error.kind === "conflict") {
      return fail(
        new ClassifiedError(
          "conflict",
          `A "${pack.cityName} — ${segment} residential" launch already exists — you're already started; add prospects to it below.`
        )
      );
    }
    return launch;
  }
  return ok({ launchId: launch.data.launchId, cityName: pack.cityName });
}
