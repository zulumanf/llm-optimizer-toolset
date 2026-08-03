# Spec 045 — Making the Audit Page Trustworthy to a Skeptic

> Status: approved and largely implemented (commits f2be492…09389fc).
> Implemented: 1a verbatim excerpts, 1c prepared-by/report id, 1d limitations
> promoted, 2a full-transcript appendix, 2c hash sentence. Still open: 1b
> (the "check it yourself" box exists only as a footnote in a collapsed
> drawer), 2b (operator-verified market-context stats — no code), and the
> deployment prerequisite below (tracked in docs/production-readiness-plan.md). The reader is a successful agent who gets pitched daily and
> assumes every vendor chart is cherry-picked. Every trust move below follows one
> rule: **show receipts they can check without us, or say plainly why not.**

## Where the page currently asks for faith

1. "We captured 40 answers" — none are shown. The numbers are our word.
2. The report is anonymous — no named sender, no firm, no report identity.
3. The prospect can't independently reproduce anything from the page itself.
4. The evidence-on-request promise ("we can show you") is deferred trust, not trust.
5. Market-context claims about AI adoption are absent entirely (good — none are
   invented), but their absence leaves "why does this matter" resting on vibes.

## Tier 1 — receipts on the page (highest trust per effort; no new data needed)

**1a. Verbatim answer excerpts.** The platform already stores every raw response
immutably with capture timestamps, and every mention carries a verbatim excerpt.
Add `evidenceExcerpts` to the snapshot: 3–4 short quotes from actual captured
answers — the moment a rival was recommended, stamped with assistant + model +
capture date ("GPT-5.4 with web search, captured Aug 3, 2026"). Nothing is more
convincing than reading the machine recommend your competitor in its own words.
Selection is deterministic (top recommended rivals' excerpts, first rep); excerpts
are already sanitized spans, and rivals named in them already appear in the
comparison table.

**1b. "Check it yourself" box.** Print 2–3 of the exact questions we asked and
invite the reader to paste them into ChatGPT right now. Frame honestly: answers
vary between runs — that is *why* we sample repeatedly (link to the methodology
paragraph). This costs nothing, and a skeptic who tries it becomes the report's
strongest believer. No other section can do that.

**1c. A named sender and report identity.** "Prepared by {operator name} ·
{agency name} · {date} · report {short-id}" in the header, with a contact route.
Anonymous analysis reads as spam; a signed document with a stable identity reads
as work product someone stands behind. Agency identity becomes a small config
(name, site, reply contact) — not hardcoded copy.

**1d. Candor upgrades.** (i) If the prospect DID appear anywhere, show that
moment too — an all-negative report reads as a sales trick; (ii) promote the
limitations line out of the footer: "This is a sample of AI behavior during one
window, not a census — here's exactly what we did and didn't measure."

## Tier 2 — independent verifiability (moderate effort)

**2a. The full-transcript appendix.** A second tokened page ("all 40 captured
answers, verbatim") linked from the report, built the same snapshot-immutable
way. The strongest possible receipt: nothing summarized, nothing selected by us.
Decision needed: always-published vs. on-request (default: linked — selection
bias is the thing skeptics suspect most, and the appendix kills that suspicion).

**2b. Operator-verified market-context stats.** A stats block ("N% of buyers now
start with AI…") where every entry REQUIRES publisher + URL + date and is entered
by the operator after verifying the source — the platform ships zero hardcoded
statistics, ever. Renders only when populated; each stat is a clickable citation
the reader can check without us.

**2c. Capture integrity, one plain sentence.** The methodology already hashes
every raw response at capture (SHA-256, insert-only storage). Say so in one
line: "Answers are content-hashed at capture and never edited." No crypto
theater beyond the sentence — the mechanism already exists.

## Tier 3 — hold for later (real cost, uncertain trust gain)

- PDF export with the same content (portability ≠ trust; revisit on demand).
- Multi-assistant coverage ("across ChatGPT AND Perplexity/Gemini") — this is a
  provider-key/funding decision (roadmap 4.5), and it does add trust ("not just
  one bot"), but it's blocked on credentials, not design.
- Third-party attestation / SOC-style language — wrong genre for this audience.

## Prerequisite reality check

None of this matters until the app is deployed: a localhost link cannot be sent
to anyone. Deployment (hosting + remote migrations + AUTH_MODE=supabase) is the
gate to any real send, and Tier 1 should land before the first real prospect
opens the page.

## Acceptance sketch (when approved)

- Excerpts render with assistant/model/date stamps; selection deterministic and
  tested; prospect-positive moments included when they exist.
- Check-it-yourself box shows real prompts from the frozen set, with the honest
  variance note.
- Prepared-by block from config + publisher identity; report id stable.
- Appendix page: same token discipline, immutable snapshot, revoked with the
  parent audit; view-tracked separately.
- Context stats refuse to save without publisher + URL + date.
- No new field ever fabricates: everything renders only when its data exists.
