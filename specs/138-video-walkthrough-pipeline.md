# Spec 138 — Personalized prospect video walkthrough pipeline

> Status: implemented — default mode SHADOW (prepare, QA, stage, never deliver)
> Depends on: specs/137 (fact manifest, fulfillment lane, artifact ledger, `video-walkthrough-contract`), 136 (release verification), 134 (private report access), 129
> Branch: feat/136-evidence-release-verification (stacked)

## Goal
Turn an already-verified evidence package into ONE 60–90 s, 16:9 MP4 walkthrough for a qualified positive reply, from the SAME fact manifest the email and report consume. The video never creates its own truth: scenes are typed props compiled from the manifest, the script is compiled by code (deterministic fact sentences + versioned connective copy), TTS renders the approved script, captions derive from it, QA is structural, and creation is separate from distribution.

## Pipeline (one line)
handoff `qa_passed` → `prepareVideoWalkthrough` (compile + deterministic script QA + generation key → artifact row `queued` + job) → worker `render_video_walkthrough` → input_validating → script_ready → semantic_qa (ONE reviewer) → audio_generating (cached ElevenLabs/mock) → rendering (Chromium stills + ffmpeg) → artifact_qa (ffprobe + structured checks) → ready → publishing → published (local storage) → release_ready (held in SHADOW).

## Reuse
- Truth: `prospect_fact_manifests` row + `compileVideoWalkthrough` (spec 137). Approved examples/first action from the published report block.
- Ledger: `prospect_fulfillment_artifacts` (kind `video_script`, `video_walkthrough`) + new `stage` / `generation_key` / `meta` (migration 113). QA verdicts: `prospect_report_qa_runs` kinds `video_script_qa` / `video_semantic_review` / `video_artifact_qa`.
- Queue: `jobs` (`render_video_walkthrough`, lease + backoff + reclaim). Storage: `evidence_artifacts` (`video` MP4, `export_file` VTT) via `storeArtifact({ reuseExisting })` under `var/evidence/video-walkthrough/<handoff>/<generationKey>.mp4`.
- Release truth: `fulfillmentSendRecheck` (manifest hash recompiled from a fresh verdict) inside `checkBinding`; `checkSuppression`; handoff state.
- Reviewer: `runAgent` + `modelForTask("video_semantic_review")` + `AUTOMATION_PROMPTS.video_semantic_review` (docs/13).
- Design: report palette (globals.css neutrals), no new design library.

## New
`lib/video/constants.ts` (format 1920×1080@30, duration 55–95 s QA / 60–90 target, padding, founder intro registry, voice profiles, modes) · `lib/video/tts.ts` (ElevenLabs over fetch with timestamps, mock provider, WAV, content-addressed cache) · `lib/video/captions.ts` (VTT from script + alignment, script-hash bound) · `lib/video/scenes.ts` (8 scene kinds → HTML, fit rules, layout issues) · `lib/video/render.ts` (Playwright rasterizer measuring real overflow, ffmpeg composer, ffprobe, mock deps, availability) · `lib/video/artifact-qa.ts` · `lib/video/distribution.ts` (local_storage ACCESS_GATED; unlisted_youtube declared SHAREABLE_BY_LINK, not implemented) · `lib/prospects/video-walkthrough.ts` (lane: config, stages, generation key, prepare, job, binding, release recheck, requeue, reconstruction) · contract extension (`MismatchInterpretationScene`, recorded intro line, recommendation line, `assertVideoScriptReleasable`, `narrationSegments`, `scriptHash`) · migration 113 · `scripts/video-walkthrough-smoke.ts`.

## Video input contract
`VideoWalkthroughInput` = prospect {name, firstName, entityType} · market · evidencePackageId (evidence hash) · factManifestId · manifest · approvedExamples[] · approvedFirstAction|null · reportArtifact {artifactId, revision} · templateVersion · introAssetVersion (+ registry transcript) · voiceVersion. No figure is accepted from a caller; the lane compiles the input from the persisted manifest and the published report block, and the job recompiles and compares the content hash before spending.

## Versions bound per revision
evidence hash · manifest hash · contract v1 · script template v1 · connective copy v1 · video template v1 · intro asset version · voice version. `generation_key` = sha256 of prospect + manifest hash + all versions (unique per handoff/kind). A changed manifest → `markArtifactsStale` (stage `stale`) → a new revision on the next lane pass.

## Failure classes
RETRYABLE (provider timeout/5xx/429, ffmpeg/Chromium failure): stage `failed_retryable`, rethrow → job backoff; after `VIDEO_MAX_ATTEMPTS` → `review_required` (RETRIES_EXHAUSTED). REVIEW_REQUIRED (auth/quota/bad input, script QA, semantic BLOCK, artifact QA incl. VIDEO_DURATION_QA_FAIL, missing/checksum-failed intro, voice not configured, manifest mismatch, renderer unavailable at prepare). TERMINAL (handoff stopped, DNC, suppression) → `review_required` with the class recorded; STALE (manifest superseded / correction) → `stale`, never releasable, never requeued.

## Configuration
`VIDEO_WALKTHROUGH_MODE` (SHADOW default | CANARY | MANUAL_ONLY) · `VIDEO_WALKTHROUGH_KILL_SWITCH` (no new jobs) · `VIDEO_WALKTHROUGH_RELEASE_KILL_SWITCH` (no release in any mode) · `VIDEO_DISTRIBUTION` (local_storage) · `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` · `VIDEO_TTS_PROVIDER=mock` and `VIDEO_ALLOW_FIXTURE_INTRO=true` (refused when NODE_ENV=production). Founder intro: `var/video-assets/founder-intro/founder-intro-v1.mp4` (registry sha256 to be filled after recording).

## Worker prerequisites
ffmpeg, ffprobe and Playwright Chromium on the worker; `rendererAvailability()` parks preparation as `RENDERER_UNAVAILABLE` (no job, no spend) when absent.

## Acceptance (tests)
Unit: `tests/unit/video-walkthrough-contract.test.ts` (39–44 + matrix 3–19), `tests/unit/video-pipeline.test.ts` (20–31, 34–40, 46–49, config, states, failure classes). Integration (`tests/integration/report-handoff.test.ts` → "spec 138"): 50/1/2/52/54 happy path + reconstruction, 44/32/21 concurrent workers + idempotent retry with cached narration, 19/51 semantic BLOCK isolation + requeue, 28/31 duration fail + missing intro, 41/42/53/7 correction during render → stale, 43 suppression + kill switches. Smoke: `scripts/video-walkthrough-smoke.ts` (real Chromium + ffmpeg, mock narration).

## Production hardening pass (2026-09-11, same branch)
Inspection of the committed lane against the hardening brief found the architecture in place (one manifest → compiled script → one reviewer → cached TTS → stills + ffmpeg → structural QA → immutable MP4 → adapter) and these real gaps, each fixed at the smallest layer:
- **Script v2** (`video-script-v2`): v1 narrated "your team closed $56.9M closed" (the volume display already carries "closed"). v2: "…{ref} came in at {volume}, and {competitor} came in at {volume}." A template bump is a new generation key; no historical artifact exists.
- **Entity fails closed in the video's own QA**: `entity_unknown` when the manifest's `FACT_PROSPECT_ENTITY_TYPE` is outside the canonical `team | individual` set (the ONLY set the manifest can hold — `compileFactManifest` already refuses a null type upstream), `entity_mismatch` when the compiled input disagrees with the manifest. A brokerage is not renderable until the manifest learns it; the video never resolves an entity itself.
- **Zero case on screen**: banned patterns (`∞`, "infinite/ly", "Infinityx") now run over displayed scene props as well as the narration (`…_on_screen` reason codes). A zero prospect count shows "0 of 256" and no multiple.
- **Founder intro before spend**: in production a registry entry without a sha256 (`FOUNDER_INTRO_UNREGISTERED_CHECKSUM`) or the fixture (`FOUNDER_INTRO_FIXTURE_IN_PRODUCTION`) parks the job; the clip is probed (video stream, 2–20 s) BEFORE the reviewer, TTS or render can cost anything.
- **Pronunciation without touching display**: `VoiceProfile.pronunciation` (versioned whole-word alias table, empty in `pronunciation-v1`) changes only the text the provider hears; canonical text, captions and the script hash are untouched; provider alignment is dropped when spoken ≠ canonical (proportional cue timing). The narration cache key carries the pronunciation version; the table rides the voice version, so a changed alias is a new generation.
- **Stills for operator review**: the exact rasterized PNG of every narrated scene is stored (`screenshot` evidence_artifacts under the MP4's key) and listed in `meta.render.stills`; storing a still never fails a render.
- **Crash reconciliation**: canonical bytes on disk without a ledger row (crash between write and insert) are adopted, never re-rendered; a row with a different checksum is a conflict → review.
- **Deliverability is a release condition**: `DistributionAdapter.deliverable(env)`; `local_storage` is deliverable outside production, and in production only with `VIDEO_LOCAL_STORAGE_SERVABLE=true` (the worker's evidence root is ephemeral and the web app cannot read it: Railway has no volume on `worker`, `var/` is git-ignored). `videoReleaseRecheck` fails closed with `DISTRIBUTION_NOT_DELIVERABLE`, so a report_and_video handoff never promises a walkthrough the prospect cannot open. The artifact itself still reaches `release_ready`; nothing is re-spent when the flag is set.

Verified on prod (read-only): migration 113 NOT applied (the lane is not live; it applies on the next worker deploy), Laura's handoff `release_ready`/SHADOW under the not-yet-deployed policy code, no video rows, no video jobs. Local fixture smoke (real Chromium + ffmpeg, mock narration): 84.3 s, 1920×1080 h264/aac @ ~30 fps, render 10.1 s, QA pass. The worker-image smoke could not run from this session (no Docker locally); it now runs in `.github/workflows/docker.yml` inside the freshly built worker image (`VIDEO_RUNTIME_CHECK_REQUIRE_INTRO=false`, mock narration) on every change to the Dockerfiles, `lib/video/**` or the smoke scripts. The DEPLOYED worker (inspected read-only over SSH — `railway ssh` fails host-key verification; `railway ssh config --dry-run` + `ssh -F … -o StrictHostKeyChecking=accept-new` works) is still the main-branch image: no ffmpeg, ffprobe, Chromium, fonts or intro asset. It must be redeployed from this branch before any real shadow render.
