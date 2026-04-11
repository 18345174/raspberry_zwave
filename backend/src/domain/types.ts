export interface SerialPortInfo {
  path: string;
  stablePath?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  isCandidateController: boolean;
}

export type DriverPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "disconnecting"
  | "error";

export interface DriverStatus {
  phase: DriverPhase;
  selectedPortPath?: string;
  connectedPortPath?: string;
  controllerId?: number;
  homeId?: string;
  isInclusionActive: boolean;
  isExclusionActive: boolean;
  hasReadyDriver: boolean;
  updatedAt: string;
  lastError?: string;
}

export type SecurityClassName =
  | "S2_AccessControl"
  | "S2_Authenticated"
  | "S2_Unauthenticated"
  | "S0_Legacy";

export interface SecurityGrantInput {
  grant: SecurityClassName[];
  clientSideAuth: boolean;
}

export type InclusionChallenge =
  | {
      requestId: string;
      challengeType: "grant_security_classes";
      requested: SecurityClassName[];
      clientSideAuth: boolean;
    }
  | {
      requestId: string;
      challengeType: "validate_dsk";
      dsk: string;
    };

export interface ValueIdInput {
  commandClass: string | number;
  endpoint?: number;
  property: string | number;
  propertyKey?: string | number;
}

export interface SetValueInput {
  nodeId: number;
  valueId: ValueIdInput;
  value: unknown;
}

export interface InvokeCcApiInput {
  nodeId: number;
  endpoint?: number;
  commandClass: string | number;
  method: string;
  args?: unknown[];
}

export interface NodeValueSnapshot {
  nodeId: number;
  endpoint: number;
  commandClass: string;
  property: string;
  propertyKey?: string;
  value: unknown;
  unit?: string;
  label?: string;
  lastUpdatedAt?: string;
  valueId: ValueIdInput;
}

export interface EndpointSnapshot {
  index: number;
  label?: string;
  commandClasses: string[];
}

export interface NodeSummary {
  nodeId: number;
  name?: string;
  manufacturer?: string;
  product?: string;
  productCode?: string;
  firmwareVersion?: string;
  status?: string;
  interviewStage?: string;
  securityClasses: string[];
  isSecure: boolean;
  isListening: boolean;
  lastSeenAt?: string;
  commandClasses: string[];
}

export interface NodeDetail extends NodeSummary {
  endpoints: EndpointSnapshot[];
  values: NodeValueSnapshot[];
}

export interface ZwaveEvent<T = unknown> {
  type: string;
  timestamp: string;
  payload: T;
}

export interface SystemHealth {
  ok: boolean;
  uptimeSec: number;
  version: string;
  driverStatus: DriverStatus;
  activeWebSocketClients: number;
  activeTestRunId?: string;
}

export interface AuthSessionView {
  isAuthenticationEnabled: boolean;
  supportsPasswordLogin: boolean;
  isAuthenticated: boolean;
  username?: string;
  expiresAt?: string;
}

export interface TestDefinition {
  id: string;
  key: string;
  name: string;
  deviceType: string;
  version: number;
  enabled: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type TestRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export interface TestRunRecord {
  id: string;
  testDefinitionId: string;
  nodeId: number;
  status: TestRunStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summaryJson?: Record<string, unknown>;
  resultJson?: Record<string, unknown>;
}

export interface TestLogRecord {
  id: string;
  testRunId: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  stepKey: string;
  message: string;
  payloadJson?: Record<string, unknown>;
}

export interface CreateTestRunInput {
  testDefinitionId: string;
  nodeId: number;
  inputs: Record<string, unknown>;
}
