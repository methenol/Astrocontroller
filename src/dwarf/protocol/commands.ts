/**
 * Command ids and their request/response codecs: the SDK's table, plus the commands it does not
 * register and the ones whose V3 messages differ from the SDK's.
 */
import { Command, getRequestType, getResponseType } from '@alikh/dwarflab-sdk';
import { protoTypeByName as T, type ProtoType } from './types.js';

/** Commands the SDK enum does not name. */
const EXTRA_CMDS = {
  STEP_MOTOR_RUN_TO: 14001,
  STEP_MOTOR_RESET: 14003,
  STEP_MOTOR_GET_POSITION: 14011,
} as const;

export const Cmd: typeof Command & typeof EXTRA_CMDS = Object.freeze(Object.assign({}, Command, EXTRA_CMDS));

interface Codec {
  req?: ProtoType;
  res?: ProtoType;
}

const OK = T('base.ComResponse');
const EMPTY = T('extra.Empty');

const OVERRIDES = new Map<number, Codec>([
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

export function requestType(cmd: number): ProtoType | undefined {
  return OVERRIDES.get(cmd)?.req ?? (getRequestType(cmd as Command) as ProtoType | undefined);
}

export function responseType(cmd: number): ProtoType | undefined {
  return OVERRIDES.get(cmd)?.res ?? (getResponseType(cmd as Command) as ProtoType | undefined);
}
