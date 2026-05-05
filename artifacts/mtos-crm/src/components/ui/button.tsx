import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* ──────────────────────────────────────────────────────────────────────────
 * Apple-style button system.
 *
 * Visual goals:
 *   - Soft gradient fill (slight top→bottom darken on solid variants)
 *   - Generous corner radius (rounded-lg = 8px) for the SF-style pill feel
 *   - Layered shadow: 1px hairline + small soft drop, increasing on hover
 *   - Spring-like easing (cubic-bezier) on transform + colors
 *   - Subtle scale-down on active for the "press" feel
 *   - Inner highlight on solid buttons (subtle white overlay on top edge)
 *   - Backdrop-blur on translucent variants (ghost/secondary) for depth
 *
 * All variants share the same motion + focus ring grammar so the whole UI
 * feels unified. Theme tokens (--primary, --secondary, etc.) still drive
 * the colors so the 3 skins (dark-blue / dark-red / light) cascade
 * automatically.
 * ──────────────────────────────────────────────────────────────────────── */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium select-none",
    "transition-[transform,box-shadow,background-color,color,border-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "active:scale-[0.97]",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Solid primary: gradient + inner highlight + soft shadow that lifts on hover.
        default: [
          "text-primary-foreground border border-primary/60",
          "bg-[linear-gradient(180deg,hsl(var(--primary)/0.96),hsl(var(--primary))_55%,hsl(var(--primary)/0.92))]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.18)_inset,0_1px_2px_hsl(0_0%_0%/0.12),0_4px_12px_-4px_hsl(var(--primary)/0.45)]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.22)_inset,0_2px_4px_hsl(0_0%_0%/0.18),0_8px_20px_-6px_hsl(var(--primary)/0.55)]",
          "hover:-translate-y-px",
        ].join(" "),
        destructive: [
          "text-destructive-foreground border border-destructive/60",
          "bg-[linear-gradient(180deg,hsl(var(--destructive)/0.96),hsl(var(--destructive))_55%,hsl(var(--destructive)/0.92))]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.18)_inset,0_1px_2px_hsl(0_0%_0%/0.12),0_4px_12px_-4px_hsl(var(--destructive)/0.45)]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.22)_inset,0_2px_4px_hsl(0_0%_0%/0.18),0_8px_20px_-6px_hsl(var(--destructive)/0.55)]",
          "hover:-translate-y-px",
        ].join(" "),
        // Outline: hairline border + tiny shadow + becomes filled-tinted on hover.
        outline: [
          "border border-border bg-background/60 backdrop-blur-sm text-foreground",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.04)_inset,0_1px_2px_hsl(0_0%_0%/0.08)]",
          "hover:bg-accent/40 hover:border-border hover:text-accent-foreground",
        ].join(" "),
        secondary: [
          "border border-border/80 text-secondary-foreground",
          "bg-[linear-gradient(180deg,hsl(var(--secondary)/0.95),hsl(var(--secondary)))]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.06)_inset,0_1px_2px_hsl(0_0%_0%/0.08)]",
          "hover:bg-[linear-gradient(180deg,hsl(var(--secondary)),hsl(var(--secondary)/0.85))]",
        ].join(" "),
        ghost: "border border-transparent text-foreground hover:bg-accent/50 hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-lg px-3 text-xs",
        lg: "min-h-11 rounded-xl px-6 text-[15px]",
        icon: "h-9 w-9 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
