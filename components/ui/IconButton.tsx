import { forwardRef } from "react";

// An icon-only button MUST carry a label: it is the accessible name and the
// tooltip. 44px square minimum.
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: "ink" | "muted" | "brand" | "danger";
}

const TONE = {
  ink: "text-ink hover:bg-hairline/60",
  muted: "text-muted hover:bg-hairline/60 hover:text-ink",
  brand: "text-brand hover:bg-brand-tint",
  danger: "text-bad hover:bg-bad-wash",
};

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tone = "muted", className = "", children, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex min-h-tap min-w-tap items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
export default IconButton;
