/**
 * Market-pack installer (spec 040): materializes a pack's geography into the
 * exclusivity `markets` tree — the ONE hierarchy — idempotently. A node is
 * matched under its parent by lower(name) or alias intersection; matches get
 * their aliases merged, misses are created. Re-install duplicates nothing;
 * cross-pack shared ancestors ("United States") converge on one row.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { getMarketPack } from "@/lib/markets/packs";
import type { GeoNode } from "@/lib/markets/types";

export interface InstallResult {
  packKey: string;
  version: number;
  rootMarketId: string;
  /** City-node id — the market a launch would target. */
  cityMarketId: string | null;
  created: number;
  matched: number;
}

async function upsertNode(
  tx: TransactionSql,
  node: GeoNode,
  parentId: string | null,
  userId: string,
  counters: { created: number; matched: number }
): Promise<string> {
  const aliases = node.aliases ?? [];
  const candidates = [node.name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())];
  const [existing] = await tx`
    select id, aliases from markets
    where (parent_id = ${parentId} or (parent_id is null and ${parentId}::uuid is null))
      and (lower(name) = any(${candidates})
        or exists (
          select 1 from unnest(aliases) a where lower(a) = any(${candidates})
        ))
    limit 1
  `;
  if (existing) {
    counters.matched += 1;
    const current = (existing.aliases as string[]) ?? [];
    const merged = [...current];
    for (const alias of aliases) {
      if (!merged.some((a) => a.toLowerCase() === alias.toLowerCase())) merged.push(alias);
    }
    if (merged.length !== current.length) {
      await tx`update markets set aliases = ${merged} where id = ${existing.id}`;
    }
    return existing.id as string;
  }
  counters.created += 1;
  const [row] = await tx`
    insert into markets (name, kind, parent_id, aliases, created_by)
    values (${node.name}, ${node.kind}, ${parentId}, ${aliases}, ${userId})
    returning id
  `;
  return row?.id as string;
}

export async function installMarketPack(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<InstallResult>> {
  const parsed = z.object({ packKey: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A pack key is required."));
  }
  const pack = getMarketPack(parsed.data.packKey);
  if (!pack) {
    return fail(new ClassifiedError("not_found", `Unknown market pack "${parsed.data.packKey}".`));
  }
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const counters = { created: 0, matched: 0 };
      let cityMarketId: string | null = null;
      const walk = async (node: GeoNode, parentId: string | null): Promise<string> => {
        const id = await upsertNode(tx, node, parentId, user.id, counters);
        if (node.kind === "city" && node.name === pack.cityName) cityMarketId = id;
        for (const child of node.children ?? []) await walk(child, id);
        return id;
      };
      const rootMarketId = await walk(pack.hierarchy, null);
      await tx`
        insert into market_pack_installs (pack_key, version, root_market_id, definition, installed_by)
        values (${pack.key}, ${pack.version}, ${rootMarketId},
          ${tx.json(pack as never)}, ${user.id})
        on conflict (pack_key, version) do update set
          root_market_id = excluded.root_market_id,
          definition = excluded.definition,
          installed_by = excluded.installed_by,
          installed_at = now()
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "market_pack.install",
        entity: "market",
        entityId: rootMarketId,
        detail: {
          packKey: pack.key,
          version: pack.version,
          created: counters.created,
          matched: counters.matched,
        },
      });
      return {
        packKey: pack.key,
        version: pack.version,
        rootMarketId,
        cityMarketId,
        ...counters,
      };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
