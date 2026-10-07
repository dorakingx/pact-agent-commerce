/* TEMPORARY development host for the AG Studio dashboard. Deleted before hand-off. */
import { Suspense } from "react";
import { AppShell } from "@/components/shell";
import { DevHost } from "./dev-host";

export const metadata = { title: "Studio dev" };

export default function Page() {
  return (
    <AppShell width="full" hideFooter>
      <div className="container-page py-6" style={{ maxWidth: 1680 }}>
        <Suspense>
          <DevHost />
        </Suspense>
      </div>
    </AppShell>
  );
}
