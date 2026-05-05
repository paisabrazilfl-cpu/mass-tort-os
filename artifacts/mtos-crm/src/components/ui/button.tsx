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
    "transition-[transform,box-shadow,background-color,color,border-color,filter] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    // 3D press: drop down a hair + shrink + collapse shadow so it "sinks" into the surface.
    "active:translate-y-px active:scale-[0.98] active:shadow-[0_1px_0_hsl(0_0%_100%/0.15)_inset,0_1px_1px_hsl(0_0%_0%/0.08)] active:brightness-95",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Solid primary — full 3D treatment:
        //  • gradient fill (top brighter, bottom darker)
        //  • bright inner top highlight (specular edge)
        //  • dark inner bottom edge (occlusion)
        //  • crisp 1px hairline shadow + soft contact shadow + colored ambient halo
        //  • lifts further on hover, sinks on active
        default: [
          "text-primary-foreground border border-primary/70",
          "bg-[linear-gradient(180deg,hsl(var(--primary)/1.05)_0%,hsl(var(--primary))_55%,hsl(var(--primary)/0.85)_100%)]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.45)_inset,0_-1px_0_hsl(0_0%_0%/0.18)_inset,0_1px_1.5px_hsl(0_0%_0%/0.18),0_2px_4px_hsl(0_0%_0%/0.12),0_8px_18px_-6px_hsl(var(--primary)/0.55)]",
          "hover:-translate-y-[1px] hover:brightness-[1.04]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.5)_inset,0_-1px_0_hsl(0_0%_0%/0.18)_inset,0_2px_3px_hsl(0_0%_0%/0.2),0_6px_10px_hsl(0_0%_0%/0.14),0_14px_28px_-8px_hsl(var(--primary)/0.65)]",
        ].join(" "),
        destructive: [
          "text-destructive-foreground border border-destructive/70",
          "bg-[linear-gradient(180deg,hsl(var(--destructive)/1.05)_0%,hsl(var(--destructive))_55%,hsl(var(--destructive)/0.85)_100%)]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.45)_inset,0_-1px_0_hsl(0_0%_0%/0.18)_inset,0_1px_1.5px_hsl(0_0%_0%/0.18),0_2px_4px_hsl(0_0%_0%/0.12),0_8px_18px_-6px_hsl(var(--destructive)/0.55)]",
          "hover:-translate-y-[1px] hover:brightness-[1.04]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.5)_inset,0_-1px_0_hsl(0_0%_0%/0.18)_inset,0_2px_3px_hsl(0_0%_0%/0.2),0_6px_10px_hsl(0_0%_0%/0.14),0_14px_28px_-8px_hsl(var(--destructive)/0.65)]",
        ].join(" "),
        // Outline / secondary — softer 3D, glass-like (Big Sur style).
        outline: [
          "border border-border/90 bg-[linear-gradient(180deg,hsl(0_0%_100%)_0%,hsl(220_14%_98%)_100%)] backdrop-blur-sm text-foreground",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.9)_inset,0_-1px_0_hsl(220_13%_88%/0.5)_inset,0_1px_1px_hsl(0_0%_0%/0.06),0_2px_5px_-2px_hsl(0_0%_0%/0.08)]",
          "hover:-translate-y-[1px] hover:bg-[linear-gradient(180deg,hsl(0_0%_100%)_0%,hsl(220_14%_96%)_100%)]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.9)_inset,0_-1px_0_hsl(220_13%_85%/0.6)_inset,0_2px_3px_hsl(0_0%_0%/0.1),0_6px_12px_-4px_hsl(0_0%_0%/0.12)]",
        ].join(" "),
        secondary: [
          "border border-border/80 text-secondary-foreground",
          "bg-[linear-gradient(180deg,hsl(var(--secondary)/1.1)_0%,hsl(var(--secondary))_55%,hsl(var(--secondary)/0.85)_100%)]",
          "shadow-[0_1px_0_hsl(0_0%_100%/0.7)_inset,0_-1px_0_hsl(0_0%_0%/0.08)_inset,0_1px_1.5px_hsl(0_0%_0%/0.1),0_2px_5px_-2px_hsl(0_0%_0%/0.1)]",
          "hover:-translate-y-[1px] hover:brightness-[1.02]",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.8)_inset,0_-1px_0_hsl(0_0%_0%/0.1)_inset,0_2px_3px_hsl(0_0%_0%/0.12),0_6px_12px_-4px_hsl(0_0%_0%/0.14)]",
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
