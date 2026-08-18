export default function CampaignDetailLoading() {
  return (
    <div className="flex flex-col h-full animate-pulse">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <div className="h-7 w-7 bg-secondary rounded-lg" />
        <div className="h-6 w-48 bg-secondary rounded" />
        <div className="ml-auto flex gap-2">
          <div className="h-8 w-20 bg-secondary rounded-lg" />
          <div className="h-8 w-24 bg-secondary rounded-lg" />
        </div>
      </div>

      {/* Analytics tiles */}
      <div className="px-6 py-5 border-b border-border">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="h-3 w-16 bg-secondary rounded" />
              <div className="h-7 w-12 bg-secondary rounded" />
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-4 w-16 bg-secondary rounded" />
        ))}
      </div>

      {/* Lead table */}
      <div className="flex-1 px-6 py-4">
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {/* Header row */}
          <div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-secondary/30">
            <div className="size-4 rounded bg-secondary" />
            <div className="h-3 w-24 bg-secondary rounded" />
            <div className="h-3 w-32 bg-secondary rounded" />
            <div className="h-3 w-20 bg-secondary rounded ml-auto" />
          </div>
          {/* Rows */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b border-border last:border-0">
              <div className="size-4 rounded bg-secondary" />
              <div className="size-8 rounded-full bg-secondary" />
              <div className="h-3.5 w-32 bg-secondary rounded" />
              <div className="h-3 w-40 bg-secondary/60 rounded" />
              <div className="h-5 w-16 bg-secondary rounded-full ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
