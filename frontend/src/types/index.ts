export interface SerialPortInfo {
  path: string;
  stablePath?: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  isCandidateController: boolean;
}

export interface DriverStatus {
  phase: "idle" | "connecting" | "ready" | "disconnecting" | "error";
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

export type InclusionChallenge =
  | {
      requestId: string;
      challengeType: "grant_security_classes";
      requested: Array<"S2_AccessControl" | "S2_Authenticated" | "S2_Unauthenticated" | "S0_Legacy">;
      clientSideAuth: boolean;
    }
  | {
      requestId: string;
      challengeType: "validate_dsk";
      dsk: string;
    };

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
}

export interface EndpointSnapshot {
  index: number;
  label?: string;
  commandClasses: string[];
}

export interface NodeSummary {
  nodeId: number;
  name?: string;
  deviceType?: string;
  manufacturer?: string;
  product?: string;
  productCode?: string;
  firmwareVersion?: string;
  status?: string;
  interviewStage?: string;
  ready?: boolean;
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

export interface ContactConfigRow {
  parameter: number;
  label: string;
  display: string;
  raw: string;
  range: string;
}

export interface FirmwareUpdateCapabilities {
  firmwareUpgradable: boolean;
  firmwareTargets: number[];
  continuesToFunction?: boolean;
  supportsActivation?: boolean;
  supportsResuming?: boolean;
  supportsNonSecureTransfer?: boolean;
}

export interface FirmwareFileInspection {
  sourceFilename: string;
  firmwareFilename: string;
  format: string;
  fileSize: number;
  detectedTarget?: number;
}

export interface FirmwareUpdateProgress {
  currentFile?: number;
  totalFiles?: number;
  sentFragments: number;
  totalFragments: number;
  progress: number;
}

export type FirmwareUpdatePhase =
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

export interface FirmwareUpdateResultSummary {
  success: boolean;
  status: number;
  waitTime?: number;
  reInterview?: boolean;
}

export interface FirmwareUpdateStatus {
  nodeId: number;
  phase: FirmwareUpdatePhase;
  sourceFilename: string;
  firmwareFilename: string;
  format: string;
  target: number;
  detectedTarget?: number;
  fileSize: number;
  options: {
    resume: boolean;
    nonSecureTransfer: boolean;
  };
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  progress?: FirmwareUpdateProgress;
  result?: FirmwareUpdateResultSummary;
  error?: string;
  message?: string;
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

export interface TestRunRecord {
  id: string;
  testDefinitionId: string;
  nodeId: number;
  status: string;
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

export interface AppEvent<T = unknown> {
  type: string;
  timestamp: string;
  payload: T;
}
