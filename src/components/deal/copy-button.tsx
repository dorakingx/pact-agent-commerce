"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui";

const FEEDBACK_MS = 1600;

/** Copies a longer text (the contract JSON) and confirms it in place. */
export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
    } catch {
      // Clipboard access can be refused (permissions, insecure context); the text stays selectable.
      setCopied(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => void copy()} data-testid={testId}>
      {copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}
