import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import { translateChallengeType } from "../utils/ui-text";
import type {
  AppEvent,
  AuthSessionView,
  DriverStatus,
  NodeDetail,
  NodeSummary,
  SerialPortInfo,
  SystemHealth,
  TestDefinition,
  TestLogRecord,
  TestRunRecord,
} from "../types";

const emptyStatus = (): DriverStatus => ({
  phase: "idle",
  isInclusionActive: false,
  isExclusionActive: false,
  hasReadyDriver: false,
  updatedAt: new Date().toISOString(),
});

export const usePlatformStore = defineStore("platform", () => {
  const authSession = ref<AuthSessionView>({
    isAuthenticationEnabled: false,
    supportsPasswordLogin: false,
    isAuthenticated: false,
  });
  const health = ref<SystemHealth | null>(null);
  const status = ref<DriverStatus>(emptyStatus());
  const ports = ref<SerialPortInfo[]>([]);
  const nodes = ref<NodeSummary[]>([]);
  const selectedNode = ref<NodeDetail | null>(null);
  const definitions = ref<TestDefinition[]>([]);
  const runs = ref<TestRunRecord[]>([]);
  const runLogs = ref<Record<string, TestLogRecord[]>>({});
  const configItems = ref<Array<{ key: string; value: unknown }>>([]);
  const notifications = ref<Array<{ id: string; title: string; body: string }>>([]);
  const inclusionChallenge = ref<Record<string, unknown> | null>(null);
  const selectedPortPath = ref<string>("");
  const wsState = ref<"idle" | "connecting" | "open" | "closed">("idle");
  const errorMessage = ref("");
  let socket: WebSocket | null = null;
  let statusPollTimer: number | null = null;

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function bootstrap(): Promise<void> {
    errorMessage.value = "";

    try {
      authSession.value = await apiClient.getAuthMe();

      if (authSession.value.isAuthenticationEnabled && !authSession.value.isAuthenticated) {
        health.value = null;
        nodes.value = [];
        definitions.value = [];
        runs.value = [];
        runLogs.value = {};
        selectedNode.value = null;
        stopStatusPolling();
        connectWebSocket(false);
        return;
      }

      const [healthResult, statusResult, portResult, nodeResult, definitionResult, runsResult, configResult] = await Promise.all([
        apiClient.getHealth(),
        apiClient.getStatus(),
        apiClient.listPorts(),
        apiClient.listNodes(),
        apiClient.listDefinitions(),
        apiClient.listRuns(),
        apiClient.getConfig(),
      ]);

      health.value = healthResult;
      applyStatus(statusResult);
      ports.value = portResult.items;
      nodes.value = nodeResult.items;
      definitions.value = definitionResult.items;
      runs.value = runsResult.items;
      configItems.value = configResult.items;
      selectedPortPath.value = statusResult.selectedPortPath ?? "";

      if (runs.value[0]) {
        const logs = await apiClient.getRunLogs(runs.value[0].id);
        runLogs.value[runs.value[0].id] = logs.items;
      }

      connectWebSocket(true);
    } catch (error) {
      errorMessage.value = getErrorMessage(error);
      pushNotification("初始化失败", errorMessage.value);
    }
  }

  function connectWebSocket(shouldConnect: boolean): void {
    if (socket) {
      socket.close();
      socket = null;
    }
    if (!shouldConnect) {
      wsState.value = "idle";
      return;
    }
    wsState.value = "connecting";
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const token = window.localStorage.getItem("zwaveApiToken");
    const wsUrl = new URL(`${protocol}://${window.location.host}/ws/events`);
    if (token && token.trim()) {
      wsUrl.searchParams.set("token", token.trim());
    }
    socket = new WebSocket(wsUrl.toString());
    socket.onopen = () => {
      wsState.value = "open";
    };
    socket.onclose = () => {
      wsState.value = "closed";
    };
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as AppEvent;
      handleEvent(payload);
    };
  }

  async function login(username: string, password: string): Promise<void> {
    const result = await apiClient.login({ username, password });
    window.localStorage.setItem("zwaveApiToken", result.token);
    authSession.value = result.session;
    await bootstrap();
  }

  async function logout(): Promise<void> {
    await apiClient.logout();
    window.localStorage.removeItem("zwaveApiToken");
    authSession.value = {
      isAuthenticationEnabled: authSession.value.isAuthenticationEnabled,
      supportsPasswordLogin: authSession.value.supportsPasswordLogin,
      isAuthenticated: false,
    };
    health.value = null;
    nodes.value = [];
    definitions.value = [];
    runs.value = [];
    runLogs.value = {};
    selectedNode.value = null;
    stopStatusPolling();
    connectWebSocket(false);
  }

  function applyStatus(nextStatus: DriverStatus): void {
    const previousReady = status.value.hasReadyDriver;
    status.value = nextStatus;

    if (!previousReady && nextStatus.hasReadyDriver) {
      void refreshNodes();
    }

    if (nextStatus.phase === "connecting") {
      startStatusPolling();
    } else {
      stopStatusPolling();
    }
  }

  function startStatusPolling(): void {
    if (statusPollTimer != null) {
      return;
    }

    const poll = async () => {
      try {
        const latestStatus = await apiClient.getStatus();
        applyStatus(latestStatus);
      } catch {
        // Ignore transient polling failures while the websocket remains the primary source of truth.
      }

      if (status.value.phase === "connecting") {
        statusPollTimer = window.setTimeout(poll, 1500);
        return;
      }

      statusPollTimer = null;
    };

    statusPollTimer = window.setTimeout(poll, 1500);
  }

  function stopStatusPolling(): void {
    if (statusPollTimer == null) {
      return;
    }
    window.clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }

  function pushNotification(title: string, body: string): void {
    notifications.value.unshift({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      title,
      body,
    });
    notifications.value = notifications.value.slice(0, 8);
  }

  function handleEvent(event: AppEvent): void {
    if (event.type === "system.health") {
      health.value = event.payload as SystemHealth;
      return;
    }

    if (event.type === "zwave.status.changed") {
      applyStatus(event.payload as DriverStatus);
      return;
    }

    if (event.type === "zwave.inclusion.challenge") {
      inclusionChallenge.value = event.payload as Record<string, unknown>;
      pushNotification("入网挑战", translateChallengeType(String((event.payload as { challengeType?: string }).challengeType ?? "未知")));
      return;
    }

    if (event.type === "zwave.inclusion.challenge.aborted") {
      inclusionChallenge.value = null;
      pushNotification("入网流程", "安全授权流程已中止");
      return;
    }

    if (event.type === "zwave.node.added" || event.type === "zwave.node.updated" || event.type === "zwave.node.removed") {
      void refreshNodes();
      return;
    }

    if (event.type === "test.run.created" || event.type === "test.run.started" || event.type === "test.run.finished") {
      void refreshRuns();
      return;
    }

    if (event.type === "test.run.log") {
      const log = event.payload as TestLogRecord;
      runLogs.value[log.testRunId] = [...(runLogs.value[log.testRunId] ?? []), log];
      return;
    }
  }

  async function refreshPorts(): Promise<void> {
    ports.value = (await apiClient.listPorts()).items;
  }

  async function saveSelectedPort(path: string, stablePath?: string): Promise<void> {
    await apiClient.selectPort({ path, stablePath });
    selectedPortPath.value = path;
    status.value.selectedPortPath = path;
  }

  async function connectDriver(): Promise<void> {
    await runAction("连接失败", async () => {
      const latestStatus = await apiClient.connect();
      applyStatus(latestStatus);
      if (latestStatus.hasReadyDriver) {
        await refreshNodes();
      }
    });
  }

  async function disconnectDriver(): Promise<void> {
    await runAction("断开失败", async () => {
      applyStatus(await apiClient.disconnect());
    });
  }

  async function reconnectDriver(): Promise<void> {
    await runAction("重连失败", async () => {
      const latestStatus = await apiClient.reconnect();
      applyStatus(latestStatus);
      if (latestStatus.hasReadyDriver) {
        await refreshNodes();
      }
    });
  }

  async function refreshNodes(): Promise<void> {
    nodes.value = (await apiClient.listNodes()).items;
    if (selectedNode.value) {
      selectedNode.value = await apiClient.getNode(selectedNode.value.nodeId);
    }
  }

  async function selectNode(nodeId: number): Promise<void> {
    selectedNode.value = await apiClient.getNode(nodeId);
  }

  async function refreshDefinitions(): Promise<void> {
    definitions.value = (await apiClient.listDefinitions()).items;
  }

  async function refreshRuns(): Promise<void> {
    runs.value = (await apiClient.listRuns()).items;
  }

  async function loadRunLogs(runId: string): Promise<void> {
    runLogs.value[runId] = (await apiClient.getRunLogs(runId)).items;
  }

  async function startInclusion(): Promise<void> {
    await runAction("启动入网失败", async () => {
      await apiClient.startInclusion();
    });
  }

  async function stopInclusion(): Promise<void> {
    await runAction("停止入网失败", async () => {
      await apiClient.stopInclusion();
    });
  }

  async function startExclusion(): Promise<void> {
    await runAction("启动排除失败", async () => {
      await apiClient.startExclusion();
    });
  }

  async function stopExclusion(): Promise<void> {
    await runAction("停止排除失败", async () => {
      await apiClient.stopExclusion();
    });
  }

  async function submitGrantSecurity(payload: { requestId: string; grant: string[]; clientSideAuth: boolean }): Promise<void> {
    await apiClient.grantSecurity(payload);
    inclusionChallenge.value = null;
  }

  async function submitValidateDsk(payload: { requestId: string; pin: string }): Promise<void> {
    await apiClient.validateDsk(payload);
    inclusionChallenge.value = null;
  }

  async function runTest(payload: { testDefinitionId: string; nodeId: number; inputs: Record<string, unknown> }): Promise<void> {
    const run = await apiClient.createRun(payload);
    await refreshRuns();
    await loadRunLogs(run.id);
  }

  async function cancelRun(runId: string): Promise<void> {
    await runAction("取消测试失败", async () => {
      await apiClient.cancelRun(runId);
    });
  }

  async function pingNode(nodeId: number): Promise<boolean> {
    return (await apiClient.pingNode(nodeId)).ok;
  }

  async function healNode(nodeId: number): Promise<unknown> {
    return (await apiClient.healNode(nodeId)).result;
  }

  async function runAction(title: string, handler: () => Promise<void>): Promise<void> {
    errorMessage.value = "";
    try {
      await handler();
    } catch (error) {
      errorMessage.value = getErrorMessage(error);
      pushNotification(title, errorMessage.value);
    }
  }

  const latestRun = computed(() => runs.value[0] ?? null);

  return {
    health,
    authSession,
    status,
    ports,
    nodes,
    selectedNode,
    definitions,
    runs,
    runLogs,
    configItems,
    notifications,
    inclusionChallenge,
    selectedPortPath,
    wsState,
    errorMessage,
    latestRun,
    bootstrap,
    login,
    logout,
    refreshPorts,
    saveSelectedPort,
    connectDriver,
    disconnectDriver,
    reconnectDriver,
    refreshNodes,
    selectNode,
    refreshDefinitions,
    refreshRuns,
    loadRunLogs,
    startInclusion,
    stopInclusion,
    startExclusion,
    stopExclusion,
    submitGrantSecurity,
    submitValidateDsk,
    runTest,
    cancelRun,
    pingNode,
    healNode,
  };
});
