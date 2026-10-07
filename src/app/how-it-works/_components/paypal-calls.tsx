import { Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { StatusTone } from "@/components/ui/tone";
import { IDEMPOTENCY_NOTE, PAYPAL_CALLS, type PayPalCall } from "../content";

/** Hold is amber and settlement emerald everywhere in the product; the API families follow that. */
const API_TONE: Record<PayPalCall["api"], StatusTone> = {
  "Orders v2": "hold",
  "Payments v2": "success",
  "Vault v3": "info",
  Webhooks: "neutral",
};

const HEAD = "px-5 py-2.5 text-left font-mono text-[10px] leading-4 font-medium tracking-[0.08em] text-faint uppercase";

function Endpoint({ call }: { call: PayPalCall }) {
  const segments = call.path.split("/").filter((segment) => segment !== "");
  return (
    <code className="font-mono text-[12.5px] leading-5 text-fg">
      <span className="mr-1.5 text-muted">{call.method}</span>
      {/* A long path may wrap, but only in front of a slash, never inside a word. */}
      {segments.map((segment, index) => (
        <span key={index}>
          <wbr />/{segment}
        </span>
      ))}
    </code>
  );
}

/** The PayPal REST calls PACT makes, in the order a deal meets them. */
export function PayPalCalls() {
  return (
    <div data-testid="paypal-calls" className="overflow-hidden rounded-card border border-hairline bg-surface">
      {/* From lg up: a table. Below: the same rows as stacked blocks, because an endpoint does not fit a narrow column. */}
      <table className="hidden w-full border-collapse text-sm lg:table">
        <caption className="sr-only">PayPal REST calls made by PACT</caption>
        <thead>
          <tr className="border-b border-hairline bg-subtle/60">
            <th scope="col" className={HEAD}>
              Step
            </th>
            <th scope="col" className={HEAD}>
              API
            </th>
            <th scope="col" className={HEAD}>
              Call
            </th>
            <th scope="col" className={HEAD}>
              What PACT sends or checks
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {PAYPAL_CALLS.map((call) => (
            <tr key={call.id} data-call={call.id} className="align-top">
              <th scope="row" className="px-5 py-3.5 text-left text-sm leading-6 font-semibold whitespace-nowrap text-fg">
                {call.purpose}
              </th>
              <td className="px-5 py-3.5">
                <Badge tone={API_TONE[call.api]} variant="outline">
                  {call.api}
                </Badge>
              </td>
              <td className="px-5 py-3.5 whitespace-nowrap">
                <Endpoint call={call} />
              </td>
              <td className="px-5 py-3.5 text-[13px] leading-5 text-pretty text-muted">{call.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-hairline lg:hidden">
        {PAYPAL_CALLS.map((call) => (
          <li key={call.id} data-call={call.id} className="px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm leading-6 font-semibold text-fg">{call.purpose}</p>
              <Badge tone={API_TONE[call.api]} variant="outline">
                {call.api}
              </Badge>
            </div>
            <p className="mt-1">
              <Endpoint call={call} />
            </p>
            <p className="mt-1.5 text-[13px] leading-5 text-pretty text-muted">{call.detail}</p>
          </li>
        ))}
      </ul>
      <div className="flex gap-3 border-t border-hairline bg-subtle/60 px-5 py-4">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface text-muted [&_svg]:size-4">
          <Repeat />
        </span>
        <div>
          <p className="text-sm leading-6 font-semibold text-fg">
            Idempotent by construction: <code className="font-mono text-[13px] font-medium">PayPal-Request-Id</code>
          </p>
          <p className="mt-0.5 max-w-3xl text-[13px] leading-5 text-pretty text-muted">{IDEMPOTENCY_NOTE}</p>
          <p className="mt-2 font-mono text-[11px] leading-5 text-faint">
            <span className="tracking-[0.08em] uppercase">Covers</span>{" "}
            <span className="text-muted">{PAYPAL_CALLS.filter((call) => call.movesMoney).map((call) => call.purpose).join(" · ")}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
