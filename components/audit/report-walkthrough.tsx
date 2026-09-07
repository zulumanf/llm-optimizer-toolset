/**
 * Pick a time for the walkthrough (spec 128). Token-gated like the report;
 * records no audit view of its own. Plain slots in the prospect's zone,
 * one submit, confirmation inline; the pick is forwarded to the operator.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Newsreader } from "next/font/google";
import { WalkthroughForm } from "@/components/audit/walkthrough-form";
import { groupSlotsByDay, walkthroughContext, walkthroughSlots, WALKTHROUGH_MINUTES } from "@/lib/prospects/walkthrough";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Pick a time",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default async function WalkthroughPage({
  params,
}: {
  params: Promise<{ handle: string; linkKey?: string; slug?: string }>;
}) {
  const { handle: token, linkKey, slug } = await params;
  const ctx = await walkthroughContext(token);
  if (!ctx) notFound();
  const days = groupSlotsByDay(walkthroughSlots(new Date(), ctx.timezone));
  const backHref = linkKey && slug ? `/audit/${slug}/${linkKey}` : `/audit/${token}`;
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-xs font-medium uppercase tracking-[0.18em]">Recommended First</p>
      <p className="mt-1 text-xs text-muted-foreground">{ctx.prospectName} · {ctx.marketName}</p>
      <h1 className={`${serif.className} mt-6 text-balance text-3xl leading-tight`}>Pick a time and I’ll walk you through it.</h1>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
        {WALKTHROUGH_MINUTES} minutes. Which parts of this I think matter, which I wouldn’t worry about, and the first two or three things I’d investigate for your team.
      </p>
      <div className="mt-8">
        <WalkthroughForm token={token} days={days} />
      </div>
      <p className="mt-10 text-xs text-muted-foreground">
        <Link href={backHref} className="underline underline-offset-2 hover:text-foreground">Back to the report</Link>
        {" · "}Or just reply to the email the report came from.
      </p>
    </div>
  );
}
