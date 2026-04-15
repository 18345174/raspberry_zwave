import type {
  ContactConfigRow,
  DriverStatus,
  FirmwareFileInspection,
  FirmwareUpdateCapabilities,
  FirmwareUpdateStatus,
  InclusionChallenge,
  InvokeCcApiInput,
  NodeDetail,
  NodeSummary,
  SecurityGrantInput,
  StartFirmwareUpdateInput,
  SerialPortInfo,
  SetValueInput,
  ZwaveEvent,
} from "../../domain/types.js";

export interface IZwaveAdapter {
  scanPorts(): Promise<SerialPortInfo[]>;
  connect(portPath: string): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(portPath: string): Promise<void>;
  getStatus(): Promise<DriverStatus>;
  getInclusionChallenge(): Promise<InclusionChallenge | null>;
  startInclusion(): Promise<void>;
  stopInclusion(): Promise<void>;
  startExclusion(): Promise<void>;
  stopExclusion(): Promise<void>;
  hardResetController(): Promise<void>;
  grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void>;
  validateDsk(requestId: string, pin: string): Promise<void>;
  listNodes(): Promise<NodeSummary[]>;
  getNode(nodeId: number): Promise<NodeDetail>;
  refreshNode(nodeId: number): Promise<NodeDetail>;
  readSupportedCommandClasses(nodeId: number): Promise<NodeDetail>;
  getContactConfig(nodeId: number): Promise<ContactConfigRow[]>;
  getFirmwareUpdateCapabilities(nodeId: number): Promise<FirmwareUpdateCapabilities>;
  inspectFirmwareFile(nodeId: number, filename: string, contentBase64: string): Promise<FirmwareFileInspection>;
  getFirmwareUpdateStatus(nodeId: number): Promise<FirmwareUpdateStatus | null>;
  startFirmwareUpdate(input: StartFirmwareUpdateInput): Promise<FirmwareUpdateStatus>;
  abortFirmwareUpdate(nodeId: number): Promise<void>;
  pingNode(nodeId: number): Promise<boolean>;
  healNode(nodeId: number): Promise<unknown>;
  setValue(input: SetValueInput): Promise<void>;
  invokeCcApi(input: InvokeCcApiInput): Promise<unknown>;
  onEvent(listener: (event: ZwaveEvent) => void): () => void;
}
