import { forwardRef } from "react";

// The button voices. Every one is ≥44px tall (48px on a coarse pointer via
// globals.css) — the receptionist's thumb is the primary pointer.
type Variant = "brutal" | "brutal-blue" | "ghost" | "danger" | "link";
type Size = "md" | "sm" | "lg";

const VARIANT: Record<Variant, string> = {
  brutal: "btn-brutal",
  "brutal-blue": "btn-brutal-blue",
  ghost: "btn-ghost",
  danger: "btn-danger",
  link: "inline-flex min-h-tap items-center gap-1 px-1 text-small font-medium text-brand underline-offset-2 hover:underline disabled:opacity-50",
};
const SIZE: Record<Size, string> = {
  md: "",
  sm: "!min-h-[36px] !px-3 !py-1.5 !text-micro",
  lg: "!min-h-tap-lg !px-5 !text-body",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", busy, className = "", children, disabled, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
export default Button;
