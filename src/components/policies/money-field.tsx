"use client";

import { CircleAlert, Info } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface MoneyFieldProps {
  /** Also the stem of the hint / message ids and of the `data-testid`. */
  id: string;
  label: string;
  /** What the limit does, in one line. Always visible. */
  hint: string;
  /** The dollars text being edited. */
  value: string;
  onChange: (text: string) => void;
  onBlur: () => void;
  /** Blocks saving. */
  error?: string;
  /** Advice about a valid value; shown only when there is no error. */
  note?: string;
  disabled?: boolean;
}

/**
 * A dollar amount edited as text. It is deliberately not `type="number"`: that input drops
 * trailing zeros, accepts "1e3" and changes value on scroll, none of which belongs near money.
 */
export function MoneyField({ id, label, hint, value, onChange, onBlur, error, note, disabled }: MoneyFieldProps) {
  const hintId = `${id}-hint`;
  const messageId = `${id}-message`;
  const message = error ?? note;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-muted">
          $
        </span>
        <Input
          id={id}
          data-testid={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? `${hintId} ${messageId}` : hintId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="pr-12 pl-7 font-mono tabular-nums"
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-faint">
          USD
        </span>
      </div>
      <p id={hintId} className="text-xs leading-[18px] text-pretty text-muted">
        {hint}
      </p>
      {/* Always in the DOM so a message that appears while typing is announced, politely. */}
      <p
        id={messageId}
        aria-live="polite"
        data-testid={`${id}-${error ? "error" : "note"}`}
        className={cn("flex gap-1.5 text-xs leading-[18px] text-pretty", error ? "font-medium text-danger" : "text-hold", !message && "hidden")}
      >
        {message ? (
          <>
            {error ? <CircleAlert aria-hidden="true" className="mt-[3px] size-3 shrink-0" /> : <Info aria-hidden="true" className="mt-[3px] size-3 shrink-0" />}
            <span>{message}</span>
          </>
        ) : null}
      </p>
    </div>
  );
}
