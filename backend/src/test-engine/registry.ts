import type { ExecutableTestDefinition } from "./types.js";
import { binarySwitchDefinition } from "./definitions/binary-switch.js";
import { lockBasicDefinition } from "./definitions/lock-basic.js";
import { nodeHealthDefinition } from "./definitions/node-health.js";
import { userCodeAddDefinition, userCodeDeleteDefinition, userCodeEditDefinition } from "./definitions/user-code.js";

export const executableDefinitions: ExecutableTestDefinition[] = [
  lockBasicDefinition,
  userCodeAddDefinition,
  userCodeEditDefinition,
  userCodeDeleteDefinition,
  binarySwitchDefinition,
  nodeHealthDefinition,
];
