import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Compact rounded chip — used both via <Badge> and via badgeVariants() on
// removable filter tokens (countries, keywords, titles). Shape + centering
// live here so every selected-filter pill matches.
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium whitespace-nowrap transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80 font-semibold tracking-wide",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 font-semibold tracking-wide",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80 font-semibold tracking-wide",
        outline: "border-border text-foreground font-semibold tracking-wide",
        /** A chosen value — selected filter chips, removable tokens, active toggles. */
        selected: "border-primary/30 bg-primary/15 text-primary",
        /** The unselected half of a toggle pair; pairs with `selected`. */
        unselected:
          "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
