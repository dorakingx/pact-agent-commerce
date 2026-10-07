/**
 * The ledger's AG Grid theme: Quartz with every colour bound to the app's CSS variables.
 *
 * The variables themselves flip with `data-theme` on <html>, so this one parameter set is
 * correct in light and dark without a second "dark" variant. The root layout also keeps
 * `data-ag-theme-mode` in sync, which switches the parts this file leaves at their defaults
 * (native form controls, scrollbars) to the matching colour scheme.
 */
import { themeQuartz } from "ag-grid-community";

/** Row and header heights in pixels. Compact, but a status pill and a 44px-free pointer target still fit. */
export const LEDGER_ROW_HEIGHT = 42;
export const LEDGER_HEADER_HEIGHT = 38;

export const ledgerTheme = themeQuartz.withParams({
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--fg)",
  accentColor: "var(--accent)",
  borderColor: "var(--hairline)",
  chromeBackgroundColor: "var(--subtle)",
  textColor: "var(--fg)",
  subtleTextColor: "var(--fg-muted)",

  fontFamily: "inherit",
  fontSize: 13,
  spacing: 6,
  cellHorizontalPadding: 10,
  rowHeight: LEDGER_ROW_HEIGHT,
  headerHeight: LEDGER_HEADER_HEIGHT,

  headerBackgroundColor: "var(--subtle)",
  headerTextColor: "var(--fg-muted)",
  headerFontSize: 12,
  headerFontWeight: 600,
  headerColumnBorder: false,
  headerColumnResizeHandleColor: "var(--hairline-strong)",

  // The surrounding card draws the frame; a second border and radius inside it would double up.
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowBorder: { color: "var(--hairline)" },
  columnBorder: false,
  pinnedColumnBorder: { color: "var(--hairline)" },
  pinnedRowBorder: { color: "var(--hairline-strong)" },
  rowHoverColor: "var(--subtle)",
  selectedRowBackgroundColor: "var(--accent-soft)",
  rangeSelectionBorderColor: "var(--accent)",

  inputBackgroundColor: "var(--surface)",
  inputBorder: { color: "var(--hairline-strong)" },
  inputFocusBorder: { color: "var(--accent)" },
  inputPlaceholderTextColor: "var(--fg-faint)",
  focusShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)",

  menuBackgroundColor: "var(--surface)",
  menuBorder: { color: "var(--hairline)" },
  menuShadow: "var(--shadow-pop-value)",
  tooltipBackgroundColor: "var(--inverse)",
  tooltipTextColor: "var(--on-inverse)",
  tooltipBorder: false,
});
