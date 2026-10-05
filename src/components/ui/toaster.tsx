"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { Spinner } from "./spinner";
import { useTheme } from "./use-theme";

/*
 * Sonner ships its own light/dark palette. Setting its variables inline (which outranks its
 * stylesheet) points toasts at the PACT tokens instead, so they match every other surface.
 */
const TOKEN_STYLE = {
  "--normal-bg": "var(--surface)",
  "--normal-text": "var(--fg)",
  "--normal-border": "var(--hairline-strong)",
  "--border-radius": "var(--radius-card)",
} as React.CSSProperties;

/**
 * App-wide toast outlet, mounted once in the root layout. Raise toasts with `toast` from
 * `@/components/ui`. Status is carried by the icon as well as its colour.
 */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      gap={10}
      closeButton
      style={TOKEN_STYLE}
      icons={{
        success: <CircleCheck aria-hidden="true" className="size-4 text-success" />,
        info: <Info aria-hidden="true" className="size-4 text-info" />,
        warning: <TriangleAlert aria-hidden="true" className="size-4 text-hold" />,
        error: <CircleAlert aria-hidden="true" className="size-4 text-danger" />,
        loading: <Spinner label={null} className="size-4 text-muted" />,
      }}
      {...props}
    />
  );
}
