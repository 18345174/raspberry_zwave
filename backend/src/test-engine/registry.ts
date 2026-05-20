import type { ExecutableTestDefinition } from "./types.js";
import { binarySwitchDefinition } from "./definitions/binary-switch.js";
import { configurationReadWriteDefinition } from "./definitions/configuration-read-write.js";
import { doorLockNotificationDefinition } from "./definitions/door-lock-notification.js";
import { lockBasicDefinition } from "./definitions/lock-basic.js";
import { nodeHealthDefinition } from "./definitions/node-health.js";
import { userCodeAddDefinition, userCodeDeleteDefinition, userCodeEditDefinition } from "./definitions/user-code.js";
import {
  userCredentialCapabilitiesDefinition,
  userCredentialFingerprintLifecycleDefinition,
  userCredentialPinLifecycleDefinition,
} from "./definitions/user-credential.js";

export const executableDefinitions: ExecutableTestDefinition[] = [
  lockBasicDefinition,
  doorLockNotificationDefinition,
  userCodeAddDefinition,
  userCodeEditDefinition,
  userCodeDeleteDefinition,
  userCredentialCapabilitiesDefinition,
  userCredentialPinLifecycleDefinition,
  userCredentialFingerprintLifecycleDefinition,
  configurationReadWriteDefinition,
  binarySwitchDefinition,
  nodeHealthDefinition,
];
