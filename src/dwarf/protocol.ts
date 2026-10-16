/**
 * Command/notification registry for the DWARF V3 WebSocket protocol.
 *
 * Built on @alikh/dwarflab-sdk: its generated protobuf namespace, packet codec, command enum and
 * per-command codec table. The modules under protocol/ add the commands the SDK does not register
 * (motor run-to/reset/position, master lock, extra astro commands), message variants observed on V3
 * firmware (goto_only etc.), and decoders for every notify command the firmware emits.
 */
export { type ProtoType, protoTypeByName } from './protocol/types.js';
export { Cmd, requestType, responseType } from './protocol/commands.js';
export { toPlain, decodeWith, rawDecode } from './protocol/decode.js';
export { NOTIFY, decodeNotification } from './protocol/notify.js';
export { errorText } from './protocol/errors.js';
export { SOLAR_SYSTEM_INDEX, OPERATION_STATE, ASTRO_STATE } from './protocol/enums.js';
