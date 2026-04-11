import type { NodeDetail, NodeSummary, ZwaveEvent } from "../domain/types.js";
import { DatabaseService } from "../storage/database.js";
import type { IZwaveAdapter } from "../adapters/zwave/interfaces.js";

export class NodeRegistryService {
  public constructor(
    private readonly storage: DatabaseService,
    private readonly zwaveAdapter: IZwaveAdapter,
  ) {}

  public async syncAll(): Promise<void> {
    const summaries = await this.zwaveAdapter.listNodes();
    const liveNodeIds = new Set(summaries.map((item) => item.nodeId));

    for (const stored of this.storage.listNodeSnapshots()) {
      if (!liveNodeIds.has(stored.nodeId)) {
        this.storage.removeNodeSnapshot(stored.nodeId);
      }
    }

    for (const summary of summaries) {
      const detail = await this.zwaveAdapter.getNode(summary.nodeId);
      this.storage.upsertNodeSnapshot(detail);
    }
  }

  public async listNodes(): Promise<NodeSummary[]> {
    const snapshots = this.storage.listNodeSnapshots();
    return snapshots.map(({ endpoints, values, ...summary }) => {
      void endpoints;
      void values;
      return summary;
    });
  }

  public async getNode(nodeId: number): Promise<NodeDetail | undefined> {
    return this.storage.getNodeSnapshot(nodeId);
  }

  public async refreshNode(nodeId: number): Promise<NodeDetail> {
    const node = await this.zwaveAdapter.refreshNode(nodeId);
    this.storage.upsertNodeSnapshot(node);
    return node;
  }

  public async handleEvent(event: ZwaveEvent): Promise<void> {
    if (event.type === "zwave.node.added" || event.type === "zwave.node.updated") {
      const payload = event.payload as { node?: NodeDetail } | NodeDetail;
      const node = this.extractNodeDetail(payload);
      if (node) {
        this.storage.upsertNodeSnapshot(node);
      }
      return;
    }

    if (event.type === "zwave.node.removed") {
      const payload = event.payload as { nodeId: number };
      this.storage.removeNodeSnapshot(payload.nodeId);
      return;
    }

    if (event.type === "zwave.value.updated") {
      const payload = event.payload as { nodeId?: number };
      if (payload.nodeId != undefined) {
        try {
          const refreshed = await this.zwaveAdapter.getNode(payload.nodeId);
          this.storage.upsertNodeSnapshot(refreshed);
        } catch {
          // Ignore transient value refresh issues and keep the last snapshot.
        }
      }
    }
  }

  private extractNodeDetail(payload: { node?: NodeDetail } | NodeDetail): NodeDetail | undefined {
    if ("nodeId" in payload) {
      return payload;
    }
    return payload.node;
  }
}
