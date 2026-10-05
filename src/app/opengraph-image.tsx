import { ImageResponse } from "next/og";
import { BRAND, MARK_CHECK, MARK_PARTY_A, MARK_PARTY_B, MARK_STROKE_WIDTH, MARK_VIEWBOX } from "@/components/brand/mark";

export const alt = "PACT — AI agents can negotiate. PACT makes sure they only get paid when the deal is done.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const RAIL = ["Contract", "Authorize", "Deliver", "Verify", "Capture"] as const;

/**
 * Social card: wordmark and pitch on ink. Rendered by Satori, which supports only a subset of
 * CSS (flexbox, no grid, explicit `display: flex` on every multi-child element) and only the
 * regular weight of the bundled Geist font, so hierarchy comes from size and colour, not weight.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          backgroundColor: BRAND.ink,
          color: BRAND.paper,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg
            width="56"
            height="56"
            viewBox={MARK_VIEWBOX}
            fill="none"
            strokeWidth={MARK_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={MARK_PARTY_A} stroke={BRAND.paper} />
            <path d={MARK_PARTY_B} stroke={BRAND.paper} />
            <path d={MARK_CHECK} stroke={BRAND.emeraldBright} />
          </svg>
          <div style={{ display: "flex", marginLeft: 18, fontSize: 40, letterSpacing: 6 }}>PACT</div>
          <div style={{ display: "flex", marginLeft: 22, fontSize: 22, color: BRAND.slate }}>
            Programmable Agent Commerce Trust
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 68, lineHeight: 1.08, letterSpacing: -2.4, color: BRAND.slate }}>
            AI agents can negotiate.
          </div>
          <div style={{ display: "flex", marginTop: 6, fontSize: 68, lineHeight: 1.08, letterSpacing: -2.4, maxWidth: 1000 }}>
            PACT makes sure they only get paid when the deal is done.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {RAIL.map((step, index) => {
              const last = index === RAIL.length - 1;
              return (
                <div key={step} style={{ display: "flex", alignItems: "center" }}>
                  <div
                    style={{
                      display: "flex",
                      padding: "8px 18px",
                      borderRadius: 999,
                      fontSize: 22,
                      border: `2px solid ${last ? BRAND.emeraldBright : "#2C3A50"}`,
                      color: last ? BRAND.emeraldBright : BRAND.paper,
                    }}
                  >
                    {step}
                  </div>
                  {last ? null : <div style={{ display: "flex", width: 28, height: 2, backgroundColor: "#2C3A50" }} />}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: BRAND.slate }}>Runs on PayPal Sandbox</div>
        </div>
      </div>
    ),
    size,
  );
}
