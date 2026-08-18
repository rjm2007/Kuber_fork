export function DashboardSkeleton() {
  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto animate-pulse">
      <div className="flex items-start justify-between">
        <div>
          <div className="h-3 w-16 bg-border/60 rounded mb-2" />
          <div className="h-7 w-32 bg-border/60 rounded" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-field p-5 space-y-3">
            <div className="h-8 w-8 bg-border/60 rounded-lg" />
            <div className="h-8 w-16 bg-border/60 rounded" />
            <div className="h-3 w-24 bg-border/40 rounded" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-field border border-border rounded-xl p-6 h-72" />
        <div className="bg-field border border-border rounded-xl p-6 h-72" />
      </div>
    </div>
  );
}

export function LeadsSkeleton() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      <div className="flex items-center justify-between px-8 py-4 border-b border-border">
        <div className="h-6 w-32 bg-border/60 rounded" />
        <div className="flex gap-2">
          <div className="h-8 w-20 bg-border/60 rounded-lg" />
          <div className="h-8 w-24 bg-border/60 rounded-lg" />
        </div>
      </div>
      <div className="flex-1 px-8 py-5">
        <div className="rounded-xl border border-border bg-field overflow-hidden">
          <div className="divide-y divide-border">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5">
                <div className="size-4 rounded bg-border/60" />
                <div className="size-8 rounded-full bg-border/60" />
                <div className="h-3 bg-border/60 rounded flex-1" />
                <div className="h-5 w-16 bg-border/60 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CampaignsSkeleton() {
  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto animate-pulse">
      {/* Breadcrumb + title */}
      <div>
        <div className="h-3 w-32 bg-border/60 rounded mb-2" />
      </div>
      {/* Search + tabs + filter row */}
      <div className="flex items-center gap-4">
        <div className="h-10 w-72 bg-border/40 rounded-lg border border-border" />
        <div className="flex items-center gap-1 ml-4">
          <div className="h-8 w-14 bg-border/40 rounded-lg" />
          <div className="h-8 w-16 bg-border/40 rounded-lg" />
          <div className="h-8 w-14 bg-border/40 rounded-lg" />
          <div className="h-8 w-16 bg-border/40 rounded-lg" />
        </div>
        <div className="h-9 w-32 bg-border/40 rounded-lg border border-border ml-auto" />
      </div>
      {/* Campaign card grid — 3 columns like the real page */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="p-5 bg-field border border-border rounded-xl flex flex-col gap-3">
            {/* Dot + campaign name */}
            <div className="flex items-start gap-2">
              <div className="size-2.5 rounded-full bg-border/80 mt-1 shrink-0" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="h-4 w-3/4 bg-border/60 rounded" />
                <div className="h-5 w-12 bg-border/60 rounded-md" />
              </div>
            </div>
            {/* Tags */}
            <div className="flex items-center gap-2">
              <div className="h-5 w-20 bg-border/40 rounded border border-border" />
              <div className="h-4 w-24 bg-border/40 rounded" />
            </div>
            {/* Stats row (Leads / Sent / Replied / Reply Rate) */}
            <div className="flex items-end justify-between gap-3 pt-3 border-t border-border">
              <div className="text-center space-y-1">
                <div className="h-5 w-6 bg-border/60 rounded mx-auto" />
                <div className="h-2.5 w-10 bg-border/40 rounded mx-auto" />
              </div>
              <div className="text-center space-y-1">
                <div className="h-5 w-4 bg-border/60 rounded mx-auto" />
                <div className="h-2.5 w-8 bg-border/40 rounded mx-auto" />
              </div>
              <div className="text-center space-y-1">
                <div className="h-5 w-4 bg-border/60 rounded mx-auto" />
                <div className="h-2.5 w-14 bg-border/40 rounded mx-auto" />
              </div>
              <div className="text-center space-y-1">
                <div className="h-5 w-6 bg-border/60 rounded mx-auto" />
                <div className="h-2.5 w-16 bg-border/40 rounded mx-auto" />
              </div>
            </div>
            {/* Created date */}
            <div className="h-3 w-28 bg-border/40 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Header */}
      <div className="px-8 py-5 border-b border-border shrink-0">
        <div className="h-3 w-14 bg-border/60 rounded mb-2" />
        <div className="h-7 w-32 bg-border/60 rounded" />
      </div>
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 border-r border-border p-4 space-y-2">
          <div className="h-3 w-14 bg-border/40 rounded mb-3" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-9 w-full bg-border/40 rounded-md" />
          ))}
        </aside>
        {/* Content */}
        <div className="flex-1 p-8 max-w-5xl space-y-6">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <div className="space-y-2">
              <div className="h-3 w-16 bg-border/60 rounded" />
              <div className="h-6 w-28 bg-border/60 rounded" />
            </div>
            <div className="h-6 w-20 bg-border/60 rounded-full" />
          </div>
          <div className="flex items-center gap-4 py-4 border-b border-border">
            <div className="size-12 rounded-md bg-border/60" />
            <div className="space-y-2">
              <div className="h-4 w-28 bg-border/60 rounded" />
              <div className="h-3 w-40 bg-border/40 rounded" />
            </div>
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-start justify-between gap-8 py-5 border-b border-border last:border-0">
              <div className="space-y-1.5 w-48">
                <div className="h-4 w-28 bg-border/60 rounded" />
                <div className="h-3 w-full bg-border/40 rounded" />
              </div>
              <div className="h-9 flex-1 max-w-sm bg-border/40 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RouteSkeleton({ href }: { href: string }) {
  if (href.startsWith("/settings")) return <SettingsSkeleton />;
  if (href.startsWith("/campaigns")) return <CampaignsSkeleton />;
  if (href.startsWith("/unibox")) return <CampaignsSkeleton />;
  if (href.startsWith("/leads")) return <LeadsSkeleton />;
  return <DashboardSkeleton />;
}
