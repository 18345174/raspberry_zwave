import type { ExecutableTestDefinition } from "./types.js";
import { binarySwitchDefinition } from "./definitions/binary-switch.js";
import { basicDoorLockMappingDefinition, basicDoorLockVersionDefinition, basicGetReportDefinition, basicReportValueDefinition, basicSetSecuredMappingDefinition, basicSetUnsecuredMappingDefinition, basicV2TargetDurationDefinition } from "./definitions/basic.js";
import { scheduleEntryLockCapabilitiesDefinition, scheduleEntryLockDailyRepeatingReadDefinition, scheduleEntryLockDailyRepeatingLifecycleDefinition, scheduleEntryLockEmptySlotReportDefinition, scheduleEntryLockEnableAllDefinition, scheduleEntryLockEnableDefinition, scheduleEntryLockDefinition, scheduleEntryLockManualAuthDefinition, scheduleEntryLockSlotBoundaryDefinition, scheduleEntryLockTimeDependencyDefinition, scheduleEntryLockTimeOffsetDefinition, scheduleEntryLockTimezoneRoundTripDefinition, scheduleEntryLockTypeSwitchDefinition, scheduleEntryLockWeekDayReadDefinition, scheduleEntryLockWeekDayLifecycleDefinition, scheduleEntryLockYearDayReadDefinition, scheduleEntryLockYearDayLifecycleDefinition } from "./definitions/schedule-entry-lock.js";
import { transportServiceDefinition } from "./definitions/transport-service.js";
import { associationGroupInfoDefinition } from "./definitions/association-group-info.js";
import { deviceResetLocallyDefinition } from "./definitions/device-reset-locally.js";
import { zwavePlusInfoDefinition } from "./definitions/zwave-plus-info.js";
import { supervisionDefinition } from "./definitions/supervision.js";
import { manufacturerSpecificDefinition } from "./definitions/manufacturer-specific.js";
import { powerlevelDefinition } from "./definitions/powerlevel.js";
import { firmwareMetadataDefinition } from "./definitions/firmware-update-metadata.js";
import { batteryHealthDefinition } from "./definitions/battery.js";
import { associationDefinition } from "./definitions/association.js";
import { versionInfoDefinition } from "./definitions/version.js";
import { indicatorDefinition } from "./definitions/indicator.js";
import { timeDefinition } from "./definitions/time.js";
import { timeParametersDefinition } from "./definitions/time-parameters.js";
import { multiChannelAssociationDefinition } from "./definitions/multi-channel-association.js";
import { securitySchemeDefinition } from "./definitions/security.js";
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
  basicDoorLockVersionDefinition,
  basicGetReportDefinition,
  basicReportValueDefinition,
  basicDoorLockMappingDefinition,
  basicSetSecuredMappingDefinition,
  basicSetUnsecuredMappingDefinition,
  basicV2TargetDurationDefinition,
  scheduleEntryLockCapabilitiesDefinition,
  scheduleEntryLockTimeOffsetDefinition,
  scheduleEntryLockTimeDependencyDefinition,
  scheduleEntryLockTimezoneRoundTripDefinition,
  scheduleEntryLockWeekDayReadDefinition,
  scheduleEntryLockYearDayReadDefinition,
  scheduleEntryLockDailyRepeatingReadDefinition,
  scheduleEntryLockWeekDayLifecycleDefinition,
  scheduleEntryLockYearDayLifecycleDefinition,
  scheduleEntryLockDailyRepeatingLifecycleDefinition,
  scheduleEntryLockEmptySlotReportDefinition,
  scheduleEntryLockSlotBoundaryDefinition,
  scheduleEntryLockEnableDefinition,
  scheduleEntryLockEnableAllDefinition,
  scheduleEntryLockTypeSwitchDefinition,
  scheduleEntryLockManualAuthDefinition,
  scheduleEntryLockDefinition,
  transportServiceDefinition,
  associationGroupInfoDefinition,
  deviceResetLocallyDefinition,
  zwavePlusInfoDefinition,
  lockBasicDefinition,
  doorLockNotificationDefinition,
  supervisionDefinition,
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
  manufacturerSpecificDefinition,
  powerlevelDefinition,
  firmwareMetadataDefinition,
  batteryHealthDefinition,
  associationDefinition,
  versionInfoDefinition,
  indicatorDefinition,
  timeDefinition,
  timeParametersDefinition,
  multiChannelAssociationDefinition,
  securitySchemeDefinition,
  configurationReadWriteDefinition,
  binarySwitchDefinition,
  nodeHealthDefinition,
];
