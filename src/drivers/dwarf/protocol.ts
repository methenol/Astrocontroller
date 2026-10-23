/**
 * Command/notification registry for the DWARF V3 WebSocket protocol.
 *
 * Command ids, payload schemas and packet framing are owned by src/drivers/dwarf/wire/, reconstructed from the
 * APK. The @alikh/dwarflab-sdk namespace still supplies the codecs it demonstrably has right; the
 * modules under protocol/ add the commands the SDK does not register (motor run-to/reset/position,
 * master lock, extra astro commands), message variants observed on V3 firmware (goto_only etc.), the
 * APK's own descriptor where the SDK's schema is stale, and decoders for every notify command the
 * firmware emits.
 */
export { type ProtoType, protoTypeByName, apkProtoType } from './protocol/types.js';
export { Cmd, requestType, responseType } from './protocol/commands.js';
export { toPlain, decodeWith, rawDecode } from './protocol/decode.js';
export { NOTIFY, decodeNotification } from './protocol/notify.js';
export { errorText } from './protocol/errors.js';
export { SOLAR_SYSTEM_INDEX, OPERATION_STATE, ASTRO_STATE } from './protocol/enums.js';
