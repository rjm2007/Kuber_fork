export default function UniboxLoading() {
  return (
    <div className="flex h-full animate-pulse">
      {/* Thread list sidebar */}
      <div className="w-[380px] shrink-0 border-r border-border flex flex-col">
        <div className="px-6 py-4 border-b border-border space-y-3">
          <div className="h-5 w-24 bg-secondary rounded" />
          <div className="h-9 w-full bg-secondary rounded-lg" />
        </div>
        <div className="flex-1 px-6 py-4 space-y-0 divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-3">
              <div className="size-1.5 rounded-full bg-secondary shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-32 bg-secondary rounded" />
                <div className="h-2.5 w-full bg-secondary/60 rounded" />
              </div>
              <div className="h-2.5 w-10 bg-secondary/50 rounded shrink-0" />
            </div>
          ))}
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <div className="size-8 rounded-full bg-secondary" />
          <div className="space-y-1.5 flex-1">
            <div className="h-4 w-36 bg-secondary rounded" />
            <div className="h-3 w-48 bg-secondary/60 rounded" />
          </div>
        </div>
        <div className="flex-1 p-6 space-y-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`flex ${i % 2 === 0 ? "" : "justify-end"}`}>
              <div className="h-16 w-64 bg-secondary rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
