import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { apiClient } from "../api/client";
import type {
  AppEvent,
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

const emptyStatus = (): DriverStatus => ({
  phase: "idle",
  isInclusionActive: false,
  isExclusionActive: false,
  hasReadyDriver: false,
  updatedAt: new Date().toISOString(),
});

const PROVISIONING_SETTLE_POLLS = 20;
const INCLUSION_DISCOVERY_GRACE_MS = 5000;
const INCLUSION_INTERVIEW_WAIT_MS = 3 * 60 * 1000;

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
  const inclusionChallenge = ref<InclusionChallenge | null>(null);
  const provisioningMode = ref<"idle" | "include" | "exclude">("idle");
  const provisioningResult = ref<"idle" | "running" | "success" | "stopped">("idle");
  const foundIncludedNode = ref<{ nodeId: number; timestamp: string } | null>(null);
  const pendingIncludedNode = ref<{ nodeId: number; name?: string; timestamp: string } | null>(null);
  const latestIncludedNode = ref<{ nodeId: number; name?: string; timestamp: string } | null>(null);
  const latestExcludedNode = ref<{ nodeId: number; timestamp: string } | null>(null);
  const selectedPortPath = ref<string>("");
  const wsState = ref<"idle" | "connecting" | "open" | "closed">("idle");
  const errorMessage = ref("");
  const provisioningBaselineNodeIds = ref<number[]>([]);
  const provisioningSettlePollsRemaining = ref(0);
  let socket: WebSocket | null = null;
  let shouldKeepWebSocket = false;
  let socketReconnectTimer: number | null = null;
  let statusPollTimer: number | null = null;

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function showBrowserNotice(title: string, body: string): void {
    window.alert(`${title}\n\n${body}`);
  }

  function resetProvisioningFlow(): void {
    inclusionChallenge.value = null;
    provisioningMode.value = "idle";
    provisioningResult.value = "idle";
    foundIncludedNode.value = null;
    pendingIncludedNode.value = null;
    latestIncludedNode.value = null;
    latestExcludedNode.value = null;
    provisioningBaselineNodeIds.value = [];
    provisioningSettlePollsRemaining.value = 0;
  }

  function captureProvisioningBaseline(): void {
    provisioningBaselineNodeIds.value = nodes.value.map((item) => item.nodeId);
  }

  function startProvisioning(mode: "include" | "exclude"): void {
    resetProvisioningFlow();
    captureProvisioningBaseline();
    provisioningMode.value = mode;
    provisioningResult.value = "running";
    provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
  }

  function finishProvisioningSuccess(): void {
    inclusionChallenge.value = null;
    provisioningMode.value = "idle";
    provisioningResult.value = "success";
    foundIncludedNode.value = null;
    pendingIncludedNode.value = null;
    provisioningSettlePollsRemaining.value = 0;
  }

  function finishProvisioningStopped(): void {
    inclusionChallenge.value = null;
    provisioningMode.value = "idle";
    provisioningResult.value = "stopped";
    foundIncludedNode.value = null;
    pendingIncludedNode.value = null;
    provisioningSettlePollsRemaining.value = 0;
  }

  function isInterviewComplete(node: Pick<NodeSummary, "ready" | "interviewStage">): boolean {
    return Boolean(node.ready) || String(node.interviewStage ?? "").toLowerCase() === "complete";
  }

  function isWithinInclusionDiscoveryGrace(): boolean {
    if (!foundIncludedNode.value?.timestamp) {
      return false;
    }
    return Date.now() - Date.parse(foundIncludedNode.value.timestamp) < INCLUSION_DISCOVERY_GRACE_MS;
  }

  function findNewlyIncludedNode(): NodeSummary | null {
    const baselineIds = new Set(provisioningBaselineNodeIds.value);
    const addedNodes = nodes.value.filter((item) => !baselineIds.has(item.nodeId));
    if (addedNodes.length === 0) {
      return null;
    }
    return [...addedNodes].sort((left, right) => right.nodeId - left.nodeId)[0] ?? null;
  }

  function rememberPendingIncludedNode(node: Pick<NodeSummary, "nodeId" | "name" | "product">): void {
    if (pendingIncludedNode.value?.nodeId === node.nodeId) {
      return;
    }
    pendingIncludedNode.value = {
      nodeId: node.nodeId,
      name: node.name ?? node.product,
      timestamp: new Date().toISOString(),
    };
  }

  function isPendingIncludedNodeStillInitializing(): boolean {
    if (!pendingIncludedNode.value) {
      return false;
    }

    const joinedNode = nodes.value.find((item) => item.nodeId === pendingIncludedNode.value?.nodeId);
    if (!joinedNode) {
      return false;
    }

    if (isInterviewComplete(joinedNode)) {
      return false;
    }

    return Date.now() - Date.parse(pendingIncludedNode.value.timestamp) < INCLUSION_INTERVIEW_WAIT_MS;
  }

  function inferProvisioningResultFromNodes(): void {
    if (provisioningMode.value === "include") {
      const newlyIncludedNode = findNewlyIncludedNode();
      if (!pendingIncludedNode.value && newlyIncludedNode) {
        rememberPendingIncludedNode(newlyIncludedNode);
      }

      // Never treat mere node appearance as success. Secure devices may emit
      // `node added` before the S2 challenge arrives, so wait for interview/ready.
      if (inclusionChallenge.value || isWithinInclusionDiscoveryGrace()) {
        return;
      }

      if (pendingIncludedNode.value) {
        const joinedNode = nodes.value.find((item) => item.nodeId === pendingIncludedNode.value?.nodeId);
        if (joinedNode && isInterviewComplete(joinedNode)) {
          latestIncludedNode.value = {
            nodeId: joinedNode.nodeId,
            name: joinedNode.name ?? joinedNode.product ?? pendingIncludedNode.value.name,
            timestamp: new Date().toISOString(),
          };
          finishProvisioningSuccess();
        } else if (!joinedNode) {
          finishProvisioningStopped();
        }
      }
      return;
    }

    if (provisioningMode.value === "exclude") {
      const currentIds = new Set(nodes.value.map((item) => item.nodeId));
      const removedNodeId = provisioningBaselineNodeIds.value.find((nodeId) => !currentIds.has(nodeId));
      if (removedNodeId != undefined) {
        latestExcludedNode.value = {
          nodeId: removedNodeId,
          timestamp: new Date().toISOString(),
        };
        finishProvisioningSuccess();
      }
    }
  }

  function updateProvisioningSettlement(statusSnapshot: DriverStatus): void {
    if (provisioningMode.value === "idle" || provisioningResult.value !== "running") {
      return;
    }

    const isControllerStillBusy =
      statusSnapshot.isInclusionActive ||
      statusSnapshot.isExclusionActive ||
      inclusionChallenge.value != null;

    if (isControllerStillBusy) {
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      return;
    }

    if (provisioningMode.value === "include" && isPendingIncludedNodeStillInitializing()) {
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      return;
    }

    if (provisioningSettlePollsRemaining.value > 0) {
      provisioningSettlePollsRemaining.value -= 1;
      return;
    }

    finishProvisioningStopped();
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
      showBrowserNotice("初始化失败", errorMessage.value);
    }
  }

  function connectWebSocket(shouldConnect: boolean): void {
    shouldKeepWebSocket = shouldConnect;
    if (socketReconnectTimer != null) {
      window.clearTimeout(socketReconnectTimer);
      socketReconnectTimer = null;
    }

    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
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
    const currentSocket = new WebSocket(wsUrl.toString());
    socket = currentSocket;
    currentSocket.onopen = () => {
      if (socket !== currentSocket) {
        return;
      }
      wsState.value = "open";
    };
    currentSocket.onerror = () => {
      if (socket !== currentSocket) {
        return;
      }
      wsState.value = "closed";
    };
    currentSocket.onclose = (event) => {
      if (socket !== currentSocket) {
        return;
      }
      socket = null;
      wsState.value = "closed";
      if (!shouldKeepWebSocket) {
        return;
      }
      if (event.code === 1008) {
        errorMessage.value = "WebSocket 鉴权失败，请检查浏览器里的 API 令牌或重新登录。";
        return;
      }
      socketReconnectTimer = window.setTimeout(() => {
        socketReconnectTimer = null;
        connectWebSocket(true);
      }, 2000);
    };
    currentSocket.onmessage = (event) => {
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

    if (
      nextStatus.phase === "connecting" ||
      nextStatus.isInclusionActive ||
      nextStatus.isExclusionActive ||
      provisioningMode.value !== "idle" ||
      inclusionChallenge.value != null
    ) {
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
        if (provisioningMode.value === "include" || latestStatus.isInclusionActive || inclusionChallenge.value != null) {
          inclusionChallenge.value = (await apiClient.getInclusionChallenge()).challenge;
        } else if (provisioningMode.value === "idle" && !latestStatus.isExclusionActive) {
          inclusionChallenge.value = null;
        }

        if (provisioningMode.value !== "idle" || provisioningResult.value === "running") {
          await refreshNodes();
          inferProvisioningResultFromNodes();
          updateProvisioningSettlement(latestStatus);
        }
      } catch {
        // Ignore transient polling failures while the websocket remains the primary source of truth.
      }

      if (
        status.value.phase === "connecting" ||
        status.value.isInclusionActive ||
        status.value.isExclusionActive ||
        provisioningMode.value !== "idle" ||
        inclusionChallenge.value != null
      ) {
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
      inclusionChallenge.value = event.payload as InclusionChallenge;
      foundIncludedNode.value = null;
      provisioningMode.value = "include";
      provisioningResult.value = "running";
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      return;
    }

    if (event.type === "zwave.inclusion.challenge.aborted") {
      inclusionChallenge.value = null;
      return;
    }

    if (event.type === "zwave.node.found") {
      const payload = event.payload as { nodeId?: number };
      foundIncludedNode.value = {
        nodeId: payload.nodeId ?? 0,
        timestamp: event.timestamp,
      };
      provisioningMode.value = "include";
      provisioningResult.value = "running";
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      return;
    }

    if (event.type === "zwave.inclusion.stopped") {
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      void refreshNodes().catch(() => {
        // Ignore transient sync issues and let the regular polling loop continue.
      });
      return;
    }

    if (event.type === "zwave.exclusion.stopped") {
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      void refreshNodes()
        .then(() => {
          inferProvisioningResultFromNodes();
        })
        .catch(() => {
          // Ignore transient sync issues and let the regular polling loop continue.
        });
      return;
    }

    if (event.type === "zwave.node.added") {
      const payload = event.payload as { node?: NodeDetail };
      pendingIncludedNode.value = {
        nodeId: payload.node?.nodeId ?? 0,
        name: payload.node?.name ?? payload.node?.product,
        timestamp: event.timestamp,
      };
      provisioningMode.value = "include";
      provisioningResult.value = "running";
      provisioningSettlePollsRemaining.value = PROVISIONING_SETTLE_POLLS;
      void refreshNodes();
      return;
    }

    if (event.type === "zwave.node.ready") {
      const payload = event.payload as NodeDetail;
      if (!pendingIncludedNode.value || pendingIncludedNode.value.nodeId === payload.nodeId) {
        latestIncludedNode.value = {
          nodeId: payload.nodeId,
          name: payload.name ?? payload.product,
          timestamp: event.timestamp,
        };
        finishProvisioningSuccess();
      }
      void refreshNodes();
      return;
    }

    if (event.type === "zwave.node.removed") {
      const payload = event.payload as { nodeId?: number };
      latestExcludedNode.value = {
        nodeId: payload.nodeId ?? 0,
        timestamp: event.timestamp,
      };
      finishProvisioningSuccess();
      void refreshNodes();
      return;
    }

    if (event.type === "zwave.node.updated") {
      const payload = event.payload as NodeDetail;
      if (
        pendingIncludedNode.value &&
        payload.nodeId === pendingIncludedNode.value.nodeId &&
        isInterviewComplete(payload)
      ) {
        latestIncludedNode.value = {
          nodeId: payload.nodeId,
          name: payload.name ?? payload.product ?? pendingIncludedNode.value.name,
          timestamp: event.timestamp,
        };
        finishProvisioningSuccess();
      }
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
      try {
        selectedNode.value = await apiClient.getNode(selectedNode.value.nodeId);
      } catch {
        selectedNode.value = null;
      }
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
    startProvisioning("include");
    await runAction("启动入网失败", async () => {
      try {
        await apiClient.startInclusion();
      } catch (error) {
        const message = getErrorMessage(error);
        const latestStatus = await apiClient.getStatus();
        applyStatus(latestStatus);
        if (message.includes("already active") && latestStatus.isInclusionActive) {
          return;
        }
        throw error;
      }

      applyStatus(await apiClient.getStatus());
    });
  }

  async function stopInclusion(): Promise<void> {
    await runAction("停止入网失败", async () => {
      await apiClient.stopInclusion();
      applyStatus(await apiClient.getStatus());
      provisioningMode.value = "idle";
      inclusionChallenge.value = null;
    });
  }

  async function startExclusion(): Promise<void> {
    startProvisioning("exclude");
    await runAction("启动排除失败", async () => {
      try {
        await apiClient.startExclusion();
      } catch (error) {
        const message = getErrorMessage(error);
        const latestStatus = await apiClient.getStatus();
        applyStatus(latestStatus);
        if (message.includes("already active") && latestStatus.isExclusionActive) {
          return;
        }
        throw error;
      }

      applyStatus(await apiClient.getStatus());
    });
  }

  async function stopExclusion(): Promise<void> {
    await runAction("停止排除失败", async () => {
      await apiClient.stopExclusion();
      applyStatus(await apiClient.getStatus());
      provisioningMode.value = "idle";
      inclusionChallenge.value = null;
    });
  }

  async function resetController(): Promise<void> {
    await runAction("Reset 控制器失败", async () => {
      resetProvisioningFlow();
      const latestStatus = await apiClient.resetController();
      nodes.value = [];
      selectedNode.value = null;
      applyStatus(latestStatus);
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
    await runAction("启动测试失败", async () => {
      const run = await apiClient.createRun(payload);
      await refreshRuns();
      await loadRunLogs(run.id);
    });
  }

  async function cancelRun(runId: string): Promise<void> {
    await runAction("取消测试失败", async () => {
      await apiClient.cancelRun(runId);
      await refreshRuns();
      await loadRunLogs(runId);
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
      showBrowserNotice(title, errorMessage.value);
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
    inclusionChallenge,
    foundIncludedNode,
    pendingIncludedNode,
    latestIncludedNode,
    latestExcludedNode,
    provisioningMode,
    provisioningResult,
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
    resetController,
    submitGrantSecurity,
    submitValidateDsk,
    resetProvisioningFlow,
    runTest,
    cancelRun,
    pingNode,
    healNode,
  };
});
