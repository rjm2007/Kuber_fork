"use client";

import { useEffect, useState } from "react";
import { Building2, FileSpreadsheet, Search, Sparkles, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApolloForm, ExcelForm, ManualForm, type ManualFormProps } from "@/components/app/lead-forms";
import { CompanyLookupForm } from "@/components/app/company-lookup-form";
import { ProspectFinderForm } from "@/components/app/prospect-finder-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccess } from "@/lib/access-context";
import type { Scope } from "@/lib/auth/scopes";

interface AddLeadsDrawerProps {
  open: boolean;
  onClose: () => void;
  onImport: (count: number) => void;
  defaultTab?: "apollo" | "excel" | "manual";
  prefillOrg?: ManualFormProps["prefillOrg"];
  prefillLeads?: ManualFormProps["prefillLeads"];
  editMode?: boolean;
}

type SectionKey = "apollo" | "scored" | "company" | "excel" | "manual";

// Re-opening Add Leads lands on the source the manager used last (e.g. a
// Scored Companies search still running in the background), per browser tab.
const LAST_SECTION_KEY = "kuber.addLeads.section";
function lastSection(fallback: SectionKey): SectionKey {
  try {
    const v = sessionStorage.getItem(LAST_SECTION_KEY) as SectionKey | null;
    return v && ["apollo", "scored", "company", "excel", "manual"].includes(v) ? v : fallback;
  } catch { return fallback; }
}

// Each source has its own scope (they spend different credits).
const SECTIONS: { value: SectionKey; label: string; icon: typeof Search; description: string; scope: Scope }[] = [
  { value: "apollo",  label: "Apollo search",  icon: Search,          scope: "imports:apollo",  description: "Filter Apollo's database by industry, title & location" },
  { value: "scored",  label: "Scored companies", icon: Sparkles,      scope: "prospects:run",   description: "AI scores companies first; reveal one contact only at good fits" },
  { value: "company", label: "Company lookup", icon: Building2,       scope: "imports:company", description: "Find one company by name and pick its contacts" },
  { value: "excel",   label: "Excel / CSV",    icon: FileSpreadsheet, scope: "imports:excel",   description: "Upload a spreadsheet and map its columns" },
  { value: "manual",  label: "Manual entry",   icon: UserPlus,        scope: "imports:manual",  description: "Add an organization and its people by hand" },
];

export function AddLeadsDrawer({
  open, onClose, onImport,
  defaultTab = "apollo",
  prefillOrg, prefillLeads, editMode,
}: AddLeadsDrawerProps) {
  const { can } = useAccess();
  // Openers are gated on holding any imports:* scope; the rail shows only the sources this member holds.
  const allowed = SECTIONS.filter((s) => can(s.scope));
  const pick = (k: SectionKey): SectionKey => (allowed.some((s) => s.value === k) ? k : allowed[0]?.value ?? "manual");
  const [section, setSection] = useState<SectionKey>(prefillOrg ? "manual" : pick(defaultTab));

  // Re-sync the active section whenever the dialog is (re)opened — mirrors the
  // previous implementation's `key={initialTab + prefillOrg?.id}` reset trick.
  useEffect(() => {
    if (open) setSection(prefillOrg ? "manual" : pick(lastSection(defaultTab)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillOrg?.id, defaultTab]);

  function handleImport(count: number) {
    onImport(count);
    onClose();
  }

  // Editing an existing org, or a manual-entry prefill, is a single focused
  // task — there's nothing else to switch between, so the source rail (which
  // only makes sense when choosing *how* to source new leads) is hidden and
  // the Manual form gets the full width instead. One allowed source = no rail either.
  const singleSection = editMode || !!prefillOrg;
  const hideRail = singleSection || allowed.length <= 1;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* From lg up it centres in the space right of the sidebar (--app-sidebar-w, set by app-shell)
          and never grows over it. */}
      <DialogContent className="flex h-[min(46rem,90vh)] w-full max-w-6xl flex-col gap-0 overflow-hidden rounded-lg p-0 lg:left-[calc(50%+var(--app-sidebar-w,0px)/2)] lg:max-w-[min(72rem,calc(100vw-var(--app-sidebar-w,0px)-2rem))]">
        {/* 48px Attio header bar (the dialog's own close button sits at its right). */}
        <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-2.5 space-y-0 border-b border-border pl-4 pr-12 text-left">
          <DialogTitle className="shrink-0 text-[15px]">{editMode ? "Edit leads" : "Add leads"}</DialogTitle>
          <p className="min-w-0 truncate text-[13px] text-muted-foreground">
            {editMode ? "Update organization and linked people." : "Source leads via Apollo, Excel, or manual entry."}
          </p>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex-row">
          {!hideRail && (
            <nav className="flex max-h-40 w-full shrink-0 flex-col gap-0.5 overflow-y-auto border-b border-border bg-sidebar p-2 md:max-h-none md:w-64 md:border-b-0 md:border-r">
              {allowed.map((s) => {
                const Icon = s.icon;
                const active = section === s.value;
                return (
                  <Button
                    key={s.value}
                    type="button"
                    variant="ghost"
                    onClick={() => { setSection(s.value); try { sessionStorage.setItem(LAST_SECTION_KEY, s.value); } catch { /* private mode */ } }}
                    className={cn(
                      "h-auto w-full min-w-0 flex-col items-start gap-0.5 whitespace-normal rounded-md px-2.5 py-2 text-left font-normal",
                      active
                        ? "bg-accent text-foreground hover:bg-accent"
                        : "text-foreground hover:bg-hover",
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2 text-[13px] font-medium">
                      <Icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
                      {s.label}
                    </span>
                    <span className="w-full min-w-0 whitespace-normal wrap-break-word pl-6 text-xs font-normal leading-snug text-muted-foreground">
                      {s.description}
                    </span>
                  </Button>
                );
              })}
            </nav>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {singleSection ? (
              <ManualForm
                onImport={handleImport}
                prefillOrg={prefillOrg ? { ...prefillOrg, id: prefillOrg.id } : undefined}
                prefillLeads={prefillLeads}
                editMode={editMode}
              />
            ) : (
              <>
                {section === "apollo" && <ApolloForm onImport={handleImport} />}
                {section === "scored" && <ProspectFinderForm onDone={onClose} />}
                {section === "company" && <CompanyLookupForm onImport={handleImport} />}
                {section === "excel" && <ExcelForm onImported={onImport} onDone={onClose} />}
                {section === "manual" && <ManualForm onImport={handleImport} />}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
