import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-teal/70",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-ink/90",
        outline: "border border-line bg-paper-2 text-ink hover:bg-chip",
        ghost: "text-ink hover:bg-chip",
        danger: "border border-loss/30 bg-loss/10 text-loss hover:bg-loss/15",
      },
      size: {
        default: "h-10 min-h-10 px-3",
        sm: "h-10 min-h-10 px-3 text-xs",
        icon: "size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
