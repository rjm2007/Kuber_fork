import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one place Apollo credit-cost messaging is worded and styled — used
 * twice in every Apollo-backed import flow (Company Lookup and the direct
 * Apollo people-search import): once where the count that drives cost is
 * chosen (people picked, or the leads-per-import cap), and once as a final
 * confirmation right before the button that actually spends the credits.
 *
 * Cost model (docs/apollo-credit-usage-rca.md §2): search itself is free;
 * revealing a person's email is 1 credit each, charged whether or not Apollo
 * has an email on file. Org search is a different, page-based model (1
 * credit per page of results, not per org) — pass `perPage` for that case
 * instead of a per-contact count.
 */
export function ApolloCostNote({
  credits,
  spendingOn,
  rate = "1 credit per contact, charged whether or not Apollo has an email on file.",
  mock = false,
  className,
}: {
  /** Total credits this action will cost right now. 0 renders a neutral "free" note instead of a warning. */
  credits: number;
  /** Clause completing "will spend N credit(s) ", e.g. "revealing emails for the 12 selected contacts". */
  spendingOn: string;
  /** Small-print rate explainer shown under the headline. */
  rate?: string;
  /** True in test-mode workspaces — same UI, same real credit count, just tagged "(test)" since no real credits actually move. */
  mock?: boolean;
  className?: string;
}) {
  if (credits <= 0) {
    return (
      <div className={cn("flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-[11px] text-muted-foreground", className)}>
        <Coins className="size-3.5 shrink-0 mt-0.5" />
        <p>No credits spent yet — nothing selected.</p>
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] text-amber-600 dark:text-amber-400", className)}>
      <Coins className="size-3.5 shrink-0 mt-0.5" />
      <p>
        Will spend <strong>{credits.toLocaleString()} Apollo credit{credits === 1 ? "" : "s"}</strong> {spendingOn}
        {mock && <> <strong>(test)</strong></>}.
        {rate && <span className="block text-amber-600/70 dark:text-amber-400/70 mt-0.5">{rate}{mock && " No real credits move in test mode."}</span>}
      </p>
    </div>
  );
}
