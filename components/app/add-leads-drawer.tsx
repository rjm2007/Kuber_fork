"use client";

import { useEffect, useState } from "react";
import { Building2, FileSpreadsheet, Search, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApolloForm, ExcelForm, ManualForm, type ManualFormProps } from "@/components/app/lead-forms";
import { CompanyLookupForm } from "@/components/app/company-lookup-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/lib/app-context";

interface AddLeadsDrawerProps {
  open: boolean;
  onClose: () => void;
  onImport: (count: number) => void;
  defaultTab?: "apollo" | "excel" | "manual";
  prefillOrg?: ManualFormProps["prefillOrg"];
  prefillLeads?: ManualFormProps["prefillLeads"];
  editMode?: boolean;
}

type SectionKey = "apollo" | "company" | "excel" | "manual";

const SECTIONS: { value: SectionKey; label: string; icon: typeof Search; description: string }[] = [
  { value: "apollo",  label: "Apollo Search",  icon: Search,          description: "Filter Apollo's database by industry, title & location" },
  { value: "company", label: "Company Lookup", icon: Building2,       description: "Find one company by name and pick its contacts" },
  { value: "excel",   label: "Excel / CSV",    icon: FileSpreadsheet, description: "Upload a spreadsheet and map its columns" },
  { value: "manual",  label: "Manual Entry",   icon: UserPlus,        description: "Add an organization and its people by hand" },
];

export function AddLeadsDrawer({
  open, onClose, onImport,
  defaultTab = "apollo",
  prefillOrg, prefillLeads, editMode,
}: AddLeadsDrawerProps) {
  const { role } = useApp();
  // Only managers can pull from Apollo or bulk-import via Excel — employees
  // are restricted to adding leads by hand, matching the old dedicated
  // /leads/add page's role gate.
  const isManager = role === "manager";
  const [section, setSection] = useState<SectionKey>(prefillOrg ? "manual" : (isManager ? defaultTab : "manual"));

  // Re-sync the active section whenever the dialog is (re)opened — mirrors the
  // previous implementation's `key={initialTab + prefillOrg?.id}` reset trick.
  useEffect(() => {
    if (open) setSection(prefillOrg ? "manual" : (isManager ? defaultTab : "manual"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillOrg?.id, defaultTab, isManager]);

  function handleImport(count: number) {
    onImport(count);
    onClose();
  }

  // Editing an existing org, or a manual-entry prefill, is a single focused
  // task — there's nothing else to switch between, so the source rail (which
  // only makes sense when choosing *how* to source new leads) is hidden and
  // the Manual form gets the full width instead. Non-managers never see the
  // rail either, since they only have the Manual source available to them.
  const singleSection = editMode || !!prefillOrg || !isManager;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex h-[min(46rem,90vh)] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="swatch-bar-top shrink-0 border-b border-border px-6 pb-4 pt-6 text-left">
          <p className="eyebrow">{editMode ? "Org · Edit" : "Sourcing"}</p>
          <DialogTitle className="mt-0.5">{editMode ? "Edit leads" : "Add Leads"}</DialogTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {editMode ? "Update organization and linked people." : "Source leads via Apollo, Excel, or manual entry."}
          </p>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
          {!singleSection && (
            <nav className="flex w-72 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-background p-2">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const active = section === s.value;
                return (
                  <Button
                    key={s.value}
                    type="button"
                    variant="ghost"
                    onClick={() => setSection(s.value)}
                    className={cn(
                      "h-auto w-full min-w-0 flex-col items-start gap-1 whitespace-normal rounded-lg px-3 py-2.5 text-left font-normal",
                      active
                        ? "swatch-bar bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2.5 text-sm font-medium">
                      <Icon className="size-4 shrink-0" />
                      {s.label}
                    </span>
                    <span className={cn("w-full min-w-0 whitespace-normal wrap-break-word text-[11px] font-normal leading-snug", active ? "text-primary/70" : "text-muted-foreground/70")}>
                      {s.description}
                    </span>
                  </Button>
                );
              })}
            </nav>
          )}

          <div className="min-w-0 flex-1 overflow-y-auto p-6">
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
                {section === "company" && <CompanyLookupForm onImport={handleImport} />}
                {section === "excel" && <ExcelForm onImport={handleImport} />}
                {section === "manual" && <ManualForm onImport={handleImport} />}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
