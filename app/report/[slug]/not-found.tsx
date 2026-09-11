/**
 * The private-report access state (spec 134): what a browser without an
 * authorized session sees at /report/<anything>. Identical for unknown
 * slugs, revoked reports and expired sessions — it names no prospect and
 * reveals nothing about whether a report exists.
 */
import { Newsreader } from "next/font/google";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"] });

export default function PrivateReportState() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24">
      <p className="text-xs font-medium uppercase tracking-[0.18em]">Recommended First</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">Private report</p>
      <h1 className={`${serif.className} mt-6 text-balance text-3xl leading-tight`}>
        This report opens from its invitation.
      </h1>
      <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Private reports are prepared for one team and open only from the link in the email that
        delivered them. If you were forwarded that email, click the link inside it. If the link
        no longer works, reply to that email and I&apos;ll sort it out.
      </p>
      <p className="mt-10 text-xs text-muted-foreground">Private · Not publicly indexed</p>
    </div>
  );
}
