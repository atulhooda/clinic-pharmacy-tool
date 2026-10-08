"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import Button from "./Button";

// A centred, blocking question. Used ONLY where undo cannot work (revoking a
// trusted PC, resetting someone's password). Routine actions never get a
// confirmation — they get undo.
export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-toast bg-ink/30 animate-fade-in" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-toast w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl2 border border-hairline bg-surface p-5 shadow-card outline-none">
          <AlertDialog.Title className="text-h3 font-semibold text-ink">{title}</AlertDialog.Title>
          {body && <AlertDialog.Description className="mt-2 text-small text-ink-soft">{body}</AlertDialog.Description>}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button variant="ghost" />}>{cancelLabel}</AlertDialog.Close>
            <Button variant={danger ? "danger" : "brutal"} busy={busy} onClick={() => void onConfirm()}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
