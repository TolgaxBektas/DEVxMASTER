import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ModuleUiApi } from "./types.js";

export function useModuleQuery<T>(
  api: ModuleUiApi,
  path: string,
  input?: unknown,
): UseQueryResult<T, Error> {
  return useQuery({
    queryKey: ["trpc", path, input],
    queryFn: () => api.query<T>(path, input),
  });
}
