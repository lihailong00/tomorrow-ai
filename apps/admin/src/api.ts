export type Session = {
  user: { id: string; email: string; name: string; role: string };
  csrf_token: string;
  expires_at?: string;
};
export type Setting = {
  key: string;
  group: string;
  label: string;
  secret: boolean;
  locked: boolean;
  source: string;
  configured: boolean;
  value?: string | number | boolean | null;
  description?: string;
  options?: string[];
  kind?: string;
  restart_required?: boolean;
};
export type Config = { revision: number; settings: Setting[] };
export type ProviderProbe = {
  ok: boolean;
  code: string;
  message: string;
  elapsed_ms: number;
  upstream_status?: number | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
};
export type Instance = {
  id?: string;
  instance_id?: string;
  name?: string;
  instance_name?: string;
  public_url?: string;
  mode?: string;
  deployment_mode?: string;
  version?: string;
  [key: string]: unknown;
};
export type Status = {
  instance: Instance;
  counts?: Record<string, number | null>;
  readiness?: {
    revision: number;
    groups: {
      id: string;
      label: string;
      status: string;
      verified: boolean;
      missing: string[];
      message: string;
    }[];
  };
  services?: Record<string, unknown>;
  configuration_revision?: number;
  [key: string]: unknown;
};
export type User = {
  id: string;
  email: string;
  name: string;
  created_at: string;
  disabled: boolean;
  role: string;
};
export type UserPage = {
  items: User[];
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
};
export type Backup = {
  id: string;
  status: string;
  created_at: string;
  bytes?: number;
  error?: string | null;
};
export type Backups = {
  items: Backup[];
  supported: boolean;
  reason?: string | null;
  max_bytes?: number;
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function isSessionExpired(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    error.code !== "invalid_credentials"
  );
}

export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    csrf?: string;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid API path");
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.csrf) headers["X-CSRF-Token"] = options.csrf;
  const response = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const data =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      typeof data?.error?.code === "string"
        ? data.error.code
        : "request_failed";
    // Backend messages are deliberately generic and contain no provider payloads or submitted secrets.
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : `请求未完成（${response.status}）`;
    throw new ApiError(response.status, code, message);
  }
  return data as T;
}

export type Edit = { mode: "keep" | "replace" | "delete"; value: string };
export function remainingEdits(current: Record<string, Edit>, submitted: Record<string, Edit>): Record<string, Edit> {
  return Object.fromEntries(Object.entries(current).filter(([key, edit]) => {
    const saved = submitted[key];
    return !saved || edit.mode !== saved.mode || edit.value !== saved.value;
  }));
}
export function configurationChanges(
  settings: Setting[],
  edits: Record<string, Edit>
): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  for (const item of settings) {
    if (item.locked) continue;
    const edit = edits[item.key];
    if (!edit || edit.mode === "keep") continue;
    if (edit.mode === "delete") changes[item.key] = null;
    else if (item.secret) {
      // An empty password field never removes or overwrites a configured secret.
      if (edit.value.trim()) changes[item.key] = edit.value.trim();
    } else if (edit.value !== String(item.value ?? ""))
      changes[item.key] = edit.value;
  }
  return changes;
}

export function connectUrl(instance: Instance, fallback: string): string {
  const origin = safePublicUrl(instance) || fallback;
  const url = new URL("tada://connect");
  url.searchParams.set("url", origin.replace(/\/$/, ""));
  const id = instance.instance_id ?? instance.id;
  if (id) url.searchParams.set("instance", id);
  return url.toString();
}

export function safePublicUrl(instance: Instance): string {
  try {
    const url = new URL(String(instance.public_url ?? ""));
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
