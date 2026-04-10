import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { SerialPortInfo } from "../domain/types.js";

const DEVICE_PATHS = ["/dev/serial/by-id", "/dev"] as const;
const CANDIDATE_KEYWORDS = ["zwave", "z-stick", "aeotec", "zooz", "silicon", "800", "700"];

export class SerialDiscoveryService {
  public async scanPorts(): Promise<SerialPortInfo[]> {
    const byIdEntries = await this.scanByIdDirectory();
    const ttyEntries = await this.scanTtyDirectory();

    const map = new Map<string, SerialPortInfo>();

    for (const item of [...ttyEntries, ...byIdEntries]) {
      const key = item.path;
      const current = map.get(key);
      map.set(key, {
        ...current,
        ...item,
        stablePath: item.stablePath ?? current?.stablePath,
        isCandidateController: item.isCandidateController || current?.isCandidateController || false,
      });
    }

    return Array.from(map.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async scanByIdDirectory(): Promise<SerialPortInfo[]> {
    try {
      const entries = await readdir(DEVICE_PATHS[0]);
      const results = await Promise.all(
        entries.map(async (entry) => {
          const stablePath = path.join(DEVICE_PATHS[0], entry);
          const resolved = await realpath(stablePath);
          const ids = /usb-([0-9a-fA-F]{4})_([0-9a-fA-F]{4})/.exec(entry);
          const serialNumber = /_([A-Za-z0-9]+)-if/.exec(entry)?.[1];
          const lowercase = entry.toLowerCase();
          return {
            path: resolved,
            stablePath,
            vendorId: ids?.[1],
            productId: ids?.[2],
            serialNumber,
            isCandidateController: CANDIDATE_KEYWORDS.some((keyword) => lowercase.includes(keyword)),
          } satisfies SerialPortInfo;
        }),
      );
      return results;
    } catch {
      return [];
    }
  }

  private async scanTtyDirectory(): Promise<SerialPortInfo[]> {
    try {
      const entries = await readdir(DEVICE_PATHS[1]);
      return entries
        .filter((entry) => entry.startsWith("ttyACM") || entry.startsWith("ttyUSB"))
        .map((entry) => ({
          path: path.join(DEVICE_PATHS[1], entry),
          isCandidateController: true,
        } satisfies SerialPortInfo));
    } catch {
      return [];
    }
  }
}
