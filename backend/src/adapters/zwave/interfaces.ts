import type {
  DriverStatus,
  InvokeCcApiInput,
  NodeDetail,
  NodeSummary,
  SecurityGrantInput,
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
  startInclusion(): Promise<void>;
  stopInclusion(): Promise<void>;
  startExclusion(): Promise<void>;
  stopExclusion(): Promise<void>;
  grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void>;
  validateDsk(requestId: string, pin: string): Promise<void>;
  listNodes(): Promise<NodeSummary[]>;
  getNode(nodeId: number): Promise<NodeDetail>;
  refreshNode(nodeId: number): Promise<NodeDetail>;
  pingNode(nodeId: number): Promise<boolean>;
  healNode(nodeId: number): Promise<unknown>;
  setValue(input: SetValueInput): Promise<void>;
  invokeCcApi(input: InvokeCcApiInput): Promise<unknown>;
  onEvent(listener: (event: ZwaveEvent) => void): () => void;
}
