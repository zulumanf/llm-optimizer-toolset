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
