import type {
  AuthSessionView,
  DriverStatus,
  InclusionChallenge,
  NodeDetail,
  NodeSummary,
  SerialPortInfo,
  SystemHealth,
  TestDefinition,
  TestLogRecord,
  TestRunRecord,
} from "../types";

function readApiToken(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const token = window.localStorage.getItem("zwaveApiToken");
  return token && token.trim() ? token.trim() : undefined;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const token = readApiToken();
  const response = await fetch(input, {
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-api-token": token } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((data as { message?: string }).message ?? `请求失败：${response.status}`);
  }
  return data as T;
}

export const apiClient = {
  getAuthMe() {
    return request<AuthSessionView>("/api/auth/me");
  },
  login(payload: { username: string; password: string }) {
    return request<{ token: string; session: AuthSessionView }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  logout() {
    return request<{ ok: boolean; session: AuthSessionView }>("/api/auth/logout", {
      method: "POST",
    });
  },
  getHealth() {
    return request<SystemHealth>("/api/system/health");
  },
  getConfig() {
    return request<{ items: Array<{ key: string; value: unknown }> }>("/api/system/config");
  },
  updateConfig(payload: Record<string, unknown>) {
    return request<{ ok: boolean }>("/api/system/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },
  listPorts() {
    return request<{ items: SerialPortInfo[] }>("/api/serial/ports");
  },
  selectPort(payload: { path: string; stablePath?: string }) {
    return request<{ ok: boolean }>("/api/serial/select", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  getStatus() {
    return request<DriverStatus>("/api/zwave/status");
  },
  connect() {
    return request<DriverStatus>("/api/zwave/connect", { method: "POST" });
  },
  disconnect() {
    return request<DriverStatus>("/api/zwave/disconnect", { method: "POST" });
  },
  reconnect() {
    return request<DriverStatus>("/api/zwave/reconnect", { method: "POST" });
  },
  startInclusion() {
    return request<{ ok: boolean }>("/api/zwave/inclusion/start", { method: "POST" });
  },
  getInclusionChallenge() {
    return request<{ challenge: InclusionChallenge | null }>("/api/zwave/inclusion/challenge");
  },
  stopInclusion() {
    return request<{ ok: boolean }>("/api/zwave/inclusion/stop", { method: "POST" });
  },
  startExclusion() {
    return request<{ ok: boolean }>("/api/zwave/exclusion/start", { method: "POST" });
  },
  stopExclusion() {
    return request<{ ok: boolean }>("/api/zwave/exclusion/stop", { method: "POST" });
  },
  resetController() {
    return request<DriverStatus>("/api/zwave/controller/reset", { method: "POST" });
  },
  grantSecurity(payload: { requestId: string; grant: string[]; clientSideAuth: boolean }) {
    return request<{ ok: boolean }>("/api/zwave/inclusion/grant-security", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  validateDsk(payload: { requestId: string; pin: string }) {
    return request<{ ok: boolean }>("/api/zwave/inclusion/validate-dsk", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  listNodes() {
    return request<{ items: NodeSummary[] }>("/api/nodes");
  },
  getNode(nodeId: number) {
    return request<NodeDetail>(`/api/nodes/${nodeId}`);
  },
  refreshNode(nodeId: number) {
    return request<NodeDetail>(`/api/nodes/${nodeId}/refresh`, { method: "POST" });
  },
  pingNode(nodeId: number) {
    return request<{ ok: boolean }>(`/api/nodes/${nodeId}/ping`, { method: "POST" });
  },
  healNode(nodeId: number) {
    return request<{ result: unknown }>(`/api/nodes/${nodeId}/heal`, { method: "POST" });
  },
  listDefinitions() {
    return request<{ items: TestDefinition[] }>("/api/tests/definitions");
  },
  listSupportedDefinitions(nodeId: number) {
    return request<{ items: TestDefinition[] }>(`/api/tests/definitions/supported/${nodeId}`);
  },
  listRuns() {
    return request<{ items: TestRunRecord[] }>("/api/tests/runs");
  },
  getRunLogs(runId: string) {
    return request<{ items: TestLogRecord[] }>(`/api/tests/runs/${runId}/logs`);
  },
  createRun(payload: { testDefinitionId: string; nodeId: number; inputs: Record<string, unknown> }) {
    return request<TestRunRecord>("/api/tests/run", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  cancelRun(runId: string) {
    return request<{ ok: boolean }>(`/api/tests/runs/${runId}/cancel`, { method: "POST" });
  },
};
