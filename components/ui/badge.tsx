import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Pill } from "@/components/ui/pill"

// Colour/state only — shape, padding, text size and vertical centering all
// come from Pill so every badge/pill in the app shares one implementation.
const badgeVariants = cva(
  "font-semibold tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
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
  // omit the non-standard HTML `color` attribute — it collides with Pill's
  // own `color` (a BatchColorName), which Badge doesn't use.
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <Pill className={cn("py-0.5", badgeVariants({ variant }), className)} {...props}>
      {children}
    </Pill>
  )
}

export { Badge, badgeVariants }
