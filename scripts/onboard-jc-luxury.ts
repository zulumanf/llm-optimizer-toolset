/**
 * One-off onboarding for a real prospect: JC Luxury Group (jcluxury.com).
 *
 * Every fact below is quoted or directly derived from the live site, captured
 * 2026-07-30, with the page itself as the evidence URL. Deliberately absent:
 * brokerage affiliation, sales volume, rankings and awards — the site states
 * none of those, and a prospect audit that invents them is worthless at best.
 *
 * Run with: npx tsx scripts/onboard-jc-luxury.ts
 */
import "dotenv/config";
import { onboardClient } from "@/lib/verticals/onboarding";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";

const SITE = "https://jcluxury.com/";

async function main(): Promise<void> {
  const [row] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!row) throw new Error("Operator user not found — provision it first.");
  const user: CurrentUser = {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as CurrentUser["role"],
  };

  const result = await onboardClient(user, {
    clientName: "JC Luxury Group",
    packKey: "real-estate-agent",
    company: {
      name: "JC Luxury Group",
      // Aliases matter: an AI answer naming "JC Luxury" without "Group" is
      // still a mention, and missing it would understate their visibility.
      aliases: ["JC Luxury", "JCLuxury", "JC Luxury Real Estate"],
      domain: "jcluxury.com",
    },
    // These drive which QUESTIONS we ask AI assistants — they are a
    // measurement scope, not claims about the client. Each is grounded in the
    // site ("buyers and sellers", luxury, new developments, commercial) rather
    // than in guesswork about who they wish they served.
    variables: {
      market: ["Jersey City", "Hoboken", "Upper Montclair"],
      neighborhood: ["Newport", "Paulus Hook", "Downtown Jersey City"],
      propertyType: ["luxury condo", "new development", "commercial property"],
      clientType: ["luxury buyers", "sellers", "investors"],
    },
    facts: [
      {
        key: "experience_years",
        text:
          'States "over 20 years of experience working with buyers and sellers at all stages of the process" (self-reported, as of 2026-07-30).',
        evidenceUrl: SITE,
      },
      {
        key: "office_address",
        text: "Office address is 525 Washington Blvd, Jersey City, NJ 07310.",
        evidenceUrl: SITE,
      },
      {
        key: "markets_served",
        text:
          "Serves the Tri-State area, naming Jersey City, Hoboken and Upper Montclair, NJ.",
        evidenceUrl: SITE,
      },
      {
        key: "specialties",
        text:
          "Specialises in luxury residential real estate, new developments, and commercial real estate.",
        evidenceUrl: SITE,
      },
      {
        key: "services",
        text:
          "Offers home buying and selling, home valuation, commercial real estate, and community information.",
        evidenceUrl: SITE,
      },
      {
        key: "contact_phone",
        text: "Publicly listed phone number is (917) 334-9663.",
        evidenceUrl: SITE,
      },
    ],
    // Brokerages known to operate in the Jersey City / Hoboken market. Seeded
    // as market context, NOT as a claim about who competes with whom — the
    // run reveals which of them AI assistants actually surface, and the gap
    // analysis is built on that observed retrieval rather than on this list.
    competitors: [
      { name: "Compass", domain: "compass.com", tier: "primary" },
      { name: "Douglas Elliman", domain: "elliman.com", tier: "primary" },
      { name: "Corcoran", domain: "corcoran.com", tier: "primary" },
      { name: "Prominent Properties Sotheby's International Realty", domain: "prominentproperties.com", tier: "secondary" },
      { name: "Keller Williams", domain: "kw.com", tier: "secondary" },
      { name: "Weichert Realtors", domain: "weichert.com", tier: "secondary" },
      { name: "RE/MAX", domain: "remax.com", tier: "secondary" },
    ],
  });

  if (!result.ok) {
    console.error("onboarding failed:", result.error.message);
    process.exitCode = 1;
    await sql.end();
    return;
  }

  const r = result.data;
  console.log("JC Luxury Group onboarded");
  console.log("  project:      ", r.projectId);
  console.log("  company:      ", r.companyId);
  console.log("  prompt set:   ", r.promptSetId, `(${r.promptsCreated} prompts)`);
  console.log("  claims:       ", r.claimsApproved);
  console.log("  competitors:  ", r.competitorsTracked);
  console.log("  pack version: ", r.packVersion);
  await sql.end();
}

main();
