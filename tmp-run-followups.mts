/** One-shot prod follow-ups (spec 086 + 088): run AFTER migrations 081-083
 * are applied. 1) enqueue technical_scan for JC Luxury Group via the real
 * service; 2) reclassify-sources runs separately (existing script). */
import "dotenv/config";
import { sql } from "@/db/client";
import { systemUser } from "@/lib/auth";
import { requestTechnicalScan } from "@/lib/discoverability/service";

const JC_PROJECT = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";
const user = await systemUser();
const result = await requestTechnicalScan(user, { projectId: JC_PROJECT });
if (!result.ok) throw new Error(result.error.message);
console.log("technical_scan queued for JC Luxury Group");
await sql.end();
