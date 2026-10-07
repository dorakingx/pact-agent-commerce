"use client";

import { useCallback } from "react";
import useSWR from "swr";
import type { PolicyResponse } from "../api/dto";
import type { Policy } from "../domain/schemas";
import { api, fetcher, type ApiClientError } from "./api";

export const POLICY_KEY = "/api/policy";

export interface UsePolicy {
  /** The session's policy, what it has committed today and whether it is still the default. */
  data: PolicyResponse | undefined;
  error: ApiClientError | undefined;
  isLoading: boolean;
  /**
   * Replace the policy. The cache shows the new values at once and rolls back if the server
   * refuses them; the promise rejects with the ApiClientError so the form can show field errors.
   */
  save: (policy: Policy) => Promise<PolicyResponse>;
  /** Re-read from the server (the Retry button of the error state). */
  reload: () => void;
}

/** The session's spending policy (GET/PUT /api/policy). */
export function usePolicy(): UsePolicy {
  // Revalidating on focus is safe while the form is being edited: the draft is separate state,
  // and coming back from a deal in another tab should show what that deal committed today.
  const { data, error, isLoading, mutate } = useSWR<PolicyResponse, ApiClientError>(POLICY_KEY, fetcher);

  const save = useCallback(
    async (policy: Policy): Promise<PolicyResponse> => {
      const request = api.put<PolicyResponse>(POLICY_KEY, policy);
      await mutate(request, {
        optimisticData: (current) => ({ policy, spentTodayMinor: current?.spentTodayMinor ?? 0, isDefault: false }),
        rollbackOnError: true,
        populateCache: true,
        // The PUT already answers with the stored document and today's spend.
        revalidate: false,
      });
      return request;
    },
    [mutate],
  );

  const reload = useCallback(() => {
    void mutate();
  }, [mutate]);

  return { data, error, isLoading, save, reload };
}
