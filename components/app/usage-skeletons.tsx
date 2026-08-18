import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

/** Shared building blocks for the Settings > Keys > Usage loading states —
 *  shaped to match each tab's real layout so content doesn't jump around
 *  once data arrives. */

export function UsageHeaderSkeleton() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1.5 max-w-2xl w-full">
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-3 w-2/3 max-w-xs" />
      </div>
      <Skeleton className="h-8 w-24 shrink-0" />
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-field p-3 flex flex-col gap-2">
      <Skeleton className="size-7 rounded-lg" />
      <div className="space-y-1.5">
        <Skeleton className="h-5 w-14" />
        <Skeleton className="h-2.5 w-16" />
      </div>
    </div>
  );
}

export function StatTileGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => <StatTileSkeleton key={i} />)}
    </div>
  );
}

const BAR_HEIGHTS = [40, 65, 30, 80, 50, 90, 35, 60, 45, 75, 55, 25, 70, 85];

export function ChartCardSkeleton({ titleWidth = "w-32", subWidth = "w-56" }: { titleWidth?: string; subWidth?: string }) {
  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Skeleton className={`h-3 ${titleWidth}`} />
          <Skeleton className={`h-2.5 ${subWidth}`} />
        </div>
      </div>
      <div className="h-[200px] flex items-end gap-2 px-1">
        {BAR_HEIGHTS.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-sm rounded-b-none" style={{ height: `${h}%` }} />
        ))}
      </div>
    </Card>
  );
}

export function RowsCardSkeleton({ rows = 4, titleWidth = "w-32" }: { rows?: number; titleWidth?: string }) {
  return (
    <Card className="p-5 space-y-3">
      <Skeleton className={`h-3 ${titleWidth}`} />
      <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-2.5">
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ProgressRowSkeleton() {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  );
}
