"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  LayoutDashboard, Users, Megaphone, Settings, Inbox,
  Menu, Bug,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useApp } from "@/lib/app-context";
import { ThemeProvider } from "@/lib/theme-context";
import { APP_LOGO_INITIAL, APP_NAME } from "@/lib/branding";
import { isCampaignEligible, type Lead } from "@/lib/leads";
import { deleteLead, fetchLogo, fetchUniboxUnread, fetchApolloCredits } from "@/lib/api-client";
import { RouteSkeleton } from "@/components/app/page-skeletons";
import { cn } from "@/lib/utils";

const CreateCampaignModal = dynamic(
  () => import("@/components/app/create-campaign-modal").then((m) => m.CreateCampaignModal),
  { ssr: false },
);
const LeadDrawer = dynamic(
  () => import("@/components/app/lead-drawer").then((m) => m.LeadDrawer),
  { ssr: false },
);
const OrgDrawer = dynamic(
  () => import("@/components/app/org-drawer").then((m) => m.OrgDrawer),
  { ssr: false },
);
const AddLeadsDrawer = dynamic(
  () => import("@/components/app/add-leads-drawer").then((m) => m.AddLeadsDrawer),
  { ssr: false },
);

const SIDEBAR_COLLAPSED_KEY = "kuber_sidebar_collapsed";
const BUG_REPORT_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdzYy8kUC3a9JSyhrWZJjvrmde9V3qBVycKMRSpLLUpQqkWug/viewform";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard",  icon: LayoutDashboard, exact: true,  managerOnly: false },
  { href: "/leads",     label: "Leads",      icon: Users,           exact: false, managerOnly: false },
  { href: "/campaigns", label: "Campaigns",  icon: Megaphone,       exact: false, managerOnly: false },
  { href: "/unibox",    label: "Unibox",     icon: Inbox,           exact: false, managerOnly: false },
  { href: "/settings",  label: "Settings",   icon: Settings,        exact: false, managerOnly: false },
] as const;

function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    session, loadingSession, role, leads, setLeads, leadsTotal, leadsByIds, campaigns, loadCampaigns, setCampaigns, loadLeads,
    checkedIds, setCheckedIds, selectedLead, setSelectedLead, selectedOrgId, setSelectedOrgId,
    showAddLeads, setShowAddLeads, manualPrefill, setManualPrefill,
    showCreateCampaign, setShowCreateCampaign, deletingLead, setDeletingLead,
    deleteLeadLoading, setDeleteLeadLoading,
  } = useApp();

  const visibleNavItems = NAV_ITEMS.filter((item) => !item.managerOnly || role === "manager");

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [uniboxUnread, setUniboxUnread] = useState<number | null>(null);
  const [apolloCredits, setApolloCredits] = useState<{ remaining: number | null; limit: number | null } | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Starts false on both server and client's first render to avoid a
  // hydration mismatch, then syncs from the persisted value after mount.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") setSidebarCollapsed(true);
  }, []);

  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  useEffect(() => { setPendingHref(null); }, [pathname]);

  useEffect(() => {
    if (!loadingSession && !session) router.replace("/");
  }, [loadingSession, session, router]);

  useEffect(() => {
    if (!session) return;
    fetchLogo(session.access_token).then((r) => setLogoUrl(r.logo_url)).catch(() => setLogoUrl(null));
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const load = () => {
      fetchUniboxUnread(session.access_token).then((r) => setUniboxUnread(r.unread)).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const load = () => {
      fetchApolloCredits(session.access_token)
        .then(setApolloCredits)
        .catch(() => setApolloCredits(null));
    };
    load();
    // Cached server-side for 5 minutes — refresh a bit more often than that.
    const id = setInterval(load, 3 * 60_000);
    return () => clearInterval(id);
  }, [session]);

  if (loadingSession) {
    return (
      <div className="h-screen flex bg-background overflow-hidden">
        <aside className="w-56 shrink-0 border-r border-border flex flex-col bg-card animate-pulse">
          <div className="px-4 py-5 border-b border-border flex items-center gap-2.5">
            <div className="size-8 bg-secondary rounded-lg" />
            <div className="h-4 w-16 bg-secondary rounded" />
          </div>
          <nav className="flex-1 p-2 space-y-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-9 bg-secondary/60 rounded-lg" />
            ))}
          </nav>
        </aside>
        <main className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </main>
      </div>
    );
  }

  if (!session) return null;

  // Among items whose href matches the current path, only the most specific
  // (longest href) one should highlight — guards against nested routes matching
  // more than one top-level nav item at once.
  const bestMatchHref = visibleNavItems
    .filter(({ href, exact }) => (exact ? pathname === href : pathname.startsWith(href)))
    .reduce<string | null>((best, item) => (best === null || item.href.length > best.length ? item.href : best), null);

  function isActive(href: string, exact: boolean) {
    if (exact) return pathname === href;
    return href === bestMatchHref;
  }

  function handleNavClick(href: string, exact: boolean) {
    // Skip only when this nav item is already the active highlight — otherwise
    // a nested route could block navigating to its own parent (startsWith trap).
    if (isActive(href, exact)) return;
    setPendingHref(href);
    startTransition(() => { router.push(href); });
  }

  const showRouteSkeleton = pendingHref !== null && pendingHref !== pathname;
  const skeletonHref = pendingHref ?? pathname;

  return (
    <>
      <div className="h-screen flex bg-background overflow-hidden">
        <aside
          className={cn(
            "shrink-0 border-r border-border flex flex-col bg-card transition-[width] duration-200",
            sidebarCollapsed ? "w-16" : "w-56",
          )}
        >
          <div
            className={cn(
              "border-b border-border flex items-center",
              sidebarCollapsed ? "flex-col gap-2 px-2 py-4" : "gap-2.5 px-4 py-5",
            )}
          >
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="shrink-0 size-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
            >
              <Menu className="size-4" />
            </button>
            {!sidebarCollapsed && (
              <>
                {logoUrl ? (
                  <img src={logoUrl} alt="Brand logo" className="size-8 rounded-lg border border-border bg-card object-contain shrink-0" />
                ) : (
                  <div className="size-8 bg-foreground rounded-lg flex items-center justify-center shrink-0">
                    <span className="text-background text-sm font-black">{APP_LOGO_INITIAL}</span>
                  </div>
                )}
                <span className="font-display font-bold tracking-tight truncate">{APP_NAME}</span>
              </>
            )}
          </div>
          <nav className="flex-1 p-2 space-y-0.5">
            {visibleNavItems.map(({ href, label, icon: Icon, exact }) => {
              const active = isActive(href, exact);
              const badge = label === "Leads" ? leadsTotal : label === "Campaigns" ? campaigns.length : label === "Unibox" ? uniboxUnread : null;
              return (
                <Link
                  key={href}
                  href={href}
                  prefetch
                  title={sidebarCollapsed ? label : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    handleNavClick(href, exact);
                  }}
                  className={cn(
                    "w-full flex items-center rounded-lg text-sm font-medium transition-colors relative",
                    sidebarCollapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2",
                    active
                      ? "swatch-bar bg-primary/10 text-primary font-semibold"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {!sidebarCollapsed && <span className="flex-1 text-left">{label}</span>}
                  {badge !== null && badge > 0 && (
                    sidebarCollapsed ? (
                      <span className="absolute top-1 right-1.5 size-1.5 rounded-full bg-primary" />
                    ) : (
                      <span className="font-mono text-[10px] font-semibold bg-secondary rounded-full px-1.5 py-0.5 tabular-nums">
                        {badge}
                      </span>
                    )
                  )}
                </Link>
              );
            })}
          </nav>
          <div className={cn("border-t border-border", sidebarCollapsed ? "p-2 flex flex-col items-center gap-2" : "p-3 space-y-2")}>
            {apolloCredits?.remaining != null && (() => {
              const { remaining, limit } = apolloCredits;
              // Same "consumed" progress-bar treatment as the Apollo credit
              // pools on the usage page (see CreditPoolRow), so the sidebar
              // readout matches the rest of the app rather than being plain text.
              const consumed = limit != null ? Math.max(0, limit - remaining) : null;
              const pct = limit != null && limit > 0 ? Math.min(100, Math.round((consumed! / limit) * 100)) : null;
              const barColor = pct == null ? "bg-primary" : pct >= 90 ? "bg-destructive" : pct >= 60 ? "bg-amber-400" : "bg-primary";
              const titleText = limit != null
                ? `Apollo key credits: ${remaining.toLocaleString()} / ${limit.toLocaleString()} left`
                : `Apollo key credits: ${remaining.toLocaleString()} left`;

              return (
                <div title={titleText} className={cn(sidebarCollapsed ? "w-full space-y-1" : "space-y-1 px-1")}>
                  <div
                    className={cn(
                      "text-muted-foreground",
                      sidebarCollapsed
                        ? "font-mono text-[9px] tabular-nums text-center leading-tight"
                        : "flex items-baseline justify-between gap-2 text-[11px]",
                    )}
                  >
                    {!sidebarCollapsed && <span className="font-medium shrink-0">Apollo key credits</span>}
                    <span className="font-mono tabular-nums">
                      {limit != null ? `${remaining.toLocaleString()}/${limit.toLocaleString()}` : remaining.toLocaleString()}
                    </span>
                  </div>
                  {pct != null && (
                    <div className={cn("h-1 rounded-full bg-secondary overflow-hidden", sidebarCollapsed ? "w-8 mx-auto" : "w-full")}>
                      <div className={cn("h-full rounded-full transition-[width]", barColor)} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })()}

            {/* External Google Form — a plain `<a target="_blank">`, not next/link,
                since this leaves the app entirely rather than routing within it. */}
            <a
              href={BUG_REPORT_FORM_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={sidebarCollapsed ? "Report an issue" : undefined}
              className={cn(
                "flex items-center rounded-lg text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors",
                sidebarCollapsed ? "size-7 justify-center" : "gap-2 px-1 py-1 text-xs font-medium",
              )}
            >
              <Bug className="size-3.5 shrink-0" />
              {!sidebarCollapsed && <span>Report an issue</span>}
            </a>

            {sidebarCollapsed ? (
              <div
                className="size-7 rounded-full bg-secondary flex items-center justify-center text-[10px] leading-none font-semibold text-muted-foreground shrink-0"
                title={session.user.email}
              >
                <span className="translate-y-px">{session.user.email?.[0]?.toUpperCase() ?? "?"}</span>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground truncate px-1">{session.user.email}</p>
            )}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
          {showRouteSkeleton ? <RouteSkeleton href={skeletonHref} /> : children}
        </main>
      </div>

      <ConfirmDialog
        open={!!deletingLead}
        title={`Delete ${deletingLead ? `${deletingLead.firstName} ${deletingLead.lastName}`.trim() : "lead"}?`}
        description="This will permanently remove the lead and all associated data. This cannot be undone."
        loading={deleteLeadLoading}
        onClose={() => { if (!deleteLeadLoading) setDeletingLead(null); }}
        onConfirm={async () => {
          if (!deletingLead || !session) return;
          setDeleteLeadLoading(true);
          try {
            await deleteLead(session.access_token, deletingLead.id);
            setLeads((prev) => prev.filter((l) => l.id !== deletingLead.id));
            setDeletingLead(null);
          } finally {
            setDeleteLeadLoading(false);
          }
        }}
      />

      <CreateCampaignModal
        open={showCreateCampaign}
        onClose={() => { setShowCreateCampaign(false); setCheckedIds(new Set()); }}
        onCreated={(c) => {
          setCampaigns((p) => [c, ...p]);
          setShowCreateCampaign(false);
          setCheckedIds(new Set());
          router.push(`/campaigns/${c.id}`);
        }}
        leads={leadsByIds(checkedIds).filter(isCampaignEligible)}
      />

      <AddLeadsDrawer
        open={showAddLeads}
        onClose={() => { setShowAddLeads(false); setManualPrefill(null); }}
        onImport={() => {
          if (!session) return;
          void loadCampaigns(session.access_token);
          void loadLeads(session.access_token);
        }}
        defaultTab={manualPrefill ? "manual" : "apollo"}
        prefillOrg={manualPrefill?.prefillOrg}
        prefillLeads={manualPrefill?.prefillLeads}
        editMode={manualPrefill?.editMode}
      />

      <LeadDrawer
        lead={selectedLead}
        onClose={() => setSelectedLead(null)}
        onLeadUpdated={(updated) => {
          setLeads((prev) => prev.map((l) => l.id === updated.id ? updated : l));
          // Only refresh the open drawer — never reopen after the user closed it
          // (in-flight fetchFresh would otherwise race and set selectedLead again).
          setSelectedLead((prev) => (prev?.id === updated.id ? updated : prev));
        }}
        onOrgClick={(id) => setSelectedOrgId(id)}
      />

      <OrgDrawer
        orgId={selectedOrgId}
        onClose={() => setSelectedOrgId(null)}
        onLeadClick={(leadId) => {
          const found = leads.find((l) => l.id === leadId);
          if (found) {
            setSelectedOrgId(null);
            setSelectedLead(found);
          } else {
            setSelectedOrgId(null);
            setSelectedLead({ id: leadId, firstName: "", lastName: "", email: "", company: "", domain: "", domainSource: null, phone: "", jobTitle: "", country: "", status: "Enriched", score: "—", source: "Apollo", campaign: "", campaigns: [], createdAt: new Date().toISOString(), orgId: null, enrichmentStage: null, companyDescription: null, sellsTo: null, lastError: null, hasScraped: false, importId: null, batchLabel: null, batchColor: null, assignedTo: null, orgShared: null } satisfies Lead);
          }
        }}
        onAddLead={role === "manager" ? (org) => {
          setSelectedOrgId(null);
          setSelectedLead(null);
          setManualPrefill({
            prefillOrg: { id: org.id, name: org.name, industry: org.industry, domain: org.domain, country: org.country },
            prefillLeads: org.leads,
            editMode: true,
          });
          setShowAddLeads(true);
        } : undefined}
      />
    </>
  );
}

export function ThemedAppShell({ children }: { children: React.ReactNode }) {
  const { session } = useApp();
  return (
    <ThemeProvider session={session}>
      <AppShell>{children}</AppShell>
    </ThemeProvider>
  );
}
