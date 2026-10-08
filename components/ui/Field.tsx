"use client";

import { useId } from "react";

// A visible label, one input look, an error that is announced. Never a
// placeholder as the only label.
interface Common {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  className?: string;
  /** Indic label text? Sets lang so the typography rules apply. */
  lang?: string;
}

export function Field({
  label, hint, error, className = "", lang, children, id,
}: Common & { children: (id: string, describedBy: string | undefined) => React.ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  const described = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label htmlFor={fid} className="block text-small font-medium text-ink-soft" lang={lang}>
        {label}
      </label>
      <div className="mt-1">{children(fid, described)}</div>
      {hint && !error && (
        <p id={hintId} className="mt-1 text-micro text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="mt-1 text-micro font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & Common;
export function TextField({ label, hint, error, className, lang, ...input }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className} lang={lang} id={input.id}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`field-input ${input.inputMode === "numeric" || input.inputMode === "tel" ? "tnum" : ""}`}
          {...input}
        />
      )}
    </Field>
  );
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & Common;
export function SelectField({ label, hint, error, className, lang, children, ...select }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className} lang={lang} id={select.id}>
      {(id, describedBy) => (
        <select id={id} aria-describedby={describedBy} className="field-input" {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & Common;
export function TextareaField({ label, hint, error, className, lang, ...ta }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error} className={className} lang={lang} id={ta.id}>
      {(id, describedBy) => <textarea id={id} aria-describedby={describedBy} className="field-input min-h-[80px]" {...ta} />}
    </Field>
  );
}
