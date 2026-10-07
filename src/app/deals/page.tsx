import { redirect } from "next/navigation";

/** There is no deal index of its own: a session's deals are listed in the workspace. */
export default function DealsIndexPage(): never {
  redirect("/workspace");
}
