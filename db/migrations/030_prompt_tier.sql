-- Roadmap 1.2: persist the prompt intent tier (1 = narrow high-intent,
-- 4 = broad category — lib/verticals/types.ts). Onboarding generated tiers
-- from pack templates and then discarded them, so funnel-stage segmentation
-- was claimed but impossible. Nullable is deliberate: historical prompts
-- were never tiered, and a guessed tier is worse than an honest null.

-- +migrate up
alter table prompts add column tier int check (tier between 1 and 4);

-- +migrate down
alter table prompts drop column tier;
