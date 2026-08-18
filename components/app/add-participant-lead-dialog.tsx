"use client";

import { useEffect, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Promote a thread participant into a lead.
 *
 * Asks for the name and nothing else. Everything else is already known from the
 * thread — the address, and the organisation and owner inherited from the lead
 * whose conversation this is — so those are shown read-only rather than made
 * into fields somebody has to re-enter and could get wrong.
 *
 * A first name is required because it is not decoration: campaign templates
 * render {{firstName}}, and a lead created without one silently addresses its
 * next email to "there".
 */
export function AddParticipantLeadDialog({
  open,
  email,
  organizationName,
  ownerName,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  email: string | null;
  organizationName: string | null;
  ownerName: string | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (firstName: string, lastName: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Reset per participant — reopening for a different address must never carry
  // the previous person's name across.
  useEffect(() => {
    setFirstName("");
    setLastName("");
  }, [email, open]);

  const canSubmit = firstName.trim().length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add as lead</DialogTitle>
          <DialogDescription>
            They replied on this thread but are not a lead yet. Adding them keeps
            the stakeholder on the account instead of only inside one inbox.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
            <Row label="Email" value={email ?? "—"} mono />
            <Row label="Organization" value={organizationName ?? "—"} />
            <Row label="Owner" value={ownerName ?? "Unassigned"} />
            <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
              Organization and owner are inherited from this thread&apos;s lead. The new
              contact starts in no campaign — add them to one when you are ready.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="participant-first-name">First name</Label>
              <Input
                id="participant-first-name"
                value={firstName}
                autoFocus
                disabled={saving}
                onChange={(e) => setFirstName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) onConfirm(firstName.trim(), lastName.trim()); }}
                placeholder="Required"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="participant-last-name">Last name</Label>
              <Input
                id="participant-last-name"
                value={lastName}
                disabled={saving}
                onChange={(e) => setLastName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) onConfirm(firstName.trim(), lastName.trim()); }}
                placeholder="Optional"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => onConfirm(firstName.trim(), lastName.trim())}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <UserPlus className="size-3.5" />}
            Add lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="eyebrow shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-right text-xs ${mono ? "font-mono" : "font-medium"}`} title={value}>
        {value}
      </span>
    </div>
  );
}
