/** Insert web-agent-verified contacts (each email confirmed verbatim on the cited public page, 2026-08-26). */
import "dotenv/config";
import { sql } from "@/db/client";
import { addContact } from "@/lib/prospects/service";
import type { CurrentUser } from "@/lib/auth";
const ROWS: [string, string, string, string][] = [
  ["Jenn Klarman","jklarman@lnf.com","Jenn Klarman","https://www.compass.com/listing/3906-river-club-drive-edgewater-md-21037/238495838043656017/"],
  ["Jack Shoptaw","jack.shoptaw@c21nm.com","Jack Shoptaw","https://www.c21nm.com/agents/jack-shoptaw/"],
  ["Melissa Murray","melissa.murray@compass.com","Melissa Murray","https://www.compass.com/agents/melissa-murray/"],
  ["Liz Montaner","EMontaner@cbmove.com","Liz Montaner","https://letsmovecrew.com/"],
  ["Shane Hall","shane.hall@compass.com","Shane Hall","https://www.compass.com/agents/shane-hall/"],
  ["Dee Dee Miller","deedee@deedeemiller.com","Dee Dee Miller","https://www.compass.com/listing/2601-compass-drive-annapolis-md-21401/1870016764859119705/"],
  ["Robert Lucido","Bob@BobLucidoTeam.com","Bob Lucido","https://www.boblucidoteam.com/boblucido"],
  ["Maria Depasquale","mdepasquale@corcoranss.com","Maria DePasquale","https://mariadepasquale.sites.corcorangroup.com/profile/my-bio"],
  ["Kimberly A Rizk","krizk@callawayhenderson.com","Kimberly Rizk","https://www.compass.com/homedetails/75-Hardy-Dr-Princeton-NJ-08540/1692724224372362353_lid/"],
  ["Charlie Wu","contact@thewuteam.com","Charlie Wu","https://thewuteam.com/"],
  ["Seth Davidson","davidson.seth@gmail.com","Seth Davidson","https://bhgrc.com/directory/agents/seth-davidson"],
  ["Yael Lax Zakut","yael.zakut@compass.com","Yael Zakut","https://www.compass.com/agents/yael-zakut/"],
  ["Lisa Patterson","lisa@danielravenelsir.com","Lisa Patterson","https://lisa-patterson.com/about"],
  ["Jennifer Lepage","jennifer.lepage@agentownedrealty.com","Jennifer LePage","https://agentowned.com/agents/Jennifer-LePage/8488619"],
  ["Matt O'Neill Team","matto@mattoneillteam.com","Matt O'Neill","https://my.flexmls.com/mattoneill"],
  ["Kim Boerman","kim.boerman@agentownedrealty.com","Kim Boerman","https://agentowned.com/agents/Kim-Boerman/8488670"],
  ["Michael Dew","michael.dew@agentownedrealty.com","Michael Dew","https://agentowned.com/agents/Michael-Dew/8488726"],
  ["Mcintosh Realty Team","sales@mcintoshrealtyteam.com","McIntosh Realty Team","https://mcintoshrealtyteam.com/"],
  ["Saikin Team","pavels@corcoranss.com","Pavel Saikin","https://www.corcoran.com/real-estate-agents/detail/pavel-saikin/120252/regionId/130"],
  ["Leilani Chin","lchin@corcoranss.com","Leilani Chin","https://www.corcoran.com/real-estate-agents/detail/leilani-chin/116853/regionId/130"],
  ["Corcoran Sawyer Smith","mgulick@corcoranss.com","Megan Gulick","https://www.corcoran.com/real-estate-agents/detail/agent/megan-gulick/9647"],
];
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  let ok = 0;
  for (const [biz, email, name, url] of ROWS) {
    const [p] = await sql`select id from prospects where business_name = ${biz} and archived_at is null`;
    if (!p) { console.log(`NOTFOUND ${biz}`); continue; }
    const r = await addContact(user, { prospectId: p.id, name, email, isPrimary: true,
      provenance: "publicly_sourced", notes: `email verified verbatim at ${url} (web research 2026-08-26)` });
    if (r.ok) ok++; else console.log(`FAIL ${biz}: ${r.error.message}`);
  }
  console.log(`${ok}/${ROWS.length} contacts added`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
