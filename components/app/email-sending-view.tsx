"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Mail, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useApp } from "@/lib/app-context";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchSendingAccounts,
  setSendingAccount,
  type InstantlySendingAccount,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

export function EmailSendingView() {
  const { session } = useApp();
  const [accounts, setAccounts] = useState<InstantlySendingAccount[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [draftEmail, setDraftEmail] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => accounts.find((account) => account.email === selectedEmail) ?? null,
    [accounts, selectedEmail],
  );

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await fetchSendingAccounts(session.access_token);
      setAccounts(data.accounts);
      setSelectedEmail(data.selected_email);
      setDraftEmail(data.selected_email ?? "");
      setSelectionRequired(data.selection_required);
      if (refresh) toast.success("Mailboxes refreshed from Instantly");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  async function handleSave() {
    if (!session || !draftEmail) return;
    setSaving(true);
    try {
      const result = await setSendingAccount(session.access_token, draftEmail);
      setSelectedEmail(result.selected_email);
      setDraftEmail(result.selected_email);
      setSelectionRequired(false);
      toast.success(`${result.selected_email} will send new campaigns`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="h-40 rounded-xl border border-border bg-card animate-pulse" />
      </div>
    );
  }

  const activeCount = accounts.filter((account) => account.can_send).length;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8 enter">
      <header className="space-y-1">
        <p className="eyebrow px-1">Settings · Email &amp; Sending</p>
        <h2 className="font-display text-lg font-semibold px-1">Email &amp; Sending</h2>
        <p className="text-xs text-muted-foreground px-1">
          Choose one connected Instantly mailbox for new campaign sends.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4 px-1">
          <div>
            <p className="eyebrow">Default sending account</p>
            <p className="text-xs text-muted-foreground mt-1">
              {accounts.length} connected · {activeCount} able to send
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => void load(true)}
            className="gap-1.5"
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="p-5 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="sending-account">
                Mailbox
              </label>
              <Select value={draftEmail} onValueChange={setDraftEmail}>
                <SelectTrigger id="sending-account">
                  <SelectValue placeholder="Select an active Instantly mailbox" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem
                      key={account.email}
                      value={account.email}
                      disabled={!account.can_send}
                    >
                      <span className="flex items-center gap-2">
                        <span>{account.email}</span>
                        <span className={cn(
                          "text-[10px]",
                          account.can_send ? "text-emerald-500" : "text-destructive",
                        )}>
                          {account.status_label}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The list and send status come directly from the Instantly Accounts API.
                Paused or errored mailboxes cannot be selected.
              </p>
            </div>

            <Button
              onClick={() => void handleSave()}
              disabled={!draftEmail || draftEmail === selectedEmail || saving}
              className="min-w-28"
            >
              {saving && <RefreshCw className="size-3.5 mr-1.5 animate-spin" />}
              Use account
            </Button>
          </div>

          <div className={cn(
            "border-t border-border px-5 py-3.5 flex items-start gap-3",
            selectionRequired ? "bg-amber-500/5" : selected?.can_send ? "bg-emerald-500/5" : "bg-secondary/20",
          )}>
            {selectionRequired ? (
              <TriangleAlert className="size-4 text-amber-500 shrink-0 mt-0.5" />
            ) : selected?.can_send ? (
              <CheckCircle2 className="size-4 text-emerald-500 shrink-0 mt-0.5" />
            ) : (
              <Mail className="size-4 text-muted-foreground shrink-0 mt-0.5" />
            )}
            <div>
              <p className="text-xs font-medium">
                {selectionRequired
                  ? "Select one mailbox"
                  : selected?.can_send
                    ? `${selected.email} can send`
                    : "No active sending account selected"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selectionRequired
                  ? "The old configuration contains multiple addresses. Choose which single account new campaigns should use."
                  : selected
                    ? `${selected.status_label}${selected.daily_limit != null ? ` · Daily limit ${selected.daily_limit}` : ""}`
                    : "Connect or repair a mailbox in Instantly, then refresh this list."}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
