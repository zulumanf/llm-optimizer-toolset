/**
 * Acquisition control panel (Analyze tab). Answers, in order: is the
 * current experiment working → live revenue → funnel → supply → follow-ups
 * → evidence QA → ICP learnings → markets → losses → economics → next
 * decision point → the week's plan. Every number is derived once in
 * lib/prospects/acquisition.ts; this file only lays it out. Opens and
 * report views sit under Diagnostics, never as hero metrics. Server
 * component: tables and labels, no charts.
 */
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Section, Stat, StatGrid } from "@/components/layout/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AcquisitionPanel, AcquisitionStatus, CutRow } from "@/lib/prospects/acquisition";
import type { Rate } from "@/lib/prospects/analytics";
import { formatOperatorTime } from "@/lib/format";

const pct = (r: Rate | number | null): string => {
  const v = typeof r === "number" ? r : r?.rate ?? null;
  return v === null ? "—" : `${Math.round(v * 1000) / 10}%`;
};
const frac = (r: Rate): string => `${r.n} / ${r.of}`;
const usd = (n: number | null): string => (n === null ? "N/A" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

const STATUS_VARIANT: Record<AcquisitionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  PROMISING: "default",
  HEALTHY: "default",
  WATCH: "secondary",
  WEAK: "destructive",
  "INSUFFICIENT DATA": "outline",
};

function Help({ text }: { text: string }) {
  return (
    <span title={text} className="inline-flex align-middle text-muted-foreground" aria-label={text}>
      <Info className="size-3.5" />
    </span>
  );
}

function Hero({ label, value, sub, badge }: { label: string; value: string; sub?: string; badge?: React.ReactNode }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-medium tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">{sub}</p>}
      {badge && <div className="mt-2">{badge}</div>}
    </div>
  );
}

function CutTable({ rows, first }: { rows: CutRow[]; first: string }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{first}</TableHead>
            <TableHead className="text-right">n</TableHead>
            <TableHead className="text-right">Positive</TableHead>
            <TableHead className="text-right">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.label}>
              <TableCell className="font-medium">{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{r.n}</TableCell>
              <TableCell className="text-right tabular-nums">{r.positive}</TableCell>
              <TableCell className="text-right tabular-nums">{r.sample === "OK" ? pct(r.rate) : <span className="text-xs text-muted-foreground">SMALL SAMPLE</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AcquisitionPanelView({ panel: p, diagnostics }: { panel: AcquisitionPanel; diagnostics?: React.ReactNode }) {
  const h = p.hero;
  const runway = h.runwayDays === null ? "—" : h.runwayDays === 0 ? "0 days · supply exhausted" : `~${h.runwayDays} sending day${h.runwayDays === 1 ? "" : "s"}`;
  const integrityAttention = p.evidence.alert === "ATTENTION REQUIRED";
  const cleanMaturePct = p.decision.target > 0 ? Math.min(100, Math.round((p.decision.cleanMature / p.decision.target) * 100)) : 0;

  return (
    <>
      {/* ===================== 1. current experiment health */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Hero
          label="Current experiment · positive replies"
          value={`${h.positiveReplies.n} / ${h.positiveReplies.of}`}
          sub={`${pct(h.positiveReplies)} of delivered T1 recipients`}
          badge={<span className="flex flex-wrap items-center gap-2"><Badge variant={STATUS_VARIANT[h.status]}>{h.status}</Badge><span className="text-xs text-muted-foreground">{h.statusReason}</span></span>}
        />
        <Hero
          label="Qualified T1 inventory"
          value={`${h.inventory.ready} ready`}
          sub={`${h.inventory.scheduled} scheduled · ${h.inventory.notReady} contactable, not yet evaluated`}
          badge={<span className="text-sm">Runway: <span className="font-medium tabular-nums">{runway}</span></span>}
        />
        <Hero
          label="Live revenue"
          value={`${h.liveLeads.positive} positive lead${h.liveLeads.positive === 1 ? "" : "s"}`}
          sub={`${h.liveLeads.highIntent} high intent`}
          badge={<span className="text-sm">Clients: <span className="font-medium tabular-nums">{h.clientsWon}</span></span>}
        />
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {[
          ["Unique T1 recipients", h.uniqueT1],
          ["Delivered", h.deliveredT1],
          ["Campaign sends", `${h.sends.t1 + h.sends.t2 + h.sends.t3} (T1 ${h.sends.t1} · T2 ${h.sends.t2} · T3 ${h.sends.t3})`],
          ["Corrections sent", h.sends.corrections],
          ["Founder replies", h.sends.founder],
        ].map(([label, v]) => (
          <div key={String(label)} className="flex items-baseline gap-1.5">
            <dd className="font-medium tabular-nums">{String(v)}</dd>
            <dt className="text-xs text-muted-foreground">{String(label)}</dt>
          </div>
        ))}
      </dl>

      {/* ===================== 9. live bottleneck */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Current bottleneck</p>
          <p className="mt-1 text-lg font-medium">{p.bottleneck.primary?.name ?? "None detected"}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{p.bottleneck.primary?.reason ?? "No rule fired; keep the sample growing."}</p>
        </div>
        <div className="rounded-md border p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Secondary bottleneck</p>
          <p className="mt-1 text-lg font-medium">{p.bottleneck.secondary?.name ?? "—"}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{p.bottleneck.secondary?.reason ?? "No second rule fired."}</p>
        </div>
      </div>

      {/* ===================== 13. today's priorities */}
      <Section title="Today's acquisition priorities" description="At most five. Ranked by revenue, then supply, then integrity. Opens never rank anything.">
        {p.priorities.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4" /> Nothing needs a decision today.</p>
        ) : (
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {p.priorities.map((x, i) => (
              <li key={i}>{x.prospectId ? <Link href={`/prospects/${x.prospectId}`} className="underline-offset-2 hover:underline">{x.text}</Link> : x.text}</li>
            ))}
          </ol>
        )}
      </Section>

      {/* ===================== 2. live revenue opportunities */}
      <Section title="Live revenue opportunities" description="Real human positive replies only. High intent first, then positive curiosity. No opens-based ranking.">
        {p.opportunities.length === 0 ? (
          <p className="text-sm text-muted-foreground">No positive reply is open right now. Keep T1 inventory flowing; a positive reply appears here the moment it is classified.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prospect</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Reply type</TableHead>
                  <TableHead>Last action</TableHead>
                  <TableHead>Last contact</TableHead>
                  <TableHead>Offer / price</TableHead>
                  <TableHead>Next action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.opportunities.map((o) => (
                  <TableRow key={o.prospectId}>
                    <TableCell className="font-medium"><Link href={`/prospects/${o.prospectId}`} className="underline-offset-2 hover:underline">{o.businessName}</Link></TableCell>
                    <TableCell>{o.market}</TableCell>
                    <TableCell><Badge variant={o.replyType === "HIGH_INTENT" ? "default" : "secondary"}>{o.replyType.replace("_", " ")}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{o.lastAction}{o.lastActionAt ? ` · ${formatOperatorTime(o.lastActionAt)}` : ""}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatOperatorTime(o.lastContactAt)}</TableCell>
                    <TableCell className="text-xs">{o.offerStatus}</TableCell>
                    <TableCell className="max-w-[36ch] text-xs" title={o.nextAction}>{o.nextAction}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      {/* ===================== 3. acquisition funnel (desktop) */}
      <div className="hidden sm:block">
        <Section title="Acquisition funnel" description={<>Current experiment. Conversion from the prior stage and from delivered T1. <Help text="Stages marked NOT FULLY INSTRUMENTED are derived proxies, not recorded events." /></>}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">From prior</TableHead>
                  <TableHead className="text-right">From T1</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.funnel.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.label}{!r.instrumented && <Badge variant="outline" className="ml-2">NOT FULLY INSTRUMENTED</Badge>}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.fromPrior)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.fromT1)}</TableCell>
                    <TableCell className="max-w-[40ch] text-xs text-muted-foreground">{r.note ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        <Section title="Era comparison" description="Is the new message outperforming the old approach? Eras are never pooled.">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Era</TableHead>
                  <TableHead className="text-right">Unique prospects</TableHead>
                  <TableHead className="text-right">Positive replies</TableHead>
                  <TableHead className="text-right">Positive rate</TableHead>
                  <TableHead className="text-right">Hard bounce rate</TableHead>
                  <TableHead>Report / link behavior</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.eras.map((e) => (
                  <TableRow key={e.era}>
                    <TableCell className="font-medium">{e.era} <span className="text-xs text-muted-foreground">{e.label}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{e.uniqueProspects}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.positive}</TableCell>
                    <TableCell className="text-right tabular-nums" title={e.note}>{pct(e.positiveRate)}{e.note ? "*" : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(e.bounceRate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{e.linkBehavior}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {p.eras.some((e) => e.note) && <p className="mt-2 text-xs text-muted-foreground">* {p.eras.find((e) => e.note)?.note}</p>}
        </Section>
      </div>

      {/* ===================== 4. supply / inventory */}
      <Section title="Supply and inventory" description="Where qualified prospects are lost before a T1 can go out.">
        <div className="hidden sm:block">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">From prior</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.supply.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.label}{p.supply.biggestDrop?.label === r.label && <Badge variant="destructive" className="ml-2">BIGGEST DROP</Badge>}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(r.fromPrior)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <StatGrid columns={4}>
          <Stat label="T1 ready" value={String(p.supply.ready)} hint="approved, not yet slotted" />
          <Stat label="T1 scheduled" value={String(p.supply.scheduled)} hint="approved and slotted" />
          <Stat label="Awaiting approval / parked" value={`${p.supply.awaitingApproval} / ${p.supply.parked}`} hint="rendered but unapproved / send error" />
          <Stat label="Estimated runway" value={runway} hint={`${p.supply.dailyT1Capacity} T1/day after ${p.supply.followupLoadNext} follow-ups due this horizon`} />
        </StatGrid>
        {p.supply.biggestDrop && (
          <p className="mt-2 text-sm"><span className="font-medium">Biggest supply drop:</span> {p.supply.biggestDrop.label} <span className="text-muted-foreground tabular-nums">({Math.round(p.supply.biggestDrop.lossShare * 100)}% of the prior stage lost)</span></p>
        )}
      </Section>

      {/* ===================== 5. follow-up pipeline */}
      <div className="hidden sm:block">
        <Section title="Follow-up pipeline" description="Sequences over frozen T1 evidence. Paused correction sequences are never mixed into active.">
          <StatGrid columns={4}>
            <Stat label="Active sequences" value={String(p.followups.active)} />
            <Stat label="T2 due (24h)" value={String(p.followups.t2Due)} hint={p.followups.overdue > 0 ? `${p.followups.overdue} overdue >1 day` : undefined} />
            <Stat label="T3 due (24h)" value={String(p.followups.t3Due)} />
            <Stat label="Paused · evidence review" value={String(p.followups.pausedEvidenceReview)} />
            <Stat label="OOO paused" value={String(p.followups.oooPaused)} />
            <Stat label="Replied" value={String(p.followups.replied)} />
            <Stat label="Stopped" value={String(p.followups.stopped)} />
            <Stat label="Complete (no reply)" value={String(p.followups.complete)} />
          </StatGrid>
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Touch</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Human replies after</TableHead>
                  <TableHead className="text-right">Positive replies after</TableHead>
                  <TableHead>Sample</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.touchPerf.map((t) => (
                  <TableRow key={t.touch}>
                    <TableCell className="font-medium">{t.touch}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.sent}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.repliesAfter}</TableCell>
                    <TableCell className="text-right tabular-nums">{t.positiveAfter}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t.sample === "OK" ? `reply after ${t.touch}: ${pct(t.sent ? t.repliesAfter / t.sent : null)}` : t.sample}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">&quot;Reply after T2&quot; means the reply landed after that touch, never that the touch caused it.</p>
        </Section>
      </div>

      {/* ===================== 6. evidence QA */}
      <Section
        title="Evidence QA status"
        description="Accuracy of the claims delivered in the current experiment. Corrections sit beside the frozen claim; nothing sent is rewritten."
        actions={integrityAttention ? <Badge variant="destructive"><AlertTriangle className="mr-1 size-3" /> ATTENTION REQUIRED</Badge> : <Badge variant="outline"><CheckCircle2 className="mr-1 size-3" /> CLEAR</Badge>}
      >
        <StatGrid columns={4}>
          <Stat label="Accurate claims" value={String(p.evidence.accurate)} hint="delivered T1 with no count change" />
          <Stat label="Count-corrected" value={String(p.evidence.corrected)} hint="a correction row exists" />
          <Stat label="Material correction" value={String(p.evidence.material)} hint="counts changed, still eligible" />
          <Stat label="No longer eligible" value={String(p.evidence.noLongerEligible)} hint="corrected counts fail the gate" />
          <Stat label="Human review" value={String(p.evidence.humanReview)} hint="single-name lead, alias unverifiable" />
          <Stat label="Paused correction sequences" value={String(p.evidence.pausedCorrectionSequences)} />
          <Stat label="Corrections sent / replies" value={`${p.evidence.correctionsSent} / ${p.evidence.correctionReplies}`} hint="tracked apart from T1/T2/T3" />
          <Stat label="Unresolved" value={String(p.evidence.unresolved)} hint="corrected claim, no correction sent, sequence open" />
        </StatGrid>
      </Section>

      {/* ===================== 7. ICP learnings */}
      <div className="hidden sm:block">
        <Section title="ICP learnings" description="Preregistered cuts only, over delivered T1 recipients with corrections applied. No exploration.">
          <div className="grid gap-4 lg:grid-cols-3">
            <CutTable rows={p.icp.recommendations} first="Prospect recommendations" />
            <CutTable rows={p.icp.competitorRank} first="Competitor AI rank" />
            <CutTable rows={p.icp.entity} first="Agent vs team" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Top-producer status: not shown — no canonical market ranking exists yet.</p>
          <div className="mt-4 rounded-md border p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">ICP hypothesis</p>
            <p className="mt-1 text-sm">&ldquo;{p.icp.hypothesis.text}&rdquo;</p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Badge variant={p.icp.hypothesis.status === "SUPPORTED" ? "default" : p.icp.hypothesis.status === "CONTRADICTED" ? "destructive" : "secondary"}>{p.icp.hypothesis.status}</Badge><span className="text-muted-foreground">{p.icp.hypothesis.reason}</span></p>
          </div>
        </Section>

        {/* ===================== 8. market performance */}
        <Section title="Market performance" description="Small samples are labeled, not ranked.">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Contacted</TableHead>
                  <TableHead className="text-right">Positive</TableHead>
                  <TableHead className="text-right">T1 ready</TableHead>
                  <TableHead className="text-right">Contact rate</TableHead>
                  <TableHead className="text-right">Median gap</TableHead>
                  <TableHead>Dominant competitor</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.markets.map((m) => (
                  <TableRow key={m.market}>
                    <TableCell className="font-medium">{m.market}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.contacted}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.positive}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.t1Ready}</TableCell>
                    <TableCell className="text-right tabular-nums" title={frac(m.contactRate)}>{pct(m.contactRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.medianGap ?? "—"}</TableCell>
                    <TableCell className="max-w-[24ch] truncate text-xs" title={m.dominantCompetitor ?? undefined}>{m.dominantCompetitor ?? "—"}</TableCell>
                    <TableCell><Badge variant={m.status === "PROMISING" ? "default" : m.status === "SMALL SAMPLE" ? "outline" : "secondary"}>{m.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>

        {/* ===================== 10. operational losses */}
        <Section title="Operational losses" description="Where sends were lost and whether the cause is behind us.">
          {p.losses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recorded losses.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Loss</TableHead>
                    <TableHead className="text-right">Impact</TableHead>
                    <TableHead>Resolved?</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.losses.map((l) => (
                    <TableRow key={l.label}>
                      <TableCell><Badge variant={l.type === "BUG" ? "destructive" : l.type === "HEALTHY_GATE" ? "outline" : "secondary"}>{l.type.replace("_", " ")}</Badge></TableCell>
                      <TableCell>{l.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.impact}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{l.resolved === null ? "ongoing policy" : l.resolved ? "yes" : "no"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Section>

        {/* ===================== 11. economics */}
        <Section title="Economics" description="Recorded benchmark API spend behind the frozen evidence only; dataset purchases and labor are not recorded.">
          <StatGrid columns={4}>
            <Stat label="Direct acquisition spend" value={usd(p.economics.spendUsd)} />
            <Stat label="Cost per T1-ready prospect" value={usd(p.economics.perT1Ready)} />
            <Stat label="Cost per positive reply" value={usd(p.economics.perPositive)} />
            <Stat label="Cost per high-intent reply" value={usd(p.economics.perHighIntent)} />
            <Stat label="Clients won" value={String(p.economics.clientsWon)} />
            <Stat label="CAC" value={usd(p.economics.cac)} hint={p.economics.cac === null ? "no client yet" : undefined} />
            {p.economics.scenario && <Stat label={<>SCENARIO <Help text="Not actual. A what-if over the recorded spend." /></>} value={usd(p.economics.scenario.cac)} hint={p.economics.scenario.label} />}
          </StatGrid>
        </Section>
      </div>

      {/* ===================== 12. next decision point */}
      <Section title="Next decision point" description="No strategy change before the decision sample. Frozen items are constants in code; changing one is a reviewed diff.">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="text-2xl font-medium tabular-nums">{p.decision.cleanMature} / {p.decision.target}</p>
          <p className="text-sm text-muted-foreground tabular-nums">clean and mature · {p.decision.delivered} delivered · {p.decision.clean} clean · {p.decision.mature} mature</p>
        </div>
        <svg className="mt-2 h-2 w-full max-w-md" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={`${p.decision.cleanMature} of ${p.decision.target}`}>
          <rect width="100" height="8" rx="4" className="fill-foreground/10" />
          {cleanMaturePct > 0 && <rect width={Math.max(cleanMaturePct, 2)} height="8" rx="4" className="fill-foreground/50" />}
        </svg>
        <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">Do not change yet</p>
        <dl className="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {p.decision.frozen.map((x) => (
            <div key={x.label} className="flex gap-2"><dt className="w-24 shrink-0 text-muted-foreground">{x.label}</dt><dd className="tabular-nums">{x.value}</dd></div>
          ))}
        </dl>
      </Section>

      {/* ===================== campaign plan */}
      <div className="hidden sm:block">
        <Section title="Campaign week" description="Queued sends by operator-local day. T2 includes follow-ups projected from queued T1s; those render only on their day.">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">T1</TableHead>
                  <TableHead className="text-right">T2</TableHead>
                  <TableHead className="text-right">T3</TableHead>
                  <TableHead className="text-right">Corrections</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.plan.map((x) => (
                  <TableRow key={x.day}>
                    <TableCell className="font-medium">{x.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.t1}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.t2 + x.t2Projected}{x.t2Projected > 0 ? <span className="text-xs text-muted-foreground"> ({x.t2Projected} projected)</span> : null}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.t3}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.corrections}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{x.total}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium">Week</TableCell>
                  <TableCell className="text-right tabular-nums">{p.plan.reduce((n, x) => n + x.t1, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.plan.reduce((n, x) => n + x.t2 + x.t2Projected, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.plan.reduce((n, x) => n + x.t3, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.plan.reduce((n, x) => n + x.corrections, 0)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{p.plan.reduce((n, x) => n + x.total, 0)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </Section>
      </div>

      {/* ===================== diagnostics (opens, report views, era-1 groupings) */}
      <details className="mt-8 rounded-md border p-4">
        <summary className="cursor-pointer text-lg font-medium">Diagnostics</summary>
        <p className="mt-1 text-sm text-muted-foreground">Open data is diagnostic and may contain scanners/proxies. Report views are a downstream metric; an unviewed report is not a lost lead.</p>
        <StatGrid columns={4}>
          <Stat label="ANY_OPEN" value={pct(p.opens.anyOpen)} hint={frac(p.opens.anyOpen)} />
          <Stat label="LIKELY_HUMAN_OPEN" value={pct(p.opens.likelyHuman)} hint={`${frac(p.opens.likelyHuman)} · scanner user agents excluded`} />
          <Stat label="Reports delivered / viewed" value={p.report.sample === "OK" ? `${p.report.delivered} / ${p.report.viewed}` : "INSUFFICIENT SAMPLE"} hint={`${p.report.delivered} delivered`} />
          <Stat label="Median hours to first view" value={p.report.sample === "OK" && p.report.medianHoursToView !== null ? `${Math.round(p.report.medianHoursToView)}h` : "INSUFFICIENT SAMPLE"} />
        </StatGrid>
        {diagnostics}
      </details>
    </>
  );
}
