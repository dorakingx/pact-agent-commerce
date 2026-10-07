/**
 * PACT's AG Studio theme.
 *
 * Every colour is a reference to one of the app's design tokens (globals.css), never a literal,
 * so Studio's chrome, its grids and its charts flip with the rest of the product. The tokens
 * themselves change with `data-theme`; Studio's own mode follows `data-ag-theme-mode`, which the
 * app's theme toggle keeps in sync on <html>.
 *
 * The same parameters are registered for Studio's `light` and `dark` modes (and as the base).
 * That is deliberate: Studio's default theme ships dark-mode values of its own, and a mode's
 * values outrank the base, so anything left unset for `dark` would fall back to AG's palette
 * instead of PACT's.
 */
import { studioTheme, type AgStudioTheme, type AgStudioThemeParams } from "ag-studio";

const SANS = 'var(--font-geist-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Chart series colours, in the order series are assigned. PACT's status hues carry meaning
 * everywhere else in the product, so the palette reuses them instead of introducing colours that
 * mean nothing: emerald is money captured, amber is money held, red is a failure. The default
 * report lists its measures in this order (captured before authorized; passed, uncertain,
 * failed), which is what makes a chart's colours agree with the pills next to it.
 */
const PALETTE = ["--success", "--hold", "--danger", "--info", "--neutral", "--review"] as const;

type PaletteParams = Partial<Record<`chartPalette${"Fills" | "Strokes"}${number}Color`, string>>;

function paletteParams(): PaletteParams {
  const params: PaletteParams = {};
  // Twelve slots: the six hues, then the same six again. A chart with more series than that is
  // unreadable whatever it is painted with.
  for (let slot = 1; slot <= 12; slot += 1) {
    const token = `var(${PALETTE[(slot - 1) % PALETTE.length]})`;
    params[`chartPaletteFills${slot}Color`] = token;
    params[`chartPaletteStrokes${slot}Color`] = token;
  }
  return params;
}

function pactParams(scheme: "light" | "dark" | "inherit"): Partial<AgStudioThemeParams> {
  return {
    browserColorScheme: scheme,

    /* Shared: Studio chrome, grids and charts */
    accentColor: "var(--accent)",
    backgroundColor: "var(--surface)",
    foregroundColor: "var(--fg)",
    textColor: "var(--fg)",
    subtleTextColor: "var(--fg-muted)",
    borderColor: "var(--hairline)",
    borderRadius: 8,
    fontFamily: SANS,
    fontSize: 13,
    iconColor: "var(--fg-muted)",
    invalidColor: "var(--danger)",
    rowHoverColor: "var(--subtle)",
    menuBackgroundColor: "var(--surface)",
    menuTextColor: "var(--fg)",
    menuSeparatorColor: "var(--hairline)",
    menuBorder: "1px solid var(--hairline-strong)",
    menuShadow: "var(--shadow-pop-value)",
    popupShadow: "var(--shadow-pop-value)",
    dropdownShadow: "var(--shadow-pop-value)",
    dialogShadow: "var(--shadow-pop-value)",
    dialogBorder: "1px solid var(--hairline-strong)",
    // The app's focus ring: a 2px accent outline standing off the surface.
    focusShadow: "0 0 0 2px var(--surface), 0 0 0 4px var(--accent)",
    tooltipBackgroundColor: "var(--inverse)",
    tooltipTextColor: "var(--on-inverse)",
    tooltipBorder: "1px solid var(--hairline-strong)",
    toggleButtonOnBackgroundColor: "var(--accent)",
    toggleButtonOffBackgroundColor: "var(--hairline-strong)",
    toggleButtonSwitchBackgroundColor: "var(--surface)",
    buttonBackgroundColor: "var(--surface)",
    buttonTextColor: "var(--fg)",
    buttonBorder: "1px solid var(--hairline-strong)",
    buttonBorderRadius: 8,
    buttonFontWeight: 500,
    buttonHoverBackgroundColor: "var(--subtle)",
    inputBackgroundColor: "var(--surface)",
    inputBorder: "1px solid var(--hairline-strong)",
    inputBorderRadius: 8,
    inputTextColor: "var(--fg)",
    inputPlaceholderTextColor: "var(--fg-faint)",
    inputFocusBorder: "1px solid var(--accent)",

    /* Studio chrome */
    studioWrapperBackgroundColor: "var(--canvas)",
    studioWrapperBorder: "1px solid var(--hairline)",
    studioWrapperBorderRadius: 10,
    studioPanelContainerBackgroundColor: "var(--surface)",
    studioPanelContainerBorder: "1px solid var(--hairline)",
    studioPanelContainerBorderRadius: 10,
    studioPanelDividerActiveColor: "var(--accent)",
    studioPanelHeaderFontFamily: SANS,
    studioPanelHeaderFontSize: 13,
    studioPanelHeaderFontWeight: 600,
    studioPanelSectionBorderColor: "var(--hairline)",
    studioPanelGroupBackgroundColor: "var(--subtle)",
    studioFormLabelColor: "var(--fg-muted)",
    studioCanvasBackgroundColor: "var(--canvas)",
    studioCanvasFontFamily: SANS,
    studioCanvasGridLineColor: "var(--hairline-strong)",
    studioCanvasDragPreviewBackgroundColor: "var(--accent-soft)",
    studioWidgetBackgroundColor: "var(--surface)",
    studioWidgetBorder: "1px solid var(--hairline)",
    studioWidgetBorderRadius: 10,
    studioWidgetResizeBorderColor: "var(--accent)",
    studioWidgetToolbarBackgroundColor: "var(--surface)",
    studioWidgetToolbarBorder: "1px solid var(--hairline-strong)",
    studioWidgetToolbarShadow: "var(--shadow-pop-value)",
    studioWidgetToolbarButtonColor: "var(--fg-muted)",
    studioWidgetToolbarButtonHoverBackgroundColor: "var(--subtle)",
    studioWidgetLoadingOverlayBackgroundColor: "var(--surface)",
    studioWidgetNoDataOverlayBackgroundColor: "var(--surface)",
    // Dashboard typography: a 14px semibold title over muted 12px supporting lines.
    studioWidgetTitleFontFamily: SANS,
    studioWidgetTitleFontSize: 14,
    studioWidgetTitleFontWeight: 600,
    studioWidgetTitleTextColor: "var(--fg)",
    studioWidgetSubtitleFontFamily: SANS,
    studioWidgetSubtitleFontSize: 12,
    studioWidgetSubtitleTextColor: "var(--fg-muted)",
    studioWidgetCaptionFontFamily: SANS,
    studioWidgetCaptionFontSize: 12,
    studioWidgetCaptionFontWeight: 500,
    studioWidgetCaptionTextColor: "var(--fg-muted)",
    studioValueWidgetFontSize: 26,
    studioToggleButtonActiveBackgroundColor: "var(--accent-soft)",
    studioToggleButtonActiveBorderColor: "var(--accent)",
    studioToggleButtonActiveColor: "var(--accent)",
    studioAiPanelWidth: 372,
    studioAiPanelInputMessageBackgroundColor: "var(--subtle)",
    studioAiPanelRichTextAccentBackgroundColor: "var(--subtle)",
    studioAiPanelButtonHoverBackgroundColor: "var(--subtle)",

    /* Grid widgets */
    gridFontFamily: SANS,
    gridAccentColor: "var(--accent)",
    gridDataBackgroundColor: "var(--surface)",
    gridHeaderBackgroundColor: "var(--subtle)",
    gridHeaderTextColor: "var(--fg-muted)",
    gridHeaderFontSize: 12,
    gridHeaderFontWeight: 600,
    gridCellTextColor: "var(--fg)",
    gridOddRowBackgroundColor: "transparent",
    gridRowHoverColor: "var(--subtle)",
    gridRowBorder: "1px solid var(--hairline)",
    gridHeaderRowBorder: "1px solid var(--hairline)",
    gridWrapperBorder: "none",

    /* Chart widgets */
    chartFontFamily: SANS,
    chartTextColor: "var(--fg)",
    chartSubtleTextColor: "var(--fg-muted)",
    chartAccentColor: "var(--accent)",
    chartBorderColor: "var(--hairline)",
    chartAxisLineColor: "var(--hairline-strong)",
    chartGridLineColor: "var(--hairline)",
    chartTooltipBackgroundColor: "var(--surface)",
    chartTooltipTextColor: "var(--fg)",
    chartTooltipBorder: "1px solid var(--hairline-strong)",
    chartTooltipBorderRadius: 8,
    chartPopupShadow: "var(--shadow-pop-value)",
    chartCrosshairLabelBackgroundColor: "var(--inverse)",
    chartCrosshairLabelTextColor: "var(--on-inverse)",
    ...paletteParams(),
  };
}

export const pactStudioTheme: AgStudioTheme = studioTheme
  .withParams(pactParams("inherit"))
  .withParams(pactParams("light"), "light")
  .withParams(pactParams("dark"), "dark");
