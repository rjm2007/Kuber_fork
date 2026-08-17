"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isAppUser, getUserRole, type AppRole } from "@/lib/auth/roles";
import { type Lead } from "@/lib/leads";
import { type Campaign } from "@/components/app/create-campaign-modal";
import { supabase } from "@/lib/supabase";
import { fetchLeads, fetchLeadsCount, fetchCampaigns, rescrapeOrg, type LeadListFilters } from "@/lib/api-client";

export type PrefillData = {
  prefillOrg?: { id?: string; name: string; industry: string; domain: string; country: string };
  prefillLeads?: Array<{ firstName: string; lastName: string; email: string; jobTitle: string; id?: string }>;
  editMode?: boolean;
};

type AppContextValue = {
  // Auth
  session: Session | null;
  loadingSession: boolean;
  role: AppRole | null;

  // Leads
  leads: Lead[];
  setLeads: React.Dispatch<React.SetStateAction<Lead[]>>;
  leadsTotal: number | null;
  loadLeads: (token: string, opts?: { background?: boolean }) => Promise<void>;
  loadingLeads: boolean;
  loadMoreLeads: (token: string) => Promise<void>;
  loadingMoreLeads: boolean;
  loadAllLeads: (token: string) => Promise<void>;
  loadingAllLeads: boolean;
  searchLeads: (token: string, query: string, filters?: LeadListFilters) => Promise<{ leads: Lead[]; total: number }>;
  /** Resolve lead ids to objects across EVERY lead this session has seen —
   *  the loaded pages and any server-filtered result set. Selecting rows in a
   *  filtered view and reading them back out of `leads` silently dropped
   *  anything outside the newest page. */
  leadsByIds: (ids: Set<string>) => Lead[];

  // Campaigns
  campaigns: Campaign[];
  setCampaigns: React.Dispatch<React.SetStateAction<Campaign[]>>;
  loadCampaigns: (token: string) => Promise<void>;
  loadingCampaigns: boolean;

  // Enrichment
  enrichingIds: Set<string>;
  handleEnrichLead: (lead: Lead) => Promise<void>;

  // Selection / UI state
  checkedIds: Set<string>;
  setCheckedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedLead: Lead | null;
  setSelectedLead: React.Dispatch<React.SetStateAction<Lead | null>>;
  selectedOrgId: string | null;
  setSelectedOrgId: React.Dispatch<React.SetStateAction<string | null>>;

  // Add-leads drawer
  showAddLeads: boolean;
  setShowAddLeads: React.Dispatch<React.SetStateAction<boolean>>;
  manualPrefill: PrefillData | null;
  setManualPrefill: React.Dispatch<React.SetStateAction<PrefillData | null>>;

  // Campaign creation
  showCreateCampaign: boolean;
  setShowCreateCampaign: React.Dispatch<React.SetStateAction<boolean>>;

  // Delete lead
  deletingLead: Lead | null;
  setDeletingLead: React.Dispatch<React.SetStateAction<Lead | null>>;
  deleteLeadLoading: boolean;
  setDeleteLeadLoading: React.Dispatch<React.SetStateAction<boolean>>;
};

// Persist the context object across Fast Refresh. This file imports
// lib/api-client, so any edit there re-evaluates the module and would
// otherwise mint a new createContext() — AppProvider would still be on
// the old one, useApp() would read the new one, and SSR throws
// "useApp must be used within AppProvider" (Next then recovers client-side).
const AppContext = (() => {
  if (process.env.NODE_ENV === "production") {
    return createContext<AppContextValue | null>(null);
  }
  const g = globalThis as typeof globalThis & {
    __kuberAppContext?: ReturnType<typeof createContext<AppContextValue | null>>;
  };
  return (g.__kuberAppContext ??= createContext<AppContextValue | null>(null));
})();

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

async function resolveSession(): Promise<Session | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const { data, error } = await supabase.auth.getClaims(session.access_token);
  if (error || !data?.claims) return null;

  const user = {
    app_metadata: data.claims.app_metadata,
  } as Parameters<typeof isAppUser>[0];
  if (!isAppUser(user)) {
    await supabase.auth.signOut();
    return null;
  }
  return session;
}

export function AppProvider({
  children,
  initialSession = null,
  initialLeadsTotal = null,
}: {
  children: React.ReactNode;
  initialSession?: Session | null;
  initialLeadsTotal?: number | null;
}) {
  const [session,        setSession       ] = useState<Session | null>(initialSession);
  const [loadingSession, setLoadingSession] = useState(!initialSession);

  const [leads,            setLeads          ] = useState<Lead[]>([]);
  // Every lead seen this session, by id. `leads` holds only the newest page, so
  // a selection made in a filtered view could not be resolved from it — the
  // Create-campaign modal received a fraction of what the user had ticked.
  const leadIndex = useRef<Map<string, Lead>>(new Map());
  const rememberLeads = useCallback((rows: Lead[]) => {
    for (const l of rows) leadIndex.current.set(l.id, l);
  }, []);
  const leadsByIds = useCallback(
    (ids: Set<string>) => [...ids].map((id) => leadIndex.current.get(id)).filter(Boolean) as Lead[],
    [],
  );
  const [leadsTotal,       setLeadsTotal     ] = useState<number | null>(initialLeadsTotal);
  const [loadingLeads,     setLoadingLeads   ] = useState(false);
  const [loadingMoreLeads, setLoadingMoreLeads] = useState(false);
  const [loadingAllLeads, setLoadingAllLeads] = useState(false);
  const [campaigns,        setCampaigns      ] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  const [enrichingIds,       setEnrichingIds      ] = useState<Set<string>>(new Set());
  const [checkedIds,         setCheckedIds        ] = useState<Set<string>>(new Set());
  const [selectedLead,       setSelectedLead      ] = useState<Lead | null>(null);
  const [selectedOrgId,      setSelectedOrgId     ] = useState<string | null>(null);
  const [showAddLeads,       setShowAddLeads      ] = useState(false);
  const [manualPrefill,      setManualPrefill     ] = useState<PrefillData | null>(null);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [deletingLead,       setDeletingLead      ] = useState<Lead | null>(null);
  const [deleteLeadLoading,  setDeleteLeadLoading ] = useState(false);

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;

    if (!initialSession) {
      void resolveSession().then((s) => {
        if (!mounted) return;
        setSession(s);
        setLoadingSession(false);
      });
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!mounted) return;
      // Browser client can emit INITIAL_SESSION=null before cookies hydrate; keep server session.
      if (event === "INITIAL_SESSION" && !s && initialSession) return;
      if (event === "SIGNED_OUT") {
        setSession(null);
        setLoadingSession(false);
        return;
      }
      if (!s?.user || !isAppUser(s.user)) {
        if (s?.user && !isAppUser(s.user)) await supabase.auth.signOut();
        setSession(null);
        setLoadingSession(false);
        return;
      }
      // supabase-js re-emits auth events on tab focus and on token refresh.
      // Storing a fresh object every time changed `session`'s identity, and
      // `session` is a dependency of essentially every timer and fetch effect
      // in the app (the Leads 30s poll, the unibox-unread interval, the logo
      // and imports fetches) — so merely focusing the tab tore all of them down
      // and rebuilt them, restarting each clock from zero. Same access token
      // means the same session; keep the object we already have.
      setSession((prev) => (prev?.access_token === s.access_token ? prev : s));
      setLoadingSession(false);
    });

    return () => { mounted = false; subscription.unsubscribe(); };
  }, [initialSession]);

  // ── Data fetching ─────────────────────────────────────────────────────────

  // Supabase's project-level API row cap silently truncates a single request
  // no matter what `limit` we pass it (no error — it just hands back fewer
  // rows than asked, while `count` still reports the true total). Paging in
  // fixed-size chunks and stopping once a page comes back short is what lets
  // us actually reach `total`, whatever that per-request cap happens to be.
  const LEADS_PAGE_SIZE = 500;

  // Both loaders fetch exactly ONE page. They used to call a fetchLeadsUpTo()
  // helper that restarted from page 1 and walked forward every time, which made
  // the cost quadratic: with 1627 leads loaded, each "Show more" re-downloaded
  // every earlier page to append one, and the 30s poll below re-downloaded all
  // four pages — 2000 rows of `select *` plus three joined tables and an exact
  // count, every 30 seconds, for as long as the tab stayed open. Measured at
  // 4.2s / 7.2s / 8.5s for successive clicks. One page per call is flat instead.
  //
  // Offset pagination (page/limit) drifts under concurrent writes: a row
  // fetched on page 1 can reappear on page 2 if a newer lead got inserted
  // in between (it shifts everything after it down by one in the
  // created_at-desc ordering). Both merges below dedupe by id rather than
  // trying to hold the underlying table still — the alternative is keyset
  // pagination, which isn't worth it for an admin list view like this.

  /** Refreshes the newest page in place. Rows already paged in beyond it are
   *  kept (slightly staler) rather than discarded, which is what lets the
   *  background poll run without throwing away anything loadMoreLeads pulled
   *  in — enrichment churns the newest leads, so page 1 is where changes are. */
  const leadsInFlight = useRef(false);
  const loadLeads = useCallback(async (token: string, opts?: { background?: boolean }) => {
    // `background` = the Leads page's 30s poll. It must NOT flip `loadingLeads`:
    // that flag drives a full-page skeleton there, so every tick blanked the
    // whole table for the length of the fetch (measured at seconds on
    // serverless, where this page pulls 500 rows + 3 joined tables + an exact
    // count) and read as the page reloading itself over and over. Foreground
    // callers — first load, the Refresh button, post-mutation reloads — still
    // get the spinner and skeleton they always did.
    //
    // A background tick also stands down if any fetch is already running: the
    // page used to guard that itself via a loadingLeads ref, which only saw
    // foreground loads, so a poll slower than 30s could overlap itself and race
    // on setLeads. A foreground call is never skipped — the user asked for it.
    if (opts?.background && leadsInFlight.current) return;
    leadsInFlight.current = true;
    if (!opts?.background) setLoadingLeads(true);
    try {
      const res = await fetchLeads(token, { limit: LEADS_PAGE_SIZE, page: 1 });
      rememberLeads(res.leads);
      setLeads((prev) => {
        if (prev.length <= res.leads.length) return res.leads;
        const fresh = new Set(res.leads.map((l) => l.id));
        return [...res.leads, ...prev.filter((l) => !fresh.has(l.id))];
      });
      setLeadsTotal(res.total);
    } catch { /* silently ignore */ }
    finally {
      leadsInFlight.current = false;
      if (!opts?.background) setLoadingLeads(false);
    }
  }, [rememberLeads]);

  /** Appends the next page only. */
  const loadMoreLeads = useCallback(async (token: string) => {
    setLoadingMoreLeads(true);
    try {
      const nextPage = Math.floor(leads.length / LEADS_PAGE_SIZE) + 1;
      const res = await fetchLeads(token, { limit: LEADS_PAGE_SIZE, page: nextPage });
      rememberLeads(res.leads);
      setLeads((prev) => {
        const known = new Set(prev.map((l) => l.id));
        return [...prev, ...res.leads.filter((l) => !known.has(l.id))];
      });
      setLeadsTotal(res.total);
    } catch { /* silently ignore */ }
    finally { setLoadingMoreLeads(false); }
  }, [leads.length, rememberLeads]);

  /** Pages in every remaining lead in one call — for views (Kanban) where a
   *  partial window skews the client-side status split instead of just
   *  showing fewer rows. */
  const loadAllLeads = useCallback(async (token: string) => {
    setLoadingAllLeads(true);
    try {
      let page = Math.floor(leads.length / LEADS_PAGE_SIZE) + 1;
      for (;;) {
        const res = await fetchLeads(token, { limit: LEADS_PAGE_SIZE, page });
        rememberLeads(res.leads);
        setLeads((prev) => {
          const known = new Set(prev.map((l) => l.id));
          return [...prev, ...res.leads.filter((l) => !known.has(l.id))];
        });
        setLeadsTotal(res.total);
        if (res.leads.length < LEADS_PAGE_SIZE || page * LEADS_PAGE_SIZE >= res.total) break;
        page++;
      }
    } catch { /* silently ignore */ }
    finally { setLoadingAllLeads(false); }
  }, [leads.length, rememberLeads]);

  // Runs the search against the DB (not the client-loaded `leads` subset) so
  // it finds a match anywhere in the table, not just among the leads already
  // paged in. Independent of `leads` state — never touches it.
  const searchLeads = useCallback(async (token: string, query: string, filters?: LeadListFilters): Promise<{ leads: Lead[]; total: number }> => {
    const seen = new Set<string>();
    const all: Lead[] = [];
    let total = 0;
    for (let page = 1; ; page++) {
      const res = await fetchLeads(token, { limit: LEADS_PAGE_SIZE, page, q: query || undefined, ...filters });
      for (const lead of res.leads) {
        if (seen.has(lead.id)) continue;
        seen.add(lead.id);
        all.push(lead);
      }
      total = res.total;
      rememberLeads(res.leads);
      if (res.leads.length < LEADS_PAGE_SIZE || all.length >= total) break;
    }
    return { leads: all, total };
  }, [rememberLeads]);

  const loadCampaigns = useCallback(async (token: string) => {
    setLoadingCampaigns(true);
    try {
      const list = await fetchCampaigns(token);
      setCampaigns(list);
    } catch { /* silently ignore */ } finally {
      setLoadingCampaigns(false);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setLeads([]);
      setLeadsTotal(null);
      setCampaigns([]);
      return;
    }
    if (initialLeadsTotal === null) {
      fetchLeadsCount(session.access_token)
        .then((total) => setLeadsTotal(total))
        .catch(() => {});
    }
  }, [session, initialLeadsTotal]);

  // ── Enrichment ────────────────────────────────────────────────────────────

  const handleEnrichLead = useCallback(async (lead: Lead) => {
    if (!lead.orgId || !session) return;
    setEnrichingIds((prev) => new Set(prev).add(lead.id));
    try {
      await rescrapeOrg(session.access_token, lead.orgId);
      setTimeout(() => { if (session) void loadLeads(session.access_token); }, 800);
    } catch { /* non-fatal */ }
    finally {
      setEnrichingIds((prev) => { const next = new Set(prev); next.delete(lead.id); return next; });
    }
  }, [session, loadLeads]);

  // Memoized: a bare object literal here was a new value on every provider
  // render, so every consumer of useApp() re-rendered whenever any single piece
  // of app state moved — the whole Leads table re-rendered on a keystroke in an
  // unrelated search box. The useState setters are stable by contract and the
  // three loaders are useCallback'd, so the real dependencies are just the
  // state values themselves.
  const value: AppContextValue = useMemo(() => ({
    session,
    loadingSession,
    role: getUserRole(session?.user),
    leads,
    setLeads,
    leadsTotal,
    loadLeads,
    loadingLeads,
    loadMoreLeads,
    loadingMoreLeads,
    loadAllLeads,
    loadingAllLeads,
    searchLeads,
    leadsByIds,
    campaigns,
    setCampaigns,
    loadCampaigns,
    loadingCampaigns,
    enrichingIds,
    handleEnrichLead,
    checkedIds,
    setCheckedIds,
    selectedLead,
    setSelectedLead,
    selectedOrgId,
    setSelectedOrgId,
    showAddLeads,
    setShowAddLeads,
    manualPrefill,
    setManualPrefill,
    showCreateCampaign,
    setShowCreateCampaign,
    deletingLead,
    setDeletingLead,
    deleteLeadLoading,
    setDeleteLeadLoading,
  }), [
    session, loadingSession,
    leads, leadsTotal, loadLeads, loadingLeads, loadMoreLeads, loadingMoreLeads, loadAllLeads, loadingAllLeads, searchLeads,
    campaigns, loadCampaigns, loadingCampaigns,
    enrichingIds, handleEnrichLead,
    checkedIds, selectedLead, selectedOrgId,
    showAddLeads, manualPrefill, showCreateCampaign,
    deletingLead, deleteLeadLoading,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
