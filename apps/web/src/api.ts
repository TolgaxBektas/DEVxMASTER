export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function readableMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return readableMessage(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const messages = value
      .map((item) => readableMessage(item))
      .filter((item): item is string => Boolean(item));
    return messages.length ? messages.join(" ") : undefined;
  }
  if (value && typeof value === "object") {
    const candidate = value as { message?: unknown; path?: unknown };
    const message = readableMessage(candidate.message);
    if (!message) return undefined;
    const path = Array.isArray(candidate.path)
      ? candidate.path.filter((item) => typeof item === "string").join(".")
      : "";
    return path ? `${path}: ${message}` : message;
  }
  return undefined;
}

async function request<T>(
  path: string,
  input: unknown,
  method: "GET" | "POST",
): Promise<T> {
  const url = new URL(`/api/trpc/${path}`, window.location.origin);
  const options: RequestInit = { method, credentials: "include", headers: {} };
  if (method === "GET") {
    if (input !== undefined)
      url.searchParams.set("input", JSON.stringify({ json: input }));
  } else {
    options.headers = { "content-type": "application/json" };
    options.body = JSON.stringify({ json: input });
  }
  const response = await fetch(url, options);
  const body = (await response.json()) as {
    result?: { data?: { json?: T } };
    error?: { json?: { message?: string; code?: string } };
  };
  if (!response.ok || body.error) {
    throw new ApiError(
      readableMessage(body.error?.json?.message) ?? "Anfrage fehlgeschlagen",
      response.status,
      body.error?.json?.code,
    );
  }
  return body.result?.data?.json as T;
}

export const moduleApi = {
  query: <T>(path: string, input?: unknown) => request<T>(path, input, "GET"),
  mutate: <T>(path: string, input?: unknown) => request<T>(path, input, "POST"),
};

export async function sessionRequest(): Promise<{
  user: { id: string; displayName: string; email: string | null };
  tenantId: string;
}> {
  const response = await fetch("/api/auth/session", { credentials: "include" });
  if (!response.ok)
    throw new ApiError(
      "Anmeldung erforderlich",
      response.status,
      "UNAUTHORIZED",
    );
  return response.json() as Promise<{
    user: { id: string; displayName: string; email: string | null };
    tenantId: string;
  }>;
}

export async function login(externalId: string, secret: string) {
  const response = await fetch("/api/auth/local", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalId, secret }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { message?: string; code?: string };
    throw new ApiError(
      body.message ?? "Anmeldung fehlgeschlagen",
      response.status,
      body.code,
    );
  }
}

export function logout() {
  return fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}
