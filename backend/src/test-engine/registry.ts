import type { ExecutableTestDefinition } from "./types.js";
import { binarySwitchDefinition } from "./definitions/binary-switch.js";
import { configurationReadWriteDefinition } from "./definitions/configuration-read-write.js";
import { doorLockNotificationDefinition } from "./definitions/door-lock-notification.js";
import { lockBasicDefinition } from "./definitions/lock-basic.js";
import { nodeHealthDefinition } from "./definitions/node-health.js";
import { userCodeAddDefinition, userCodeDeleteDefinition, userCodeEditDefinition } from "./definitions/user-code.js";
import {
  userCredentialAdminPinDefinition,
  userCredentialAssociationDefinition,
  userCredentialCapabilitiesDefinition,
  userCredentialChecksumDefinition,
  userCredentialFingerprintLifecycleDefinition,
  userCredentialIterationDefinition,
  userCredentialNegativeDefinition,
  userCredentialPasswordLifecycleDefinition,
  userCredentialPinLifecycleDefinition,
  userCredentialUserTypeDefinition,
} from "./definitions/user-credential.js";

export const executableDefinitions: ExecutableTestDefinition[] = [
  lockBasicDefinition,
  doorLockNotificationDefinition,
  userCodeAddDefinition,
  userCodeEditDefinition,
  userCodeDeleteDefinition,
  userCredentialCapabilitiesDefinition,
  userCredentialPinLifecycleDefinition,
  userCredentialPasswordLifecycleDefinition,
  userCredentialFingerprintLifecycleDefinition,
  userCredentialChecksumDefinition,
  userCredentialAdminPinDefinition,
  userCredentialNegativeDefinition,
  userCredentialIterationDefinition,
  userCredentialUserTypeDefinition,
  userCredentialAssociationDefinition,
  configurationReadWriteDefinition,
  binarySwitchDefinition,
  nodeHealthDefinition,
];
