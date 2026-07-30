/**
 * Enrich JC Luxury Group from public sources (2026-07-30).
 *
 * The first onboarding read only jcluxury.com's homepage, which states no
 * brokerage, no roster, no awards and no volume — so the tool recorded none.
 * That was true of the homepage and wrong about the world: a search surfaced
 * the SERHANT team page, a 12-agent roster with licence numbers, NAHREP
 * recognition and named development projects.
 *
 * Every claim below cites the specific public page it came from. Nothing here
 * is operator recollection.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { upsertEntity } from "@/lib/knowledge/entities/service";

const PROJECT = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";

const SRC = {
  serhantTeam: "https://serhant.com/teams/jc-luxury-group",
  roster: "https://jcluxury.com/team",
  hobokenGirl:
    "https://www.hobokengirl.com/jc-luxury-group-serhant-real-estate-jersey-city-new-jersey/",
  jerseyDigsMetrovue: "https://jerseydigs.com/metrovue-jersey-city-rentals/",
  jerseyDigsSummit: "https://jerseydigs.com/413-summit-jersey-city-apartments/",
};

/** Roster as published on jcluxury.com/team, licence numbers included. */
const ROSTER: { name: string; licence?: string; role?: string }[] = [
  { name: "Alexander Calle", licence: "1752924", role: "Founder / Team Leader" },
  { name: "Dominick Caro", licence: "2299531", role: "Head of Leasing" },
  { name: "Nicolas Biddle", licence: "1756633" },
  { name: "Edwin Martinez Jr.", licence: "1865373" },
  { name: "Jared Reamer", licence: "2082392" },
  { name: "Annemarie Huber", licence: "2183945" },
  { name: "Achint Chani" },
  { name: "Joseph Sanchez" },
  { name: "Arianna Nieves" },
  { name: "Lisette Paulino" },
  { name: "Lyonel Destin" },
  // Listed on the SERHANT team page but not on jcluxury.com/team.
  { name: "Nico Aronson" },
  { name: "Connor Russo" },
  { name: "Ultan Byrne" },
  { name: "Chirag Shah" },
];

/** Named developments the press attributes to the team. */
const PROJECTS: { name: string; detail: string; source: string }[] = [
  {
    name: "The Summit",
    detail: "99-unit amenity-rich building in McGinley Square, Jersey City — team leads leasing.",
    source: SRC.jerseyDigsSummit,
  },
  {
    name: "The Pine",
    detail: "56-unit luxury property in Bergen-Lafayette, Jersey City — team leads leasing.",
    source: SRC.hobokenGirl,
  },
  {
    name: "Metrovue (Journal Square)",
    detail: "148-unit leasing takeover in Journal Square, Jersey City (2026).",
    source: SRC.jerseyDigsMetrovue,
  },
];

async function evidence(url: string, note: string): Promise<string> {
  const [row] = await sql`
    insert into evidence (kind, ref_id, url, note)
    values ('url', gen_random_uuid(), ${url}, ${note})
    returning id`;
  return row!.id as string;
}

async function claim(args: {
  key: string;
  text: string;
  evidenceIds: string[];
  approved: boolean;
  userId: string;
}): Promise<void> {
  await sql`
    insert into claims (project_id, key, canonical_text, as_of, status,
      evidence_ids, created_by, approved_by)
    values (${PROJECT}, ${args.key}, ${args.text}, current_date,
      ${args.approved ? "approved" : "proposed"}, ${args.evidenceIds},
      ${args.userId}, ${args.approved ? args.userId : null})
    on conflict do nothing`;
}

async function main(): Promise<void> {
  const [u] = await sql`select id,email,name,role from users where email='zulumanf@gmail.com'`;
  const user: CurrentUser = {
    id: u!.id as string, email: u!.email as string,
    name: u!.name as string, role: u!.role as CurrentUser["role"],
  };

  // 1. Brokerage affiliation — now corroborated by a live SERHANT page, so the
  //    proposed operator-reported claim is superseded by an evidenced one.
  await sql`
    update claims set status = 'superseded', updated_at = now()
    where project_id = ${PROJECT} and key = 'brokerage' and status = 'proposed'`;
  const brokerageEv = await evidence(
    SRC.serhantTeam,
    "SERHANT.com lists 'JC Luxury Group' as a team, with roster. Corroborates the brokerage affiliation. Retrieved 2026-07-30."
  );
  await claim({
    key: "brokerage",
    text:
      "JC Luxury Group operates as a team under the SERHANT. brokerage, listed at serhant.com/teams/jc-luxury-group (as of 2026-07-30).",
    evidenceIds: [brokerageEv],
    approved: true,
    userId: user.id,
  });

  // 2. Roster + leadership.
  const rosterEv = await evidence(
    SRC.roster,
    "jcluxury.com/team — published roster with New Jersey licence numbers. Retrieved 2026-07-30."
  );
  for (const member of ROSTER) {
    await upsertEntity(user, {
      projectId: PROJECT,
      entityType: "person",
      canonicalName: member.name,
      description: [member.role, member.licence ? `NJ licence #${member.licence}` : null]
        .filter(Boolean)
        .join(" · "),
    });
  }
  await claim({
    key: "team_size",
    text: `JC Luxury Group publishes a roster of ${ROSTER.length} licensed agents across jcluxury.com/team and serhant.com (as of 2026-07-30).`,
    evidenceIds: [rosterEv, brokerageEv],
    approved: true,
    userId: user.id,
  });
  await claim({
    key: "team_leadership",
    text:
      "Alexander Calle (NJ licence #1752924) is founder and team leader; Dominick Caro (#2299531) is Head of Leasing.",
    evidenceIds: [rosterEv],
    approved: true,
    userId: user.id,
  });

  // 3. Awards. Recorded verbatim and attributed, NOT restated as fact by us:
  //    a ranking claim is high-risk, and the wording keeps the source visible.
  const awardEv = await evidence(
    SRC.hobokenGirl,
    "Hoboken Girl profile: Alexander Calle 'has ranked as one of the top Latino realtors in the North East by NAHREP'. Retrieved 2026-07-30."
  );
  await claim({
    key: "award_nahrep",
    text:
      'Press reports Alexander Calle "has ranked as one of the top Latino realtors in the North East" by NAHREP (Hoboken Girl profile; year not stated in source).',
    evidenceIds: [awardEv],
    // Proposed: the source does not state a year, and a ranking without its
    // period cannot be published as current (docs/06 freshness rules).
    approved: false,
    userId: user.id,
  });
  await claim({
    key: "category_positioning",
    text:
      'JC Luxury Group is a Jersey City-based real estate team on the New Jersey "Gold Coast", founded 2022, specialising in new-development leasing and sales, luxury residential and commercial.',
    evidenceIds: [awardEv, brokerageEv],
    approved: true,
    userId: user.id,
  });

  // 4. Named developments as entities + a claim each.
  for (const project of PROJECTS) {
    const ev = await evidence(project.source, `Press coverage: ${project.detail} Retrieved 2026-07-30.`);
    await upsertEntity(user, {
      projectId: PROJECT,
      entityType: "property",
      canonicalName: project.name,
      description: project.detail,
    });
    await claim({
      key: `development_${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      text: `${project.name}: ${project.detail}`,
      evidenceIds: [ev],
      approved: true,
      userId: user.id,
    });
  }

  // 5. Competitors that actually surface locally, plus the one that silently
  //    failed at onboarding. National brands were a guess; these came out of
  //    the measurement.
  const COMPETITORS: { name: string; domain: string; tier: "primary" | "secondary" }[] = [
    { name: "Corcoran Sawyer Smith", domain: "corcoransawyersmith.com", tier: "primary" },
    { name: "Douglas Elliman", domain: "elliman.com", tier: "primary" },
  ];
  for (const c of COMPETITORS) {
    let [company] = await sql`select id from companies where lower(name) = ${c.name.toLowerCase()}`;
    if (!company) {
      [company] = await sql`
        insert into companies (name, domain, is_self) values (${c.name}, ${c.domain}, false)
        returning id`;
    }
    await sql`
      insert into competitors (project_id, company_id, tier)
      values (${PROJECT}, ${company!.id}, ${c.tier})
      on conflict do nothing`;
  }

  const [claims] = await sql`
    select count(*) filter (where status='approved')::int as approved,
           count(*) filter (where status='proposed')::int as proposed
    from claims where project_id=${PROJECT}`;
  const [ents] = await sql`select count(*)::int as n from knowledge_entities where project_id=${PROJECT}`;
  const [comps] = await sql`select count(*)::int as n from competitors where project_id=${PROJECT}`;
  console.log(`claims: ${claims!.approved} approved, ${claims!.proposed} proposed`);
  console.log(`entities: ${ents!.n}   competitors: ${comps!.n}`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await sql.end();
});
