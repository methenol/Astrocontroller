/**
 * Command ids and their request/response codecs: the SDK's table, the commands it does not register,
 * the ones whose V3 messages differ from the SDK's, and — for everything the SDK never declared —
 * the command catalogue recovered from the APK.
 */
import { Command, getRequestType, getResponseType } from '@alikh/dwarflab-sdk';
import { payloadRefFor } from '../wire/index.js';
import { apkProtoType, protoTypeByName as T, type ProtoType } from './types.js';

/**
 * Commands the SDK's enum does not name, plus ids it gets wrong.
 *
 * Checked against the APK's own table (`com.convergence.dwarflab.data.bean.ws.WsCmd`: each constant
 * loads its id as a `const/16` immediate), reproduced in `src/dwarf/wire/generated/`.
 */
const EXTRA_CMDS = {
  // Neither id exists in this build: `0x36a1`/`0x36a3` appear nowhere in WsCmd, and `WsCmd` has no
  // RUN_TO/RESET constant. The payloads they carry (`motor.ReqMotorRunTo`, `motor.ReqMotorReset`) are
  // genuine shipped descriptors, so these ids belong to a firmware whose WsCmd still assigned them.
  // Treat both as unverified against the current device; `motors.ts` sends the reset best-effort,
  // which is why the missing reply never surfaces.
  STEP_MOTOR_RUN_TO: 14001,
  STEP_MOTOR_RESET: 14003,
  STEP_MOTOR_GET_POSITION: 14011, // CMD_STEP_MOTOR_GET_POSITION
  // The SDK puts this at 16406, which this build assigns to GLOBAL_VOICE_ASSISTANT_TASK (module
  // TASK_CENTER). The real VOICE_ASSISTANT module command is 16800.
  VOICE_ASSISTANT_TASK: 16800,
} as const;

/** The SDK's `VOICE_ASSISTANT_TASK` is dropped from the table so only the corrected id survives. */
const table: Record<string, unknown> = Object.assign({}, Command, EXTRA_CMDS);
delete table['16406'];

export const Cmd: Omit<typeof Command, 'VOICE_ASSISTANT_TASK'> & typeof EXTRA_CMDS = Object.freeze(table) as typeof Command & typeof EXTRA_CMDS;

interface Codec {
  req?: ProtoType;
  res?: ProtoType;
}

const OK = T('base.ComResponse');
const EMPTY = T('extra.Empty');

const OVERRIDES = new Map<number, Codec>([
  // The state read the controller polls. The SDK's generated class for it stops at its own .proto and
  // silently drops lensDefog, autoCooling, autoShutdown, antiTangle, powerSound, shootingDoNotDisturb
  // and the wide/guide focus encoders (one payload decoded both ways to confirm). The APK's descriptor
  // is that same schema with the missing fields present; every field the app already reads decodes
  // identically, so this is a superset, not a change of shape.
  [Cmd.TASK_GET_DEVICE_STATE_INFO, { res: apkProtoType('task_center.ResGetDeviceStateInfo') }],
  // motor
  [Cmd.STEP_MOTOR_RUN_TO, { req: T('motor.ReqMotorRunTo'), res: T('motor.ResMotor') }],
  [Cmd.STEP_MOTOR_STOP, { req: T('motor.ReqMotorStop'), res: T('motor.ResMotor') }],
  [Cmd.STEP_MOTOR_RESET, { req: T('motor.ReqMotorReset'), res: T('motor.ResMotor') }],
  [Cmd.STEP_MOTOR_GET_POSITION, { req: T('motor.ReqMotorGetPosition'), res: T('motor.ResMotorPosition') }],
  [Cmd.STEP_MOTOR_SERVICE_JOYSTICK_STOP, { req: T('motor.ReqMotorServiceJoystickStop'), res: OK }],
  // system / power
  [Cmd.SYSTEM_SET_MASTER, { req: T('system.ReqsetMasterLock'), res: OK }],
  [Cmd.RGB_POWER_POWERIND_ON, { req: T('rgb.ReqOpenPowerInd'), res: OK }],
  [Cmd.RGB_POWER_POWERIND_OFF, { req: T('rgb.ReqClosePowerInd'), res: OK }],
  // astro
  [Cmd.ASTRO_START_GOTO_DSO, { req: T('extra.ReqGotoDSO'), res: OK }],
  [Cmd.ASTRO_START_TRACK_SPECIAL_TARGET, { req: T('astro.ReqTrackSpecialTarget'), res: OK }],
  [Cmd.ASTRO_STOP_TRACK_SPECIAL_TARGET, { req: T('astro.ReqStopTrackSpecialTarget'), res: OK }],
  [Cmd.ASTRO_START_ONE_CLICK_GOTO_DSO, { req: T('extra.ReqOneClickGotoDSO'), res: T('astro.ResOneClickGoto') }],
  [Cmd.ASTRO_START_ONE_CLICK_GOTO_SOLAR_SYSTEM, { req: T('astro.ReqOneClickGotoSolarSystem'), res: T('astro.ResOneClickGotoSolarSystem') }],
  [Cmd.ASTRO_START_EQ_SOLVING, { req: T('extra.ReqStartEqSolving'), res: T('astro.ResStartEqSolving') }],
  [Cmd.ASTRO_STOP_MAKE_FITS_THUMB, { req: EMPTY, res: OK }],
  [Cmd.ASTRO_STOP_RESTACKED, { req: EMPTY, res: OK }],
  [Cmd.ASTRO_WIDE_GO_LIVE, { req: EMPTY, res: OK }],
  [Cmd.ASTRO_FAST_STOP_CAPTURE_RAW_LIVE_STACKING, { req: T('astro.ReqFastStopCaptureRawLiveStacking'), res: OK }],
  [Cmd.ASTRO_FAST_STOP_WIDE_CAPTURE_LIVE_STACKING, { req: T('astro.ReqFastStopCaptureWideRawLiveStacking'), res: OK }],
  [Cmd.ASTRO_GET_ASTRO_SHOOTING_TIME, { req: T('astro.ReqGetAstroShootingTime'), res: T('astro.ResGetAstroShootingTime') }],
  [Cmd.ASTRO_GET_CALI_FRAME_LIST, { req: T('astro.ReqGetCaliFrameList'), res: T('astro.ResGetCaliFrameList') }],
  [Cmd.ASTRO_DEL_CALI_FRAME_LIST, { req: T('astro.ReqDelCaliFrameList'), res: OK }],
  [Cmd.ASTRO_START_CAPTURE_CALI_FRAME, { req: T('astro.ReqCaptureCaliFrame'), res: OK }],
  [Cmd.ASTRO_STOP_CAPTURE_CALI_FRAME, { req: T('astro.ReqStopCaptureCaliFrame'), res: OK }],
  // live preview quality (part of the app's camera wake-up sequence)
  [Cmd.CAMERA_TELE_SET_PREVIEW_QUALITY, { req: T('camera.ReqSetPreviewQuality'), res: OK }],
  [Cmd.CAMERA_WIDE_SET_PREVIEW_QUALITY, { req: T('camera.ReqSetPreviewQuality'), res: OK }],
  // focus
  [Cmd.FOCUS_GET_USER_INFINITY_POS, { req: T('focus.ReqGetUserInfinityPos'), res: T('focus.ResUserInfinityPos') }],
  [Cmd.FOCUS_SET_USER_INFINITY_POS, { req: T('focus.ReqSetUserInfinityPos'), res: OK }],
  // params
  [Cmd.PARAM_SET_GENERAL_FLOAT_PARAM, { req: T('param.ReqSetGeneralFloatParam'), res: OK }],
  [Cmd.PARAM_SET_GENERAL_BOOL_PARAM, { req: T('param.ReqSetGeneralBoolParams'), res: OK }],
  [Cmd.PARAM_SET_AUTO_PARAMS, { req: T('param.ReqSetAutoParam'), res: T('param.ResSetAutoParam') }],
  // tracking extras
  [Cmd.MOT_TRACK_ONE, { req: T('track.ReqMOTTrackOne'), res: OK }],
  [Cmd.MOT_WIDE_TRACK_ONE, { req: T('track.ReqMOTTrackOne'), res: OK }],
  [Cmd.UFO_HAND_AUTO_MODE, { req: T('track.ReqUFOAutoHandMode'), res: OK }],
]);

/**
 * The request schema for a command: the app's V3 override, then the SDK's codec table, then the APK's
 * own catalogue — which is how the commands the SDK never registered get a real payload. A descriptor
 * that will not load is allowed to throw here: sending a set-command with a silently empty payload is
 * worse than refusing to send it.
 */
export function requestType(cmd: number): ProtoType | undefined {
  return OVERRIDES.get(cmd)?.req ?? (getRequestType(cmd as Command) as ProtoType | undefined) ?? recoveredCodec(cmd, 'request');
}

/**
 * The response schema for a command, same precedence. Decoding stays tolerant: an unloadable descriptor
 * yields undefined and the frame is surfaced undecoded instead of breaking the socket.
 */
export function responseType(cmd: number): ProtoType | undefined {
  return OVERRIDES.get(cmd)?.res ?? (getResponseType(cmd as Command) as ProtoType | undefined) ?? recoveredCodec(cmd, 'response', false);
}

function recoveredCodec(cmd: number, direction: 'request' | 'response', strict = true): ProtoType | undefined {
  const ref = payloadRefFor(cmd, direction);
  if (!ref) return undefined;
  try {
  return T(ref);
  } catch {
  if (strict) throw new Error(`protocol: command ${cmd} declares ${ref}, but the recovered descriptor will not load`);
  return undefined;
  }
}
