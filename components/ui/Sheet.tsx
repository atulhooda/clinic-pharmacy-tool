"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useT } from "@/lib/i18n/client";
import IconButton from "./IconButton";
import { IconClose } from "./icons";

// THE ONE SHEET. Five hand-rolled drawers, four without dialog semantics, no
// Escape, no focus trap, no focus return — replaced by Base UI's Dialog for the
// behaviour (role, aria-modal, focus trap, Escape, outside click, focus
// return) with the Engageo visuals hand-rolled on the tokens.
//
// ≥768px: slides in from the right, keeps the board visible underneath.
// <768px: rises from the bottom to 92dvh — one hand, thumb reach.
export default function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
  initialFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useT();
  return (
    <Dialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-sheet bg-ink/25 animate-fade-in data-[ending-style]:opacity-0" />
        <Dialog.Popup
          initialFocus={initialFocus}
          className={`fixed z-sheet flex flex-col bg-canvas shadow-sheet outline-none
            inset-x-0 bottom-0 h-[92dvh] rounded-t-2xl border-t border-hairline animate-sheet-up
            md:inset-y-0 md:right-0 md:left-auto md:h-full md:rounded-none md:border-l md:border-t-0 md:animate-sheet-in
            ${wide ? "md:w-[640px] md:max-w-[92vw]" : "md:w-[460px] md:max-w-[92vw]"}`}
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline bg-canvas/95 px-5 py-3 backdrop-blur">
            <div className="min-w-0">
              <Dialog.Title className="text-h3 font-semibold text-ink">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-0.5 text-small text-muted">{description}</Dialog.Description>}
            </div>
            <Dialog.Close render={<IconButton label={t("common.close")} />}>
              <IconClose />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="shrink-0 border-t border-hairline bg-canvas px-5 py-3">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
