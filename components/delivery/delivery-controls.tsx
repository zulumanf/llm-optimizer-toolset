"use client";

/**
 * Operator controls for client delivery (spec 154). Every control calls a
 * thin server action; the services re-check role and scope. Nothing here
 * sends email — "Mark sent" records that the operator sent it.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ActionDialog, Field, OneClick, Pick } from "@/components/engagements/commercial-controls";
import * as a from "@/app/projects/[id]/delivery/actions";
import { DECISION_CHANNELS } from "@/lib/engagements/constants";
import { PLAN_PHASES, RECOMMENDATION_DISTINCTION, SUBJECT_DECISIONS, type DecisionSubject } from "@/lib/engagements/delivery-rules";
import type { QuestionReview } from "@/lib/engagements/question-review";

const lines = (s: string) => s.split(/\n/).map((x) => x.trim()).filter(Boolean);
const PHASE_KEYS = PLAN_PHASES.map((p) => p.key);

// --------------------------------------------------------------- updates

export function WelcomeDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [name, setName] = useState("");
  const [checkin, setCheckin] = useState("");
  return (
    <ActionDialog trigger="Prepare welcome" title="Prepare the welcome message" submitLabel="Generate draft" variant="default"
      onSubmit={() => a.generateWelcomeDraft(projectId, { engagementId, agencyContactName: name, firstCheckinOn: checkin || null })}>
      <Field label="Your name, as the client's contact *"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="First check-in date (optional)"><Input type="date" value={checkin} onChange={(e) => setCheckin(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">The draft uses the engagement record and links to /portal only. Invite the client to the portal first (Settings → client access) so the link works.</p>
    </ActionDialog>
  );
}

export function WeeklyDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [intro, setIntro] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  return (
    <ActionDialog trigger="Prepare weekly update" title="Prepare this week's update" submitLabel="Generate draft" variant="default"
      onSubmit={() => a.generateWeeklyDraft(projectId, { engagementId, intro, ...(periodEnd ? { periodEnd } : {}) })}>
      <Field label="Short personal note (optional; no percentages or cause claims)"><Textarea rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} /></Field>
      <Field label="Week ending (defaults to today)"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Every other line comes from records: completed client-visible work, approvals waiting, blockers, measurements frozen this week, plan items due next week, next check-in.</p>
    </ActionDialog>
  );
}

export function FinalReviewButton({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  return <OneClick label="Prepare Day-90 review" onClick={() => a.generateFinalReviewDraft(projectId, { engagementId })} />;
}

export function UpdateDraft({ projectId, updateId, kind, text }: { projectId: string; updateId: string; kind: string; text: string }) {
  const [channel, setChannel] = useState<string>("email");
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Draft {kind.replace(/_/g, " ")}</p>
        <Badge variant="secondary">not sent</Badge>
      </div>
      <Label htmlFor={`draft-${updateId}`} className="sr-only">Draft text</Label>
      <Textarea id={`draft-${updateId}`} readOnly rows={10} value={text} className="font-mono text-xs" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied."), () => toast.error("Copy failed — select the text manually."))}>Copy text</Button>
        <div className="w-36"><Pick value={channel} onChange={setChannel} options={DECISION_CHANNELS} /></div>
        <OneClick label="Mark sent (freezes it)" variant="default" onClick={() => a.markUpdateSent(projectId, { updateId, channel })} />
        <OneClick label="Discard" onClick={() => a.discardUpdate(projectId, { updateId })} />
      </div>
      <p className="text-xs text-muted-foreground">Send it yourself (email or call), then mark it sent. Sent updates are frozen and appear in the client&apos;s portal.</p>
    </div>
  );
}

// ------------------------------------------------------------- questions

export function ImportQuestionsDialog({ projectId, engagementId, floorUsd }: { projectId: string; engagementId: string; floorUsd: number | null }) {
  const [content, setContent] = useState("");
  const [setName, setSetName] = useState("Client-reviewed questions");
  const [audience, setAudience] = useState("seller");
  const [applyFloor, setApplyFloor] = useState(true);
  const [review, setReview] = useState<QuestionReview | null>(null);
  const [pending, start] = useTransition();
  const payload = (dryRun: boolean) => ({ engagementId, setName, content, defaultAudience: audience || null, applyPriceFloor: applyFloor, dryRun });
  return (
    <ActionDialog trigger="Import reviewed questions" title="Import the client-reviewed question set" submitLabel="Import and freeze" variant="default"
      onSubmit={() => a.importClientQuestions(projectId, payload(false))}>
      <p className="text-xs text-muted-foreground">Export the review sheet as CSV (File → Download → CSV, questions tab) and paste it. Needs a question column; optional segment, neighborhood, audience, client decision and comment columns. Rows marked remove are left out; revise and check-service-area rows block until resolved.</p>
      <Field label="Set name"><Input value={setName} onChange={(e) => setSetName(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Audience when the sheet has none"><Input value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
        <label className="flex items-center gap-2 pt-5 text-sm">
          <input type="checkbox" checked={applyFloor} onChange={(e) => setApplyFloor(e.target.checked)} />
          Enforce minimum value {floorUsd ? `($${floorUsd.toLocaleString("en-US")})` : "(none recorded)"}
        </label>
      </div>
      <Field label="CSV"><Textarea rows={8} value={content} onChange={(e) => { setContent(e.target.value); setReview(null); }} className="font-mono text-xs" /></Field>
      <Button size="sm" variant="outline" disabled={pending || !content} onClick={() => start(async () => {
        const r = await a.importClientQuestions(projectId, payload(true));
        if (r.ok) setReview(r.data.review);
        else toast.error(r.error.message);
      })}>{pending ? "Checking…" : "Validate first"}</Button>
      {review && (
        <div className="space-y-1 rounded-md border p-2 text-xs" role="status">
          <p className="font-medium">{review.ok ? "Ready to import" : "Fix before importing"}: {review.rows.length} question(s), {review.excluded.length} removed by the client.</p>
          <p>{review.segments.map((s) => `${s.priceTier}: ${s.count}`).join(" · ")}</p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto">
            {review.issues.map((i, n) => (
              <li key={n} className={i.severity === "blocking" ? "text-destructive" : "text-muted-foreground"}>Line {i.line}: {i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </ActionDialog>
  );
}

export function SubjectDecisionDialog({ projectId, engagementId, subjectKind, subjectRef, trigger }: { projectId: string; engagementId: string; subjectKind: DecisionSubject; subjectRef: string; trigger: string }) {
  const [decision, setDecision] = useState<string>("approved");
  const [channel, setChannel] = useState<string>("email");
  const [actor, setActor] = useState("");
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger={trigger} title="Record the client's decision" submitLabel="Record decision"
      onSubmit={() => a.recordSubjectDecision(projectId, { engagementId, subjectKind, subjectRef, decision, channel, clientActor: actor, note })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decision"><Pick value={decision} onChange={setDecision} options={SUBJECT_DECISIONS} /></Field>
        <Field label="How they told us"><Pick value={channel} onChange={setChannel} options={DECISION_CHANNELS} /></Field>
      </div>
      <Field label="Who decided (client side) *"><Input value={actor} onChange={(e) => setActor(e.target.value)} /></Field>
      <Field label="Note (what they said; link to the email)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Append-only. The decision pins the exact version it is about.</p>
    </ActionDialog>
  );
}

// -------------------------------------------------------------- protocol

export interface ProtocolDefaults {
  promptSetVersionId: string;
  provider: string;
  model: string;
  geographicContext: string;
  repetitions: number;
  baselineWindow: string;
  finalWindow: string;
  recommendationRubric: string;
  comparisonRules: string;
  caveats: string;
  adjudication: string;
  successCriteria: string;
  entityAliases: string[];
  externalSources: string;
}

export function ProtocolDialog({ projectId, engagementId, initial, trigger }: { projectId: string; engagementId: string; initial: ProtocolDefaults; trigger: string }) {
  const [f, setF] = useState({ ...initial, repetitions: String(initial.repetitions), entityAliases: initial.entityAliases.join("\n") });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ActionDialog trigger={trigger} title="Measurement protocol (draft)" submitLabel="Save draft"
      onSubmit={() => a.saveProtocolDraft(projectId, { ...f, engagementId, repetitions: Number(f.repetitions), entityAliases: lines(f.entityAliases) })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider"><Input value={f.provider} onChange={set("provider")} /></Field>
        <Field label="Exact model id *"><Input value={f.model} onChange={set("model")} /></Field>
        <Field label="Repetitions per question"><Input inputMode="numeric" value={f.repetitions} onChange={set("repetitions")} /></Field>
        <Field label="Geographic context *"><Input value={f.geographicContext} onChange={set("geographicContext")} /></Field>
        <Field label="Baseline window *"><Input value={f.baselineWindow} onChange={set("baselineWindow")} /></Field>
        <Field label="Final measurement window *"><Input value={f.finalWindow} onChange={set("finalWindow")} /></Field>
      </div>
      <Field label="Name variants credited to the client (one per line) *"><Textarea rows={3} value={f.entityAliases} onChange={set("entityAliases")} /></Field>
      <Field label="Success criteria — exactly as in the contract *"><Textarea rows={3} value={f.successCriteria} onChange={set("successCriteria")} /></Field>
      <Field label="Recommendation vs mention rubric *"><Textarea rows={3} value={f.recommendationRubric} onChange={set("recommendationRubric")} /></Field>
      <Field label="Comparison rules *"><Textarea rows={3} value={f.comparisonRules} onChange={set("comparisonRules")} /></Field>
      <Field label="Caveats *"><Textarea rows={3} value={f.caveats} onChange={set("caveats")} /></Field>
      <Field label="Adjudication *"><Textarea rows={3} value={f.adjudication} onChange={set("adjudication")} /></Field>
      <Field label="External sources"><Textarea rows={2} value={f.externalSources} onChange={set("externalSources")} /></Field>
      <p className="text-xs text-muted-foreground">Editable until the client accepts it. Once accepted it is frozen in the database and the baseline can be locked.</p>
    </ActionDialog>
  );
}

export function AcceptProtocolDialog({ projectId, protocolId }: { projectId: string; protocolId: string }) {
  const [actor, setActor] = useState("");
  const [channel, setChannel] = useState<string>("email");
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger="Record acceptance" title="The client accepted the protocol" submitLabel="Record and freeze" variant="default"
      onSubmit={() => a.acceptProtocol(projectId, { protocolId, clientActor: actor, channel, note })}>
      <Field label="Who accepted (client side) *"><Input value={actor} onChange={(e) => setActor(e.target.value)} /></Field>
      <Field label="How"><Pick value={channel} onChange={setChannel} options={DECISION_CHANNELS} /></Field>
      <Field label="Note (link to their email)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Refused unless the client approved the cited question set and every required field is filled.</p>
    </ActionDialog>
  );
}

type FreezePreview = Extract<Awaited<ReturnType<typeof a.previewBaselineFreeze>>, { ok: true }>["data"];

/**
 * Spec 160: check, then lock. The preview runs every rule the freeze runs;
 * Lock stays disabled until nothing blocks, and sends the answer count the
 * operator saw — the server refuses if the run changed in between.
 */
export function FreezeBaselineDialog({ projectId, engagementId, runs }: { projectId: string; engagementId: string; runs: { id: string; label: string; status: string; matchesProtocol: boolean }[] }) {
  const eligible = runs.filter((r) => r.matchesProtocol && (r.status === "completed" || r.status === "partial"));
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState(eligible[0]?.id ?? "");
  const [preview, setPreview] = useState<FreezePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallChecked, setRecallChecked] = useState(false);
  const [pending, start] = useTransition();
  const reset = () => { setPreview(null); setError(null); setRecallChecked(false); };
  const check = () => start(async () => {
    reset();
    const r = await a.previewBaselineFreeze(projectId, { engagementId, runId });
    if (r.ok) setPreview(r.data);
    else setError(r.error.message);
  });
  const lock = () => start(async () => {
    if (!preview?.headline) return;
    const r = await a.freezeBaseline(projectId, { engagementId, runId, confirmedAnswerCount: preview.headline.answerCount });
    if (r.ok) { toast.success("Baseline locked."); setOpen(false); reset(); }
    else setError(r.error.message);
  });
  const blockers = preview?.readiness.blockers ?? [];
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild><Button size="sm" variant="destructive">Lock baseline</Button></DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Lock the baseline</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          {eligible.length === 0 ? (
            <p>No finished run on the protocol&apos;s question set. Start one on this project from Runs, wait for parsing, clear the review queue, retry failed cells.</p>
          ) : (
            <Field label="Run (this project, protocol question set)">
              <Select value={runId} onValueChange={(v) => { setRunId(v); reset(); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {eligible.map((r) => <SelectItem key={r.id} value={r.id}>{r.label || r.id.slice(0, 8)} · {r.status}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {preview && (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 rounded-md border p-3">
              <dt className="text-muted-foreground">Run</dt><dd className="break-all font-mono text-xs">{preview.run.id}</dd>
              <dt className="text-muted-foreground">Questions</dt><dd>{preview.questionSet.name} · v{preview.questionSet.version} · {preview.questionSet.promptCount}</dd>
              <dt className="text-muted-foreground">Instrument</dt><dd>{preview.provider} · {preview.models.join(", ")} · ×{preview.repetitions}</dd>
              <dt className="text-muted-foreground">Protocol</dt><dd>v{preview.protocol.version}</dd>
              <dt className="text-muted-foreground">Name variants</dt><dd>{preview.protocol.aliases.join(", ") || "none agreed"}</dd>
              <dt className="text-muted-foreground">Cells answered</dt><dd className="tabular-nums">{preview.readiness.expectedCells - preview.readiness.outstandingCells} of {preview.readiness.expectedCells}</dd>
              {preview.headline && (
                <>
                  <dt className="text-muted-foreground">Will lock</dt>
                  <dd className="tabular-nums">{preview.headline.answerCount} answers · recommended in {preview.headline.subjectRecommended} · {preview.headline.competitors} competitors</dd>
                </>
              )}
            </dl>
          )}
          {blockers.length > 0 && (
            <div role="alert" className="rounded-md border border-destructive/40 p-3">
              <p className="font-medium">Not ready to lock:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          )}
          {preview?.headline && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={recallChecked} onChange={(e) => setRecallChecked(e.target.checked)} />
              I checked every agreed name variant against the stored answers (recall QA). Locking cannot be undone except by an admin void, which is recorded.
            </label>
          )}
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={pending || !runId} onClick={check}>{pending && !preview ? "Checking…" : preview ? "Check again" : "Check readiness"}</Button>
          <Button variant="destructive" disabled={pending || !preview?.headline || blockers.length > 0 || !recallChecked} onClick={lock}>
            {pending && preview ? "Locking…" : "Lock baseline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Spec 160 A4: admin-only, permanent record; the snapshot is kept. */
export function VoidBaselineDialog({ projectId, engagementId, measurementId }: { projectId: string; engagementId: string; measurementId: string }) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog trigger="Void baseline" title="Void this baseline" submitLabel="Void baseline" variant="destructive"
      onSubmit={() => a.voidBaseline(projectId, { engagementId, measurementId, reason })}>
      <p className="text-sm">The locked snapshot is kept permanently and marked void with your name, the time and this reason. A new baseline can then be locked. Refused once a later measurement was compared against it.</p>
      <Field label="Why is this baseline wrong? (at least 20 characters) *"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </ActionDialog>
  );
}

// ---------------------------------------------------------------- roadmap

export function PlanStartButtons({ projectId, baselineLocked }: { projectId: string; baselineLocked: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {baselineLocked && <OneClick label="Draft from baseline" variant="default" onClick={() => a.draftPlanFromBaseline(projectId)} />}
      <OneClick label="Start a blank plan" onClick={() => a.createManualPlan(projectId)} />
    </div>
  );
}

export function PlanItemDialog({ projectId, planId, item, others }: { projectId: string; planId: string; item?: { id: string; phase: string; title: string; rationale: string; owner: string; dueOn: string | null; dependsOn: string[]; proofUrl: string | null }; others: { id: string; title: string }[] }) {
  const [f, setF] = useState({ phase: item?.phase ?? "foundation", title: item?.title ?? "", rationale: item?.rationale ?? "", owner: item?.owner ?? "operator", dueOn: item?.dueOn ?? "", proofUrl: item?.proofUrl ?? "" });
  const [deps, setDeps] = useState<string[]>(item?.dependsOn ?? []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const candidates = others.filter((o) => o.id !== item?.id);
  return (
    <ActionDialog trigger={item ? "Edit" : "Add item"} title={item ? "Edit plan item" : "Add a plan item"} submitLabel="Save"
      onSubmit={() => item
        ? a.updatePlanItem(projectId, { planItemId: item.id, phase: f.phase, title: f.title, rationale: f.rationale, owner: f.owner, dueOn: f.dueOn || null, dependsOn: deps, proofUrl: f.proofUrl || null })
        : a.addPlanItem(projectId, { planId, phase: f.phase, title: f.title, rationale: f.rationale, owner: f.owner, dueOn: f.dueOn || null, dependsOn: deps })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phase"><Pick value={f.phase} onChange={(v) => setF({ ...f, phase: v })} options={PHASE_KEYS} /></Field>
        <Field label="Owner"><Pick value={f.owner} onChange={(v) => setF({ ...f, owner: v })} options={["operator", "client", "shared"]} /></Field>
      </div>
      <Field label="Title *"><Input value={f.title} onChange={set("title")} /></Field>
      <Field label="Why (the observation behind it) *"><Textarea rows={3} value={f.rationale} onChange={set("rationale")} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Due"><Input type="date" value={f.dueOn} onChange={set("dueOn")} /></Field>
        {item && <Field label="Proof URL (after delivery)"><Input value={f.proofUrl} onChange={set("proofUrl")} /></Field>}
      </div>
      {candidates.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs">Depends on</legend>
          {candidates.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={deps.includes(o.id)} onChange={(e) => setDeps(e.target.checked ? [...deps, o.id] : deps.filter((d) => d !== o.id))} />
              {o.title}
            </label>
          ))}
        </fieldset>
      )}
      {item && <p className="text-xs text-muted-foreground">Edits to a published plan are audited with before and after.</p>}
    </ActionDialog>
  );
}

export function PlanActions({ projectId, planId, status }: { projectId: string; planId: string; status: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <OneClick label="Fill phase due dates" onClick={() => a.applyPhaseDueDates(projectId, { planId })} />
      {status === "draft" && <OneClick label="Publish to client" variant="default" onClick={() => a.publishPlan(projectId, { planId })} />}
    </div>
  );
}

export function ActivateItemButton({ projectId, planItemId }: { projectId: string; planItemId: string }) {
  return <OneClick label="Start as work item" onClick={() => a.activatePlanItem(projectId, { planItemId })} />;
}

// --------------------------------------------------------------- check-ins

export function ScheduleMeetingDialog({ projectId, engagementId, suggested }: { projectId: string; engagementId: string; suggested: string }) {
  const [date, setDate] = useState(suggested);
  const [time, setTime] = useState("10:00");
  const [kind, setKind] = useState<string>("checkin");
  const [agenda, setAgenda] = useState("");
  return (
    <ActionDialog trigger="Schedule check-in" title="Schedule a check-in" submitLabel="Schedule"
      onSubmit={() => a.scheduleMeeting(projectId, { engagementId, kind, scheduledFor: new Date(`${date}T${time}:00`).toISOString(), ...(agenda ? { agenda } : {}) })}>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time (your timezone)"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="Kind"><Pick value={kind} onChange={setKind} options={["kickoff", "checkin", "final_review"]} /></Field>
      </div>
      <Field label="Agenda (leave empty to build it from records)"><Textarea rows={4} value={agenda} onChange={(e) => setAgenda(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Send the calendar invite yourself; this records the date and agenda for the client&apos;s portal.</p>
    </ActionDialog>
  );
}

export function MeetingNotesDialog({ projectId, meeting }: { projectId: string; meeting: { id: string; status: string; notes: string; actionItems: { text: string; owner: string; dueOn: string | null }[]; clientVisible: boolean } }) {
  const [status, setStatus] = useState(meeting.status === "planned" ? "held" : meeting.status);
  const [notes, setNotes] = useState(meeting.notes);
  const [items, setItems] = useState(meeting.actionItems.map((i) => `${i.owner}: ${i.text}${i.dueOn ? ` (${i.dueOn})` : ""}`).join("\n"));
  const [visible, setVisible] = useState(meeting.clientVisible);
  const parsed = lines(items).map((l) => {
    const m = /^(client|agency)\s*:\s*(.*?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?$/i.exec(l);
    return m ? { owner: m[1]!.toLowerCase(), text: m[2]!, dueOn: m[3] ?? null } : { owner: "agency", text: l, dueOn: null };
  });
  return (
    <ActionDialog trigger="Notes" title="Check-in notes" submitLabel="Save"
      onSubmit={() => a.recordMeetingNotes(projectId, { meetingId: meeting.id, status, notes, actionItems: parsed, clientVisible: visible })}>
      <Field label="Status"><Pick value={status} onChange={setStatus} options={["planned", "held", "cancelled"]} /></Field>
      <Field label="Notes (client-visible when shared)"><Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Field label="Action items — one per line, e.g. client: send testimonials (2026-11-20)"><Textarea rows={4} value={items} onChange={(e) => setItems(e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Show notes to the client</label>
    </ActionDialog>
  );
}

// --------------------------------------------------- external measurement

export function ExternalImportDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [f, setF] = useState({ providerLabel: "", instrument: "", referenceUrl: "", capturedFrom: "", capturedTo: "", promptCount: "", summary: "", rawExport: "", distinguishesRecommendation: "unknown" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ActionDialog trigger="Import external measurement" title="Import an external measurement (manual)"
      submitLabel="Import (pending QA)"
      onSubmit={() => a.importExternalMeasurement(projectId, { ...f, engagementId, referenceUrl: f.referenceUrl || null, promptCount: f.promptCount ? Number(f.promptCount) : null })}>
      <p className="text-xs text-muted-foreground">For a third-party tool with no verified API (for example a brand-radar product). Paste its export verbatim; it is hashed, kept separate from our own measurement, and hidden from the client until verified.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider label *"><Input value={f.providerLabel} onChange={set("providerLabel")} /></Field>
        <Field label="Instrument / feature"><Input value={f.instrument} onChange={set("instrument")} /></Field>
        <Field label="Captured from *"><Input type="date" value={f.capturedFrom} onChange={set("capturedFrom")} /></Field>
        <Field label="Captured to *"><Input type="date" value={f.capturedTo} onChange={set("capturedTo")} /></Field>
        <Field label="Reference URL (https)"><Input value={f.referenceUrl} onChange={set("referenceUrl")} /></Field>
        <Field label="Prompts covered"><Input inputMode="numeric" value={f.promptCount} onChange={set("promptCount")} /></Field>
      </div>
      <Field label="Can it tell a recommendation from a mention?"><Pick value={f.distinguishesRecommendation} onChange={(v) => setF({ ...f, distinguishesRecommendation: v })} options={RECOMMENDATION_DISTINCTION} /></Field>
      <Field label="Summary (what it shows, in plain words)"><Textarea rows={2} value={f.summary} onChange={set("summary")} /></Field>
      <Field label="Raw export *"><Textarea rows={6} value={f.rawExport} onChange={set("rawExport")} className="font-mono text-xs" /></Field>
      <p className="text-xs text-muted-foreground">Do not include the tool&apos;s cost or account details.</p>
    </ActionDialog>
  );
}

export function ExternalQaDialog({ projectId, id }: { projectId: string; id: string }) {
  const [status, setStatus] = useState<string>("verified");
  const [note, setNote] = useState("");
  const [visible, setVisible] = useState(false);
  return (
    <ActionDialog trigger="QA" title="Quality-check the external measurement" submitLabel="Record QA"
      onSubmit={() => a.setExternalMeasurementQa(projectId, { id, qaStatus: status, qaNote: note, clientVisible: visible })}>
      <Field label="Status"><Pick value={status} onChange={setStatus} options={["pending", "verified", "rejected"]} /></Field>
      <Field label="What you checked *"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Show to the client (verified only)</label>
    </ActionDialog>
  );
}
