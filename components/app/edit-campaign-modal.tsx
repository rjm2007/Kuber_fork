"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Clock, Globe, Calendar, Gauge, X, Lock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DAY_LABELS, type Campaign } from "@/components/app/create-campaign-modal";
import { extractFollowupWaitsFromSteps, rebuildStepsWithFollowupWaits } from "@/lib/constants";
import { fetchCampaignSteps, patchCampaignConfig, saveCampaignSteps } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const TIMEZONES = [
  "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Bangkok",
  "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles",
];

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? "00" : "30";
  const value = `${String(h).padStart(2, "0")}:${m}`;
  const period = h >= 12 ? "PM" : "AM";
  const dh = h % 12 || 12;
  return { value, label: `${String(dh).padStart(2, "0")}:${m} ${period}` };
});

function DayPill({ day, active, onClick, disabled }: { day: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="icon"
      onClick={onClick}
      disabled={disabled}
      className="size-8 rounded-full text-xs leading-none font-semibold"
    >
      <span className="translate-y-px">{day[0].toUpperCase()}</span>
    </Button>
  );
}

function TimeSelect({ value, onChange, disabled, className }: { value: string; onChange: (v: string) => void; disabled?: boolean; className?: string }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn("h-9 w-32 tabular-nums", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="center" className="min-w-32 max-h-56">
        {TIME_OPTIONS.map((t) => (
          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Shared-settings notice shown on the Options/Sequences forms — a campaign is a
 *  container that can hold leads owned by several employees at once, so these
 *  settings apply to everyone's leads in it, not just the viewer's own. */
export function SharedSettingsNotice({ readOnly, className }: { readOnly: boolean; className?: string }) {
  const Icon = readOnly ? Lock : Info;
  return (
    <div className={cn("flex items-center gap-2.5 text-[13px] leading-snug text-foreground", className)}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
        <Icon className="size-3.5 text-amber-600 dark:text-amber-400" />
      </span>
      <span>
        {readOnly
          ? "This campaign holds another teammate's leads, so only a manager can change its settings — they are shared by the whole campaign, and every lead in it sends under them."
          : (
            <>
              <span className="font-medium">Shared campaign settings</span>
              {" — changes here apply to every lead in this campaign, not just the ones you are looking at."}
            </>
          )}
      </span>
    </div>
  );
}

type FollowupStep = { delay: number; delay_unit: "minutes" | "hours" | "days" };

export function EditCampaignForm({
  campaign,
  onSaved,
  className,
  variant = "modal",
  readOnly = false,
}: {
  campaign: Campaign;
  onSaved?: (patch: Partial<Campaign>) => void;
  className?: string;
  /** "modal" = boxed card (used in the narrow edit dialog). "page" = borderless, spread across full width (used in the campaign drawer). */
  variant?: "modal" | "page";
  /** Manager-only settings, viewed by a non-manager: render every control disabled, hide Save. */
  readOnly?: boolean;
}) {
  const [senderName, setSenderName] = useState(campaign.senderName ?? "");
  const [aiPromptContext, setAiPromptContext] = useState(campaign.aiPromptContext ?? "");
  const [dailyLimit, setDailyLimit] = useState(campaign.dailyLimit ?? 30);
  const [windowFrom, setWindowFrom] = useState(campaign.windowFrom ?? "08:00");
  const [windowTo, setWindowTo] = useState(campaign.windowTo ?? "18:00");
  const [timezone, setTimezone] = useState(campaign.timezone ?? "Asia/Kolkata");
  const [sendDays, setSendDays] = useState<Record<string, boolean>>(
    campaign.sendDays ?? { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
  );
  const [followupSteps, setFollowupSteps] = useState<FollowupStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [stepsLoading, setStepsLoading] = useState(true);

  // Reset + load steps whenever campaign changes
  useEffect(() => {
    setSenderName(campaign.senderName ?? "");
    setAiPromptContext(campaign.aiPromptContext ?? "");
    setDailyLimit(campaign.dailyLimit ?? 30);
    setWindowFrom(campaign.windowFrom ?? "08:00");
    setWindowTo(campaign.windowTo ?? "18:00");
    setTimezone(campaign.timezone ?? "Asia/Kolkata");
    setSendDays(campaign.sendDays ?? { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false });

    async function loadSteps() {
      setStepsLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { steps } = await fetchCampaignSteps(session.access_token, campaign.id);
        const followups = extractFollowupWaitsFromSteps(steps);
        setFollowupSteps(followups.length > 0 ? followups : [{ delay: 30, delay_unit: "days" }]);
      } catch {
        setFollowupSteps([{ delay: 30, delay_unit: "days" }]);
      } finally {
        setStepsLoading(false);
      }
    }
    void loadSteps();
  }, [campaign.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (readOnly) return;
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // 1. Patch campaign config (schedule, limit, sender, AI context)
      //
      // schedule_timezone is sent ONLY when the user actually changed it. The
      // "page" variant renders no timezone control at all (the window is stated
      // as local time of the recipient), so on that screen this is never dirty
      // and never sent — which is the point: it used to be resubmitted on every
      // save, carrying the campaign's auto-detected zone down onto every
      // country sub-campaign. See docs/campaign-timezone-rca.md.
      const timezoneChanged = timezone !== (campaign.timezone ?? "Asia/Kolkata");
      const result = await patchCampaignConfig(session.access_token, campaign.id, {
        daily_limit: dailyLimit,
        window_from: windowFrom,
        window_to: windowTo,
        ...(timezoneChanged ? { schedule_timezone: timezone } : {}),
        send_days: sendDays,
        sender_name: senderName || undefined,
        ai_prompt_context: aiPromptContext || undefined,
      });

      // 2. Rebuild steps — Instantly stores delay on step N as wait before step N+1
      const { steps: currentSteps } = await fetchCampaignSteps(session.access_token, campaign.id);
      const rebuilt = rebuildStepsWithFollowupWaits(currentSteps, followupSteps);

      await saveCampaignSteps(session.access_token, campaign.id, rebuilt);

      if (result.sync_errors.length > 0) {
        toast.warning("Saved, but Instantly sync had errors: " + result.sync_errors[0]);
      } else {
        toast.success("Campaign updated");
      }

      onSaved?.({ senderName, aiPromptContext, dailyLimit, windowFrom, windowTo, timezone, sendDays });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isPage = variant === "page";

  const followupList = stepsLoading ? (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border p-3">
          <div className="size-5 rounded bg-secondary shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-32 bg-secondary rounded" />
            <div className="h-2.5 w-20 bg-secondary/60 rounded" />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <div
      className={cn(
        isPage
          ? "grid w-full grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          : "space-y-2",
      )}
    >
      {followupSteps.map((step, idx) => (
        <div
          key={idx}
          className={cn("flex items-center shrink-0", isPage ? "gap-2" : "w-full")}
        >
          {isPage ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs leading-none font-semibold text-primary tabular-nums">
              <span className="translate-y-px">{idx + 1}</span>
            </span>
          ) : null}
          <div
            className={cn(
              "flex items-center rounded-lg border border-border bg-secondary/50",
              isPage ? "w-fit gap-1.5 px-2 py-1.5" : "w-full flex-1 min-w-0 gap-1.5 px-3 py-2",
            )}
          >
            <span className={cn("text-xs text-muted-foreground shrink-0 whitespace-nowrap", !isPage && "w-24")}>
              Follow-up {idx + 1} after
            </span>
            <Input
              type="number"
              min={1}
              max={365}
              value={step.delay}
              disabled={readOnly}
              onChange={(e) => {
                const v = Math.max(1, Math.min(365, Number(e.target.value) || 1));
                setFollowupSteps((prev) => prev.map((s, i) => i === idx ? { ...s, delay: v } : s));
              }}
              className="h-7 w-14 rounded-md border border-border bg-field px-1 py-0 text-center text-sm font-mono font-medium tabular-nums focus-visible:ring-1 focus-visible:ring-offset-0"
            />
            <Select
              value={step.delay_unit}
              disabled={readOnly}
              onValueChange={(unit) =>
                setFollowupSteps((prev) =>
                  prev.map((s, i) => i === idx ? { ...s, delay_unit: unit as FollowupStep["delay_unit"] } : s),
                )
              }
            >
              <SelectTrigger className="h-7 w-fit min-w-0 justify-start gap-0 border-0 bg-transparent pl-0 pr-1 -ml-1 text-xs text-muted-foreground shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-24">
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
                <SelectItem value="days">days</SelectItem>
              </SelectContent>
            </Select>
            {!isPage && <div className="flex-1" />}
            {!readOnly && followupSteps.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setFollowupSteps((prev) => prev.filter((_, i) => i !== idx))}
                className="size-5 shrink-0 rounded p-0.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Remove follow-up ${idx + 1}`}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      ))}
      {!readOnly && followupSteps.length < 8 && (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() =>
            setFollowupSteps((prev) => {
              const last = prev[prev.length - 1];
              return [...prev, { delay: (last?.delay ?? 0) + 30, delay_unit: last?.delay_unit ?? "days" }];
            })
          }
          className={cn(
            "h-auto p-0 text-xs font-medium",
            isPage && "col-span-full",
          )}
        >
          + Add follow-up step
        </Button>
      )}
    </div>
  );

  if (isPage) {
    const fieldBlock = "space-y-2 rounded-xl border border-border bg-card px-5 py-4 shadow-sm";

    return (
      <div className={cn("space-y-6", className)}>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-stretch">
          {/* Left: identity & AI */}
          <div className="flex flex-col lg:col-span-2">
            <p className="eyebrow mb-2">Identity &amp; AI</p>
            <div className="flex flex-1 flex-col gap-6">
              <div className={fieldBlock}>
                <Label className="text-sm font-medium">Sender name</Label>
                <p className="text-xs text-muted-foreground">Shown as the &quot;from&quot; name on outgoing emails</p>
                <Input value={senderName} disabled={readOnly} onChange={(e) => setSenderName(e.target.value)} placeholder="Kuber Polyplast" />
              </div>

              <div className={cn(fieldBlock, "flex flex-1 flex-col")}>
                <Label className="text-sm font-medium">Additional context for AI</Label>
                <p className="text-xs text-muted-foreground">Extra guidance the AI uses when writing emails</p>
                <Textarea
                  value={aiPromptContext}
                  disabled={readOnly}
                  onChange={(e) => setAiPromptContext(e.target.value)}
                  placeholder="e.g. Mention our new biodegradable masterbatch line. Focus on sustainability angle."
                  className="flex-1 min-h-32 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Right: schedule & limits — one compact card, no dead space */}
          <div className="flex flex-col lg:col-span-3">
          <p className="eyebrow mb-2">Schedule &amp; limits</p>
          <div className="flex flex-1 flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 divide-y divide-border sm:divide-y-0 border-b border-border">
              <div className="flex flex-col justify-center gap-3 px-5 py-4 sm:border-r border-border">
                <div className="flex items-center gap-2.5">
                  <Gauge className="size-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm font-medium leading-none">Daily limit</p>
                    <p className="text-xs text-muted-foreground mt-1">Emails sent per day across all senders</p>
                  </div>
                </div>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={dailyLimit}
                  disabled={readOnly}
                  onChange={(e) => setDailyLimit(Math.max(1, Math.min(500, Number(e.target.value))))}
                  className="h-9 w-24 text-center font-mono tabular-nums"
                />
              </div>

              <div className="flex flex-col justify-center gap-3 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <Clock className="size-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-sm font-medium leading-none">Sending window</p>
                    <p className="text-xs text-muted-foreground mt-1">Local time of recipient</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <TimeSelect value={windowFrom} onChange={setWindowFrom} disabled={readOnly} />
                  <span className="text-xs text-muted-foreground">to</span>
                  <TimeSelect value={windowTo} onChange={setWindowTo} disabled={readOnly} />
                </div>
              </div>
            </div>

            <div className="flex flex-1 flex-col justify-center gap-4 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <Calendar className="size-4 text-muted-foreground shrink-0" />
                <div>
                  <p className="text-sm font-medium leading-none">Send days</p>
                  <p className="text-xs text-muted-foreground mt-1">Days emails will be sent</p>
                </div>
              </div>
              <div className="flex items-center flex-wrap gap-2">
                {DAYS.map((day) => (
                  <DayPill
                    key={day}
                    day={DAY_LABELS[day]}
                    active={sendDays[day] ?? false}
                    disabled={readOnly}
                    onClick={() => setSendDays((prev) => ({ ...prev, [day]: !prev[day] }))}
                  />
                ))}
              </div>
            </div>
          </div>
          </div>
        </div>

        {/* Full width: follow-up schedule */}
        <div className={cn(fieldBlock, "space-y-3")}>
          <div className="flex items-center gap-2.5">
            <Clock className="size-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium leading-none">Follow-up schedule</p>
              <p className="text-xs text-muted-foreground mt-1">Wait time after the previous email before each follow-up sends</p>
            </div>
          </div>
          {followupList}
        </div>

        {/* Footer: shared-settings note on the left balances the Save button */}
        <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <SharedSettingsNotice readOnly={readOnly} className="max-w-2xl" />
          {!readOnly && (
            <Button disabled={saving} onClick={() => void handleSave()} className="shrink-0 gap-1.5 self-end sm:self-auto">
              {saving ? (
                <><Loader2 className="size-3.5 animate-spin" /> Saving…</>
              ) : (
                <>Save changes <ChevronRight className="size-3.5" /></>
              )}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Sender name</Label>
        <Input value={senderName} disabled={readOnly} onChange={(e) => setSenderName(e.target.value)} placeholder="Kuber Polyplast" />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Additional context for AI</Label>
        <Textarea
          value={aiPromptContext}
          disabled={readOnly}
          onChange={(e) => setAiPromptContext(e.target.value)}
          placeholder="e.g. Mention our new biodegradable masterbatch line. Focus on sustainability angle."
          rows={3}
        />
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 shadow-sm overflow-hidden">
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y divide-border sm:divide-y-0">

          {/* Daily limit */}
          <div className="flex flex-col gap-3 px-5 py-4 sm:border-r sm:border-b border-border">
            <div className="flex items-center gap-2.5">
              <Gauge className="size-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium leading-none">Daily limit</p>
                <p className="text-xs text-muted-foreground mt-1">Emails sent per day across all senders</p>
              </div>
            </div>
            <Input
              type="number"
              min={1}
              max={500}
              value={dailyLimit}
              disabled={readOnly}
              onChange={(e) => setDailyLimit(Math.max(1, Math.min(500, Number(e.target.value))))}
              className="h-9 w-24 text-center font-mono tabular-nums"
            />
          </div>

          {/* Sending window */}
          <div className="flex flex-col gap-3 px-5 py-4 sm:border-b border-border">
            <div className="flex items-center gap-2.5">
              <Clock className="size-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium leading-none">Sending window</p>
                <p className="text-xs text-muted-foreground mt-1">Local time of recipient</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <TimeSelect value={windowFrom} onChange={setWindowFrom} disabled={readOnly} />
              <span className="text-xs text-muted-foreground">to</span>
              <TimeSelect value={windowTo} onChange={setWindowTo} disabled={readOnly} />
            </div>
          </div>

          {/* Timezone */}
          <div className="flex flex-col gap-3 px-5 py-4 sm:border-r border-border">
            <div className="flex items-center gap-2.5">
              <Globe className="size-4 text-muted-foreground shrink-0" />
              <p className="text-sm font-medium leading-none">Timezone</p>
            </div>
            <Select value={timezone} onValueChange={setTimezone} disabled={readOnly}>
              <SelectTrigger className="h-9 w-full sm:w-45 font-mono">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-45">
                {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((tz) => (
                  <SelectItem key={tz} value={tz} className="font-mono">{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Send days */}
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-center gap-2.5">
              <Calendar className="size-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium leading-none">Send days</p>
                <p className="text-xs text-muted-foreground mt-1">Days emails will be sent</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day) => (
                <DayPill
                  key={day}
                  day={DAY_LABELS[day]}
                  active={sendDays[day] ?? false}
                  disabled={readOnly}
                  onClick={() => setSendDays((prev) => ({ ...prev, [day]: !prev[day] }))}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Follow-up schedule */}
        <div className="border-t border-border px-5 py-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <Clock className="size-4 text-muted-foreground shrink-0" />
            <div>
              <p className="text-sm font-medium leading-none">Follow-up schedule</p>
              <p className="text-xs text-muted-foreground">Wait time after the previous email before each follow-up sends</p>
            </div>
          </div>
          {followupList}
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <SharedSettingsNotice readOnly={readOnly} />
        {!readOnly && (
          <Button disabled={saving} onClick={() => void handleSave()} className="shrink-0 gap-1.5 self-end sm:self-auto">
            {saving ? (
              <><Loader2 className="size-3.5 animate-spin" /> Saving…</>
            ) : (
              <>Save changes <ChevronRight className="size-3.5" /></>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

export function EditCampaignModal({
  open,
  onClose,
  campaign,
  onSaved,
  readOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  campaign: Campaign;
  onSaved?: (patch: Partial<Campaign>) => void;
  readOnly?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <DialogHeader className="swatch-bar-top border-b border-border px-6 pt-6 pb-4 text-left">
          <p className="eyebrow mb-1">Editing · {campaign.name}</p>
          <DialogTitle className="font-display text-xl">Edit campaign</DialogTitle>
        </DialogHeader>

        <div className="max-h-[68vh] overflow-y-auto px-6 py-5">
          <EditCampaignForm
            campaign={campaign}
            readOnly={readOnly}
            onSaved={(patch) => {
              onSaved?.(patch);
              onClose();
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
