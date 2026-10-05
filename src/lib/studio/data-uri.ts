/**
 * Client-safe helper (no server-only imports): turn a sanitized SVG into a URL for <img src>.
 * An SVG shown through <img> cannot run scripts or load external resources, which is a second
 * line of defence behind the sanitizer.
 */
export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
