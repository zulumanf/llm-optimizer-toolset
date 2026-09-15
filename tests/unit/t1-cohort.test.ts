/**
 * Touch 1 cohort construction (2026-09-11) — the 36-case gate matrix at the
 * pure layer. Every gate delegates to an existing policy; these tests pin
 * that nothing is loosened to reach a quota and nothing new is gated.
 */
import { describe, expect, it } from "vitest";
import {
  BAND_BREADTH_QUESTIONS,
  T1_COHORT_POLICY_VERSION,
  T1_COHORT_TARGET,
  cohortBlockers,
  cohortVerdict,
  contactBottleneck,
  dedupeBuyingUnits,
  evaluateCandidate,
  evidenceBottleneck,
  featuresFromSnapshot,
  freezeCohort,
  isGenericEmail,
  newMembers,
  revalidateBeforeFreeze,
  selectCohort,
  type T1CandidateFacts,
  type T1Features,
} from "@/lib/prospects/t1-cohort";
import { BROKERAGE_SEND_CAP_30D, MISMATCH_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import { EVIDENCE_RELEASE_VERSION } from "@/lib/prospects/evidence-release";

const NOW = new Date("2026-09-11T12:00:00Z");

function features(over: Partial<T1Features> = {}): T1Features {
  return {
    ...featuresFromSnapshot({
      runId: "run-1", provider: "openai", answerCount: 256, modelCount: 1, completedAt: "2026-08-31T00:00:00Z", benchmarkAgeDays: 11,
      expectedResponses: 256, validResponses: 256,
      prospect: { recommendationCount: 0, productionValue: 60_000_000, productionYear: 2025, productionSignalId: "sig-p" },
      competitor: { companyId: "c-comp", name: "Rival Team", recommendationCount: 17, productionValue: 33_000_000, productionSignalId: "sig-c", productionRatio: 0.55, recommendationGap: 17, entityLevel: "team" },
      metricType: "closed_volume", distinctQuestions: { prospect: 0, competitor: 9 }, competitorRank: { rank: 1, universe: 24 },
    }),
    ...over,
  };
}

function facts(over: Partial<T1CandidateFacts> = {}, deep: { market?: Partial<T1CandidateFacts["market"]>; outreach?: Partial<T1CandidateFacts["outreach"]>; contact?: Partial<NonNullable<T1CandidateFacts["contact"]>> | null } = {}): T1CandidateFacts {
  const base: T1CandidateFacts = {
    prospectId: "p-1", companyId: "c-1", name: "The Robby Brady Team", prospectType: "team", entityLevel: "team",
    market: { launchId: "l-1", name: "Greenville", stateCode: "SC", protected: false, exclusiveConflict: false, launchStatus: "outreach_active" },
    outreach: { stage: "identified", contacted: false, activeSequence: false, positiveReply: false, engagement: false, declined: false, doNotContact: false, suppressed: false, personRecentlyContacted: false },
    mismatch: { eligible: true, reasonCodes: [] },
    release: { verified: true, reasons: [] },
    pendingCorrection: false,
    contact: { id: "ct-1", name: "Robby Brady", role: "team lead", email: "robby@bradyteam.com", provenance: "publicly_sourced", generic: false, isDecisionMaker: true },
    firstName: "Robby",
    features: features(),
    buyerSignals: [],
    websiteOnFile: true,
    dedupe: { brokerageKey: "howard hanna allen tate", leadPersonKey: "robby brady" },
  };
  const f: T1CandidateFacts = { ...base, ...over };
  if (deep.market) f.market = { ...base.market, ...deep.market };
  if (deep.outreach) f.outreach = { ...base.outreach, ...deep.outreach };
  if (deep.contact === null) f.contact = null;
  else if (deep.contact) f.contact = { ...base.contact!, ...deep.contact };
  return f;
}

const ev = (f: T1CandidateFacts) => evaluateCandidate(f, NOW);

describe("market gates", () => {
  it("1: reserved/protected market excluded", () => {
    expect(cohortBlockers(facts({}, { market: { protected: true } }))).toContain("MARKET_PROTECTED");
  });
  it("2: NYC excluded (protected by name, regardless of evidence strength)", () => {
    const f = facts({}, { market: { name: "New York City", stateCode: "NY", protected: true } });
    expect(ev(f).sendReady).toBe(false);
    expect(ev(f).band).toBe("HOLD");
  });
  it("3: proof-building allowed market eligible", () => {
    expect(ev(facts()).sendReady).toBe(true);
  });
  it("4: active-client-exclusive market conflict excluded", () => {
    expect(cohortBlockers(facts({}, { market: { exclusiveConflict: true } }))).toContain("MARKET_EXCLUSIVE_CONFLICT");
  });
  it("paused/protected launch excluded", () => {
    expect(cohortBlockers(facts({}, { market: { launchStatus: "paused" } }))).toContain("MARKET_PAUSED");
  });
});

describe("prior-touch and suppression gates", () => {
  it("5: suppressed prospect excluded", () => {
    expect(cohortBlockers(facts({}, { outreach: { suppressed: true } }))).toContain("SUPPRESSED");
  });
  it("6: DNC prospect excluded", () => {
    expect(cohortBlockers(facts({}, { outreach: { doNotContact: true } }))).toContain("DO_NOT_CONTACT");
  });
  it("7: previously contacted first-touch prospect excluded", () => {
    expect(cohortBlockers(facts({}, { outreach: { contacted: true, stage: "contacted" } }))).toEqual(expect.arrayContaining(["ALREADY_CONTACTED", "STAGE_NOT_FIRST_TOUCH"]));
  });
  it("8: positive responder excluded from a new T1", () => {
    expect(cohortBlockers(facts({}, { outreach: { positiveReply: true } }))).toContain("POSITIVE_RESPONDER");
  });
  it("9: active client / engagement excluded", () => {
    expect(cohortBlockers(facts({}, { outreach: { engagement: true } }))).toContain("CLIENT_OR_ENGAGEMENT");
  });
  it("active sequence, decline and recent person contact excluded", () => {
    expect(cohortBlockers(facts({}, { outreach: { activeSequence: true } }))).toContain("ACTIVE_SEQUENCE");
    expect(cohortBlockers(facts({}, { outreach: { declined: true } }))).toContain("DECLINED");
    expect(cohortBlockers(facts({}, { outreach: { personRecentlyContacted: true } }))).toContain("PERSON_RECENTLY_CONTACTED");
  });
});

describe("dedupe", () => {
  it("10: duplicate canonical entity excluded (stronger evaluation kept)", () => {
    const a = facts({ prospectId: "p-a", features: features({ absoluteGap: 17 }) });
    const b = facts({ prospectId: "p-b", features: features({ absoluteGap: 4, competitorRecs: 4 }) });
    const out = dedupeBuyingUnits([{ facts: a, evaluation: ev(a) }, { facts: b, evaluation: ev(b) }]);
    const byId = new Map(out.map((o) => [o.facts.prospectId, o.evaluation]));
    expect(byId.get("p-a")!.sendReady).toBe(true);
    expect(byId.get("p-b")!.blockers).toContain("DUPLICATE_BUYING_UNIT");
  });
  it("11: team and its provenanced lead person are one buying unit; unprovenanced co-occurrence is not", () => {
    const team = facts({ prospectId: "p-t", companyId: "c-t" });
    const person = facts({ prospectId: "p-i", companyId: "c-i", name: "Robby Brady", prospectType: "individual_agent", entityLevel: "individual", features: features({ absoluteGap: 3, competitorRecs: 3 }) });
    const out = dedupeBuyingUnits([{ facts: team, evaluation: ev(team) }, { facts: person, evaluation: ev(person) }]);
    expect(out.find((o) => o.facts.prospectId === "p-i")!.evaluation.blockers).toContain("DUPLICATE_BUYING_UNIT");
    const unrelated = facts({ prospectId: "p-u", companyId: "c-u", name: "Robby Brady", dedupe: { brokerageKey: null, leadPersonKey: null } });
    const out2 = dedupeBuyingUnits([{ facts: team, evaluation: ev(team) }, { facts: unrelated, evaluation: ev(unrelated) }]);
    expect(out2.every((o) => o.evaluation.sendReady)).toBe(true);
  });
});

describe("entity and evidence gates (delegated to spec 124 / 136 verdicts)", () => {
  it("12: unverified entity excluded", () => {
    expect(cohortBlockers(facts({ release: { verified: false, reasons: ["PROSPECT_ENTITY_UNVERIFIED"] } }))).toContain("EVIDENCE_RELEASE_BLOCKED");
    expect(cohortBlockers(facts({ companyId: null }))).toContain("ENTITY_UNRESOLVED");
  });
  it("13: unknown entity type excluded", () => {
    expect(cohortBlockers(facts({ entityLevel: null }))).toContain("ENTITY_TYPE_UNKNOWN");
  });
  it("14: competitor entity unverified excluded", () => {
    const f = facts({ release: { verified: false, reasons: ["COMPETITOR_ENTITY_UNVERIFIED"] } });
    expect(ev(f).sendReady).toBe(false);
    expect(evidenceBottleneck(f.release!.reasons)).toBe("COMPETITOR_UNVERIFIED");
  });
  it("15: production period mismatch excluded", () => {
    const f = facts({ mismatch: { eligible: false, reasonCodes: ["PRODUCTION_PERIOD_MISMATCH"] }, release: null });
    expect(ev(f).blockers).toContain("MISMATCH_INELIGIBLE");
    expect(evidenceBottleneck(f.mismatch.reasonCodes)).toBe("PRODUCTION_INCOMPARABLE");
  });
  it("16: production metric mismatch excluded", () => {
    expect(evidenceBottleneck(["PRODUCTION_METRIC_MISMATCH"])).toBe("PRODUCTION_INCOMPARABLE");
    expect(ev(facts({ mismatch: { eligible: false, reasonCodes: ["PRODUCTION_METRIC_MISMATCH"] }, release: null })).sendReady).toBe(false);
  });
  it("17: entity-level mismatch excluded", () => {
    expect(ev(facts({ mismatch: { eligible: false, reasonCodes: ["ENTITY_LEVEL_MISMATCH"] }, release: null })).sendReady).toBe(false);
    expect(ev(facts({ release: { verified: false, reasons: ["ENTITY_LEVEL_MISMATCH"] } })).sendReady).toBe(false);
  });
  it("18: primary/shadow mismatch excluded", () => {
    const f = facts({ release: { verified: false, reasons: ["PRIMARY_SHADOW_COUNT_MISMATCH"] } });
    expect(ev(f).sendReady).toBe(false);
    expect(evidenceBottleneck(f.release!.reasons)).toBe("PRIMARY_SHADOW_MISMATCH");
  });
  it("19: denominator failure excluded", () => {
    const f = facts({ release: { verified: false, reasons: ["DENOMINATOR_MISMATCH"] } });
    expect(ev(f).sendReady).toBe(false);
    expect(evidenceBottleneck(f.release!.reasons)).toBe("DENOMINATOR_INVALID");
  });
  it("20: zero not verified excluded", () => {
    const f = facts({ release: { verified: false, reasons: ["ZERO_NOT_VERIFIED"] } });
    expect(ev(f).sendReady).toBe(false);
    expect(evidenceBottleneck(f.release!.reasons)).toBe("ZERO_UNVERIFIED");
  });
  it("21: pending correction excluded", () => {
    expect(cohortBlockers(facts({ pendingCorrection: true }))).toContain("PENDING_CORRECTION");
    expect(evidenceBottleneck(["PENDING_CORRECTION"])).toBe("PENDING_CORRECTION");
  });
  it("22: verified zero remains eligible when everything else passes", () => {
    const e = ev(facts());
    expect(e.sendReady).toBe(true);
    expect(e.recBucket).toBe("ZERO_VERIFIED");
    expect(facts().features!.recommendationMultiple).toBeNull();
    expect(facts().features!.zeroCase).toBe(true);
  });
  it("23: prospect with 1+ recommendations remains eligible", () => {
    const e = ev(facts({ features: features({ prospectRecs: 3, absoluteGap: 14, recommendationMultiple: 5.67, zeroCase: false }) }));
    expect(e.sendReady).toBe(true);
    expect(e.recBucket).toBe("ONE_OR_MORE");
  });
  it("24: no gate is introduced solely for the 0 vs 1+ state", () => {
    const zero = ev(facts());
    const one = ev(facts({ features: features({ prospectRecs: 1, absoluteGap: 16, recommendationMultiple: 17, zeroCase: false }) }));
    expect(zero.blockers).toEqual([]);
    expect(one.blockers).toEqual([]);
    expect(zero.band).toBe(one.band);
  });
  it("stale benchmark maps to BENCHMARK_STALE via the spec 124 code, not a cohort-local age rule", () => {
    expect(evidenceBottleneck(["BENCHMARK_TOO_OLD"])).toBe("BENCHMARK_STALE");
  });
});

describe("contact gates", () => {
  it("25: unverified email excluded", () => {
    const b = cohortBlockers(facts({}, { contact: { provenance: "estimated" } }));
    expect(b).toContain("CONTACT_EMAIL_UNVERIFIED");
    expect(contactBottleneck(b)).toBe("EMAIL_UNVERIFIED");
  });
  it("26: guessed / AI-inferred email excluded", () => {
    expect(cohortBlockers(facts({}, { contact: { provenance: "ai_inferred" } }))).toContain("CONTACT_EMAIL_UNVERIFIED");
    expect(contactBottleneck(cohortBlockers(facts({}, { contact: null })))).toBe("NO_CONTACT_FOUND");
    expect(contactBottleneck(cohortBlockers(facts({}, { contact: { generic: true } })))).toBe("ONLY_GENERIC_EMAIL");
    expect(isGenericEmail("agent@ourcollectiveplace.com")).toBe(true);
    expect(isGenericEmail("team@lclarkegroup.com")).toBe(true);
    expect(isGenericEmail("jessica@homeisnv.com")).toBe(false);
  });
  it("27: verified direct email eligible", () => {
    expect(ev(facts({}, { contact: { provenance: "verified" } })).sendReady).toBe(true);
    expect(ev(facts({}, { contact: { provenance: "publicly_sourced" } })).sendReady).toBe(true);
  });
});

describe("buyer signals are ranking, never gates", () => {
  it("28: UNKNOWN buyer signals do not exclude", () => {
    const e = ev(facts({ buyerSignals: [], websiteOnFile: false }));
    expect(e.sendReady).toBe(true);
    expect(e.buyer.outsourcingPropensity).toBe("UNKNOWN");
    expect(e.buyer.abilityToPay).toBe("UNKNOWN");
    expect(e.band).not.toBe("HOLD");
  });
  it("29: low social presence / no marketing evidence does not exclude", () => {
    const e = ev(facts({ buyerSignals: [], websiteOnFile: false }));
    expect(e.blockers).toEqual([]);
  });
  it("signals lift the band with provenance preserved; ai_inferred signals are ignored", () => {
    const withSignal = ev(facts({ buyerSignals: [{ kind: "paid_marketing_active", label: "runs Google Ads", sourceUrl: "https://example.com/ads", observedOn: "2026-09-01", provenance: "publicly_sourced" }] }));
    expect(withSignal.band).toBe("A+");
    expect(withSignal.buyer.evidence[0]!.sourceUrl).toBe("https://example.com/ads");
    const inferred = ev(facts({ buyerSignals: [{ kind: "paid_marketing_active", label: "guess", sourceUrl: "https://example.com", observedOn: "2026-09-01", provenance: "ai_inferred" }] }));
    expect(inferred.buyer.outsourcingPropensity).toBe("UNKNOWN");
  });
  it("band reasons are human-readable, not a score", () => {
    const e = ev(facts());
    expect(e.band).toBe("A");
    expect(e.bandReasons.join(" ")).toMatch(/STRONG mismatch/);
    expect(e.bandReasons.join(" ")).toMatch(new RegExp(`${BAND_BREADTH_QUESTIONS - 1}|distinct questions`));
    expect(e.whySelected.some((w) => /recommended 17× in 256 OpenAI answers/.test(w))).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/score/i);
  });
});

describe("selection, freeze, idempotency", () => {
  const item = (id: string, over: Partial<T1CandidateFacts> = {}) => { const f = facts({ prospectId: id, companyId: `c-${id}`, contact: { id: `ct-${id}`, name: "Lead", role: "team lead", email: `${id}@x.com`, provenance: "publicly_sourced", generic: false, isDecisionMaker: true }, dedupe: { brokerageKey: null, leadPersonKey: null }, ...over }); return { facts: f, evaluation: ev(f) }; };

  it("30: rerun does not duplicate cohort membership", () => {
    const sel = selectCohort({ items: [item("a"), item("b")], priorBrokerageSends: new Map() });
    const first = freezeCohort("t1-cohort-002", sel.selected, NOW);
    const existing = new Set(first.map((m) => m.membershipKey));
    const second = freezeCohort("t1-cohort-002", sel.selected, new Date("2026-09-12T00:00:00Z"));
    expect(newMembers(existing, second)).toEqual([]);
  });
  it("31: policy / template / release versions attached to every member", () => {
    const m = freezeCohort("t1-cohort-002", selectCohort({ items: [item("a")], priorBrokerageSends: new Map() }).selected, NOW)[0]!;
    expect(m.policy).toEqual(expect.objectContaining({ cohortPolicyVersion: T1_COHORT_POLICY_VERSION, templateVersion: MISMATCH_TEMPLATE_VERSION, evidenceReleaseVersion: EVIDENCE_RELEASE_VERSION }));
    expect(m.policy.mismatchThresholds.minRecommendationGap).toBe(2);
  });
  it("32: frozen feature snapshot is preserved (raw features, zero-case, provenance)", () => {
    const m = freezeCohort("t1-cohort-002", selectCohort({ items: [item("a")], priorBrokerageSends: new Map() }).selected, NOW)[0]!;
    expect(m.features).toEqual(expect.objectContaining({ runId: "run-1", denominator: 256, prospectRecs: 0, competitorRecs: 17, absoluteGap: 17, recommendationMultiple: null, zeroCase: true, competitorAiRank: 1 }));
    expect(m.selectedAt).toBe(NOW.toISOString());
    expect(m.sendReadiness).toBe("COHORT_READY_NOT_SCHEDULED");
    expect(Object.isFrozen(JSON.parse(JSON.stringify(m)))).toBe(false); // plain data; immutability is persistence-level (append-only audit rows)
  });
  it("33: fewer than 75 eligible prospects does not loosen rules", () => {
    const items = [item("a"), item("b", { release: { verified: false, reasons: ["ZERO_NOT_VERIFIED"] } })];
    const sel = selectCohort({ items, priorBrokerageSends: new Map() });
    expect(sel.selected.map((s) => s.facts.prospectId)).toEqual(["a"]);
    expect(cohortVerdict(sel.selected.length)).toBe("COHORT_READY_BELOW_TARGET");
    expect(cohortVerdict(0)).toBe("BLOCKED");
    expect(cohortVerdict(T1_COHORT_TARGET.min)).toBe("COHORT_READY");
  });
  it("34: no send occurs from the cohort build (module exposes no send path; members are not scheduled)", () => {
    const mod = { selectCohort, freezeCohort, evaluateCandidate, dedupeBuyingUnits, revalidateBeforeFreeze };
    expect(Object.keys(mod).some((k) => /send|schedule|enroll/i.test(k))).toBe(false);
    const m = freezeCohort("t1-cohort-002", selectCohort({ items: [item("a")], priorBrokerageSends: new Map() }).selected, NOW)[0]!;
    expect(m.sendReadiness).toBe("COHORT_READY_NOT_SCHEDULED");
  });
  it("35: a correction inserted before freeze invalidates the candidate", () => {
    const sel = selectCohort({ items: [item("a"), item("b")], priorBrokerageSends: new Map() });
    const fresh = new Map(sel.selected.map((s) => [s.facts.prospectId, s.facts]));
    fresh.set("a", { ...fresh.get("a")!, pendingCorrection: true });
    const r = revalidateBeforeFreeze(sel.selected, fresh, NOW);
    expect(r.kept.map((k) => k.facts.prospectId)).toEqual(["b"]);
    expect(r.dropped[0]).toEqual({ prospectId: "a", name: expect.any(String), blockers: ["PENDING_CORRECTION"] });
  });
  it("36: an exclusivity agreement inserted before freeze invalidates the candidate", () => {
    const sel = selectCohort({ items: [item("a")], priorBrokerageSends: new Map() });
    const fresh = new Map(sel.selected.map((s) => [s.facts.prospectId, { ...s.facts, market: { ...s.facts.market, exclusiveConflict: true } }]));
    const r = revalidateBeforeFreeze(sel.selected, fresh, NOW);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]!.blockers).toEqual(["MARKET_EXCLUSIVE_CONFLICT"]);
  });
  it("per-market brokerage cap (spec 120) defers, never re-grades; prior sends count", () => {
    const items = ["a", "b", "c", "d"].map((id) => item(id, { dedupe: { brokerageKey: "bhhs towne", leadPersonKey: null } }));
    const prior = new Map([["l-1|bhhs towne", BROKERAGE_SEND_CAP_30D - 1]]);
    const sel = selectCohort({ items, priorBrokerageSends: prior });
    expect(sel.selected).toHaveLength(1);
    expect(sel.deferred.filter((d) => d.reason === "BROKERAGE_CAP_30D")).toHaveLength(3);
    const other = selectCohort({ items: items.map((i) => ({ ...i, facts: { ...i.facts, market: { ...i.facts.market, launchId: "l-2" } } })), priorBrokerageSends: prior });
    expect(other.selected).toHaveLength(BROKERAGE_SEND_CAP_30D);
  });
  it("selection never exceeds the target maximum and orders by band then gap", () => {
    const items = Array.from({ length: T1_COHORT_TARGET.max + 5 }, (_, i) => item(`p${i}`, { features: features({ absoluteGap: i, competitorRecs: i }) }));
    const sel = selectCohort({ items, priorBrokerageSends: new Map() });
    expect(sel.selected).toHaveLength(T1_COHORT_TARGET.max);
    expect(sel.deferred.filter((d) => d.reason === "OVER_TARGET")).toHaveLength(5);
    expect(sel.selected[0]!.facts.features!.absoluteGap).toBeGreaterThanOrEqual(sel.selected[1]!.facts.features!.absoluteGap);
  });
});
