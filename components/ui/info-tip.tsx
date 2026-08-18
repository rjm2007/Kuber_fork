"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export function InfoTip({
  text,
  className,
  side = "top",
}: {
  text: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const [open, setOpen]     = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { setMounted(true); }, []);

  function recompute() {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (side === "bottom") setCoords({ top: r.bottom + 6, left: cx });
    else if (side === "left")  setCoords({ top: cy, left: r.left - 6 });
    else if (side === "right") setCoords({ top: cy, left: r.right + 6 });
    else                        setCoords({ top: r.top - 6, left: cx });
  }

  const transformMap: Record<string, string> = {
    top:    "translate(-50%, -100%)",
    bottom: "translate(-50%, 0)",
    left:   "translate(-100%, -50%)",
    right:  "translate(0, -50%)",
  };

  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <button
        ref={btnRef}
        type="button"
        tabIndex={0}
        aria-label="More information"
        className="relative z-10 inline-flex items-center justify-center size-5 rounded-full text-muted-foreground hover:text-foreground transition-colors"
        onMouseEnter={() => { recompute(); setOpen(true); }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => { recompute(); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); recompute(); setOpen((v) => !v); }}
      >
        <Info className="size-3" />
      </button>

      {open && coords && mounted && createPortal(
        <span
          role="tooltip"
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            transform: transformMap[side],
            zIndex: 9999,
          }}
          className="w-64 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] leading-relaxed text-foreground shadow-lg pointer-events-none"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}
