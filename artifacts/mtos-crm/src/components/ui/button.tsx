import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* ──────────────────────────────────────────────────────────────────────────
 * iOS / SF-inspired 3D button system.
 *
 * Visual goals (Apple iOS 26 / Sonoma SF Pro feel):
 *   - Squircle shape (rounded-2xl base, rounded-full at lg)
 *   - Glossy top highlight + subtle bottom occlusion (specular gradient)
 *   - Layered shadow stack: hairline + contact + ambient + colored halo
 *   - Crisp 1px hairline border that bends to the lighting
 *   - Spring-eased transforms (cubic-bezier(0.22, 1, 0.36, 1))
 *   - Hover lifts ~1px with brightening; active sinks + scales 0.97
 *   - Backdrop blur on glass variants for depth on white surfaces
 *   - All variants honor theme tokens so dark skins still look right
 * ──────────────────────────────────────────────────────────────────────── */
const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-sm font-semibold tracking-[-0.01em] select-none isolate",
    "transition-[transform,box-shadow,background-color,color,border-color,filter] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 disabled:saturate-50",
    // Press: sink, shrink, brighten-down, collapse the lift shadow
    "active:translate-y-[0.5px] active:scale-[0.97] active:brightness-[0.96]",
    "active:shadow-[0_1px_0_hsl(0_0%_100%/0.25)_inset,0_1px_2px_hsl(0_0%_0%/0.12),0_2px_4px_-2px_hsl(0_0%_0%/0.10)]",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Solid primary — full iOS 3D treatment
        //   • vertical specular gradient (top brighter, bottom darker)
        //   • bright inset top highlight (glassy edge)
        //   • soft inset bottom shadow (occlusion)
        //   • 1px hairline + soft contact + ambient + colored glow
        //   • lifts on hover, sinks on active
        default: [
          "text-primary-foreground border border-primary/60",
          "bg-[linear-gradient(180deg,hsl(var(--primary)/1.12)_0%,hsl(var(--primary))_50%,hsl(var(--primary)/0.88)_100%)]",
          "shadow-[0_1.5px_0_hsl(0_0%_100%/0.55)_inset,0_-1.5px_0_hsl(0_0%_0%/0.18)_inset,0_1px_1.5px_hsl(0_0%_0%/0.18),0_3px_6px_-1px_hsl(0_0%_0%/0.16),0_10px_22px_-6px_hsl(var(--primary)/0.55)]",
          "hover:-translate-y-[1.5px] hover:brightness-[1.05]",
          "hover:shadow-[0_1.5px_0_hsl(0_0%_100%/0.6)_inset,0_-1.5px_0_hsl(0_0%_0%/0.18)_inset,0_2px_3px_hsl(0_0%_0%/0.2),0_8px_14px_-2px_hsl(0_0%_0%/0.18),0_18px_36px_-10px_hsl(var(--primary)/0.7)]",
        ].join(" "),
        destructive: [
          "text-destructive-foreground border border-destructive/60",
          "bg-[linear-gradient(180deg,hsl(var(--destructive)/1.12)_0%,hsl(var(--destructive))_50%,hsl(var(--destructive)/0.88)_100%)]",
          "shadow-[0_1.5px_0_hsl(0_0%_100%/0.55)_inset,0_-1.5px_0_hsl(0_0%_0%/0.18)_inset,0_1px_1.5px_hsl(0_0%_0%/0.18),0_3px_6px_-1px_hsl(0_0%_0%/0.16),0_10px_22px_-6px_hsl(var(--destructive)/0.55)]",
          "hover:-translate-y-[1.5px] hover:brightness-[1.05]",
          "hover:shadow-[0_1.5px_0_hsl(0_0%_100%/0.6)_inset,0_-1.5px_0_hsl(0_0%_0%/0.18)_inset,0_2px_3px_hsl(0_0%_0%/0.2),0_8px_14px_-2px_hsl(0_0%_0%/0.18),0_18px_36px_-10px_hsl(var(--destructive)/0.7)]",
        ].join(" "),
        // Outline / glass — Big Sur / iOS clear material on white
        outline: [
          "border border-[hsl(220_13%_88%)] text-foreground",
          "bg-[linear-gradient(180deg,hsl(0_0%_100%)_0%,hsl(220_20%_98%)_100%)] backdrop-blur-md",
          "shadow-[0_1.5px_0_hsl(0_0%_100%/1)_inset,0_-1px_0_hsl(220_13%_90%/0.7)_inset,0_1px_1.5px_hsl(220_15%_30%/0.06),0_3px_6px_-2px_hsl(220_15%_30%/0.08),0_8px_18px_-6px_hsl(220_15%_30%/0.10)]",
          "hover:-translate-y-[1.5px] hover:bg-[linear-gradient(180deg,hsl(0_0%_100%)_0%,hsl(220_20%_96%)_100%)]",
          "hover:shadow-[0_1.5px_0_hsl(0_0%_100%/1)_inset,0_-1px_0_hsl(220_13%_85%/0.8)_inset,0_2px_3px_hsl(220_15%_30%/0.08),0_6px_12px_-2px_hsl(220_15%_30%/0.10),0_16px_28px_-8px_hsl(220_15%_30%/0.16)]",
        ].join(" "),
        // Secondary — light frosted, sits politely on white
        secondary: [
          "border border-[hsl(220_13%_90%)] text-secondary-foreground",
          "bg-[linear-gradient(180deg,hsl(220_20%_99%)_0%,hsl(220_18%_96%)_50%,hsl(220_16%_93%)_100%)]",
          "shadow-[0_1.5px_0_hsl(0_0%_100%/0.95)_inset,0_-1px_0_hsl(220_13%_85%/0.5)_inset,0_1px_1.5px_hsl(220_15%_30%/0.06),0_3px_6px_-2px_hsl(220_15%_30%/0.08)]",
          "hover:-translate-y-[1.5px] hover:brightness-[1.02]",
          "hover:bg-[linear-gradient(180deg,hsl(220_20%_99%)_0%,hsl(220_18%_95%)_50%,hsl(220_16%_91%)_100%)]",
          "hover:shadow-[0_1.5px_0_hsl(0_0%_100%/1)_inset,0_-1px_0_hsl(220_13%_82%/0.6)_inset,0_2px_3px_hsl(220_15%_30%/0.08),0_8px_16px_-4px_hsl(220_15%_30%/0.12)]",
        ].join(" "),
        // Ghost — flat until hover, where it picks up a subtle glass plate
        ghost: [
          "border border-transparent text-foreground",
          "hover:border-[hsl(220_13%_92%)] hover:bg-[linear-gradient(180deg,hsl(0_0%_100%/0.9)_0%,hsl(220_20%_97%/0.9)_100%)] hover:backdrop-blur-md",
          "hover:shadow-[0_1px_0_hsl(0_0%_100%/0.9)_inset,0_1px_2px_hsl(220_15%_30%/0.06),0_4px_10px_-2px_hsl(220_15%_30%/0.08)]",
          "hover:text-accent-foreground",
        ].join(" "),
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // 36px — base SF control height
        default: "min-h-9 px-4 py-2 rounded-2xl",
        // 30px — compact / secondary controls
        sm: "min-h-8 rounded-xl px-3 text-xs",
        // 44px — primary CTA, full pill (iOS standard hit target)
        lg: "min-h-11 rounded-full px-7 text-[15px]",
        // square icon button
        icon: "h-9 w-9 rounded-2xl",
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
