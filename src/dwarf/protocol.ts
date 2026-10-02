/**
 * Command/notification registry for the DWARF V3 WebSocket protocol.
 *
 * Built on @alikh/dwarflab-sdk: its generated protobuf namespace, packet codec,
 * command enum, and per-command codec table. This module adds the commands the
 * SDK doesn't register (motor run-to/reset/position, master lock, extra astro
 * commands), a few message variants observed on V3 firmware (goto_only etc.),
 * and notification decoders for every notify command the firmware emits.
 */
import protobuf from 'protobufjs';
import {
  proto,
  Command,
  getRequestType,
  getResponseType,
  getErrorMessage,
} from '@alikh/dwarflab-sdk';
import { FIRMWARE_ERRORS } from './error-codes.js';

export interface ProtoType {
  encode(message: unknown): { finish(): Uint8Array };
  decode(reader: Uint8Array): unknown;
  create(properties?: unknown): unknown;
  toObject?(message: unknown, options?: unknown): Record<string, unknown>;
}

// Message variants seen in V3 firmware that the SDK's protos lack.
const EXTRA_PROTO = `
syntax = "proto3";
package dwarflab.extra;
message ReqGotoDSO {
  double ra = 1;
  double dec = 2;
  string target_name = 3;
  bool goto_only = 4;
  optional int32 rotation = 5;
}
message ReqOneClickGotoDSO {
  double ra = 1;
  double dec = 2;
  string target_name = 3;
  double lon = 4;
  double lat = 5;
  int32 shooting_mode = 6;
  bool goto_only = 7;
  optional int32 rotation = 8;
}
message ReqStartEqSolving {
  double lon = 1;
  double lat = 2;
  optional bool use_calibration = 3;
}
message Empty {}
`;

const extraRoot = protobuf.parse(EXTRA_PROTO, { keepCase: false }).root;
const extra = (name: string) => extraRoot.lookupType(`dwarflab.extra.${name}`) as unknown as ProtoType;

const ns = proto as unknown as Record<string, Record<string, ProtoType>>;
function T(ref: string): ProtoType {
  const [pkg, name] = ref.split('.');
  if (pkg === 'extra') return extra(name);
  const t = ns[pkg]?.[name];
  if (!t) throw new Error(`protocol: unknown proto type ${ref}`);
  return t;
}

/** Commands the SDK enum doesn't name. */
const EXTRA_CMDS = {
  STEP_MOTOR_RUN_TO: 14001,
  STEP_MOTOR_RESET: 14003,
  STEP_MOTOR_GET_POSITION: 14011,
} as const;
export const Cmd: typeof Command & typeof EXTRA_CMDS = Object.assign({}, Command, EXTRA_CMDS);

type Entry = { req?: ProtoType; res?: ProtoType };

// Overrides / additions on top of the SDK codec table.
const OVERRIDES: Record<number, Entry> = {
  // motor
  14001: { req: T('motor.ReqMotorRunTo'), res: T('motor.ResMotor') },
  14002: { req: T('motor.ReqMotorStop'), res: T('motor.ResMotor') },
  14003: { req: T('motor.ReqMotorReset'), res: T('motor.ResMotor') },
  14011: { req: T('motor.ReqMotorGetPosition'), res: T('motor.ResMotorPosition') },
  14008: { req: T('motor.ReqMotorServiceJoystickStop'), res: T('base.ComResponse') },
  // system / power
  13004: { req: T('system.ReqsetMasterLock'), res: T('base.ComResponse') },
  13503: { req: T('rgb.ReqOpenPowerInd'), res: T('base.ComResponse') },
  13504: { req: T('rgb.ReqClosePowerInd'), res: T('base.ComResponse') },
  // astro
  11002: { req: T('extra.ReqGotoDSO'), res: T('base.ComResponse') },
  11011: { req: T('astro.ReqTrackSpecialTarget'), res: T('base.ComResponse') },
  11012: { req: T('astro.ReqStopTrackSpecialTarget'), res: T('base.ComResponse') },
  11013: { req: T('extra.ReqOneClickGotoDSO'), res: T('astro.ResOneClickGoto') },
  11014: { req: T('astro.ReqOneClickGotoSolarSystem'), res: T('astro.ResOneClickGotoSolarSystem') },
  11018: { req: T('extra.ReqStartEqSolving'), res: T('astro.ResStartEqSolving') },
  11037: { req: T('astro.ReqFastStopCaptureRawLiveStacking'), res: T('base.ComResponse') },
  11038: { req: T('astro.ReqFastStopCaptureWideRawLiveStacking'), res: T('base.ComResponse') },
  11039: { req: T('astro.ReqGetAstroShootingTime'), res: T('astro.ResGetAstroShootingTime') },
  11043: { req: T('astro.ReqGetCaliFrameList'), res: T('astro.ResGetCaliFrameList') },
  11044: { req: T('astro.ReqDelCaliFrameList'), res: T('base.ComResponse') },
  11045: { req: T('astro.ReqCaptureCaliFrame'), res: T('base.ComResponse') },
  11046: { req: T('astro.ReqStopCaptureCaliFrame'), res: T('base.ComResponse') },
  // focus
  15011: { req: T('focus.ReqGetUserInfinityPos'), res: T('focus.ResUserInfinityPos') },
  15012: { req: T('focus.ReqSetUserInfinityPos'), res: T('base.ComResponse') },
  // params
  16704: { req: T('param.ReqSetGeneralFloatParam'), res: T('base.ComResponse') },
  16705: { req: T('param.ReqSetGeneralBoolParams'), res: T('base.ComResponse') },
  16706: { req: T('param.ReqSetAutoParam'), res: T('param.ResSetAutoParam') },
  // tracking extras
  14805: { req: T('track.ReqMOTTrackOne'), res: T('base.ComResponse') },
  14808: { req: T('track.ReqMOTTrackOne'), res: T('base.ComResponse') },
  14810: { req: T('track.ReqUFOAutoHandMode'), res: T('base.ComResponse') },
};

export function requestType(cmd: number): ProtoType | undefined {
  return OVERRIDES[cmd]?.req ?? (getRequestType(cmd as Command) as ProtoType | undefined);
}

export function responseType(cmd: number): ProtoType | undefined {
  return OVERRIDES[cmd]?.res ?? (getResponseType(cmd as Command) as ProtoType | undefined);
}

/** Look up any proto type by "pkg.Name" (used by the raw command tool). */
export function protoTypeByName(ref: string): ProtoType {
  return T(ref);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFY: Record<number, { name: string; type?: string }> = {
  15200: { name: 'pictureMatching', type: 'notify.PictureMatching' },
  15201: { name: 'battery', type: 'notify.BatteryInfo' },
  15202: { name: 'charging', type: 'notify.ChargingState' },
  15203: { name: 'sdCard', type: 'notify.StorageInfo' },
  15204: { name: 'teleRecordTime', type: 'notify.RecordTime' },
  15205: { name: 'teleTimelapseOutTime', type: 'notify.TimeLapseOutTime' },
  15206: { name: 'darkCaptureState', type: 'notify.OperationStateNotify' },
  15207: { name: 'darkCaptureProgress', type: 'notify.ProgressCaptureRawDark' },
  15208: { name: 'teleStackingState', type: 'notify.OperationStateNotify' },
  15209: { name: 'teleStackingProgress', type: 'notify.ProgressCaptureRawLiveStacking' },
  15210: { name: 'calibrationState', type: 'notify.AstroCalibrationState' },
  15211: { name: 'gotoState', type: 'notify.AstroGotoState' },
  15212: { name: 'trackingState', type: 'notify.AstroTrackingState' },
  15218: { name: 'teleBurstProgress', type: 'notify.BurstProgress' },
  15219: { name: 'panoramaProgress', type: 'notify.PanoramaProgress' },
  15220: { name: 'wideBurstProgress', type: 'notify.BurstProgress' },
  15221: { name: 'rgbState', type: 'notify.RgbState' },
  15222: { name: 'powerIndicatorState', type: 'notify.PowerIndState' },
  15223: { name: 'hostSlaveMode', type: 'notify.HostSlaveMode' },
  15224: { name: 'mtpState', type: 'notify.MTPState' },
  15225: { name: 'trackResult', type: 'notify.TrackResult' },
  15226: { name: 'wideTimelapseOutTime', type: 'notify.TimeLapseOutTime' },
  15227: { name: 'cpuMode', type: 'notify.CPUMode' },
  15228: { name: 'specialTrackingState', type: 'notify.AstroTrackingSpecialState' },
  15229: { name: 'powerOff', type: 'notify.PowerOff' },
  15230: { name: 'albumUpdate', type: 'notify.AlbumUpdate' },
  15231: { name: 'sentryState', type: 'notify.SentryState' },
  15232: { name: 'sentryTrackResult', type: 'notify.TrackResult' },
  15233: { name: 'oneClickGotoState', type: 'notify.OneClickGotoState' },
  15234: { name: 'streamType', type: 'notify.StreamType' },
  15235: { name: 'wideRecordTime', type: 'notify.RecordTime' },
  15236: { name: 'wideStackingState', type: 'notify.OperationStateNotify' },
  15237: { name: 'wideStackingProgress', type: 'notify.ProgressCaptureRawLiveStacking' },
  15238: { name: 'multiTrackResult', type: 'notify.MultiTrackResult' },
  15239: { name: 'eqSolvingState', type: 'notify.EqSolvingState' },
  15241: { name: 'teleLongExpProgress', type: 'notify.LongExpPhotoProgress' },
  15242: { name: 'wideLongExpProgress', type: 'notify.LongExpPhotoProgress' },
  15243: { name: 'temperature', type: 'notify.Temperature' },
  15247: { name: 'wideDarkCaptureState', type: 'notify.OperationStateNotify' },
  15251: { name: 'wideMultiTrackResult', type: 'notify.MultiTrackResult' },
  15252: { name: 'wideTrackResult', type: 'notify.TrackResult' },
  15253: { name: 'aiEnhanceState', type: 'notify.OperationStateNotify' },
  15254: { name: 'aiEnhanceProgress', type: 'notify.ProgressAiEnhance' },
  15255: { name: 'waitShootingProgress', type: 'notify.CommonProgress' },
  15256: { name: 'calibrationResult', type: 'notify.CalibrationResult' },
  15257: { name: 'focusPosition', type: 'notify.FocusPosition' },
  15258: { name: 'ufoAutoHandMode', type: 'notify.SentryAutoHand' },
  15260: { name: 'lowTempProtection', type: 'notify.LowTempProtectionMode' },
  15261: { name: 'systemResourceState', type: 'notify.StateSystemResourceOccupation' },
  15262: { name: 'bodyStatus', type: 'notify.BodyStatus' },
  15263: { name: 'mosaicProgress', type: 'notify.ProgressCaptureMosaic' },
  15264: { name: 'intParam', type: 'notify.GeneralIntParam' },
  15265: { name: 'floatParam', type: 'notify.GeneralFloatParam' },
  15266: { name: 'boolParam', type: 'notify.GeneralBoolParams' },
  15267: { name: 'shootingMode', type: 'notify.SwitchShootingMode' },
  15268: { name: 'cropRatio', type: 'notify.SwitchCropRatioState' },
  15270: { name: 'whiteBalance', type: 'notify.Wb' },
  15272: { name: 'resolution', type: 'notify.ResolutionParam' },
  15273: { name: 'photoState', type: 'notify.PhotoState' },
  15274: { name: 'burstState', type: 'notify.BurstState' },
  15275: { name: 'recordState', type: 'notify.RecordState' },
  15276: { name: 'timelapseState', type: 'notify.TimeLapseState' },
  15277: { name: 'panoramaState', type: 'notify.PanoramaState' },
  15278: { name: 'astroAutoFocusState', type: 'notify.AstroAutoFocusState' },
  15279: { name: 'autoFocusState', type: 'notify.NormalAutoFocusState' },
  15280: { name: 'astroAutoFocusFastState', type: 'notify.AstroAutoFocusFastState' },
  15281: { name: 'areaAutoFocusState', type: 'notify.AreaAutoFocusState' },
  15282: { name: 'dualCameraLinkage', type: 'notify.DualCameraLinkageState' },
  15283: { name: 'resolutionFpsState', type: 'notify.SwitchResolutionFpsState' },
  15284: { name: 'normalTrackState', type: 'notify.NormalTrackState' },
  15285: { name: 'burstProgress', type: 'notify.BurstProgress' },
  15286: { name: 'recordTime', type: 'notify.RecordTime' },
  15287: { name: 'timelapseOutTime', type: 'notify.TimeLapseOutTime' },
  15288: { name: 'longExpProgress', type: 'notify.LongExpPhotoProgress' },
  15289: { name: 'sentryMotorState' },
  15290: { name: 'caliFrameState', type: 'notify.CaptureCaliFrameState' },
  15291: { name: 'caliFrameProgress', type: 'notify.CaptureCaliFrameProgress' },
  15292: { name: 'cmosTemperature', type: 'notify.CmosTemperature' },
  15296: { name: 'skyTargetFinderState', type: 'notify.SkyTargetFinderState' },
};

const notifyTypes = new Map<number, ProtoType>();
for (const [cmd, { type }] of Object.entries(NOTIFY)) {
  if (type) notifyTypes.set(Number(cmd), T(type));
}

/** protobufjs → plain JSON with int64 as decimal strings and enums as numbers. */
export function toPlain(type: ProtoType, msg: unknown): Record<string, unknown> {
  const t = type as unknown as { toObject(m: unknown, o: unknown): Record<string, unknown> };
  return t.toObject(msg, { longs: String, enums: Number, defaults: false, oneofs: true });
}

export function decodeWith(type: ProtoType | undefined, data: Uint8Array): Record<string, unknown> {
  if (!type) return rawDecode(data);
  try {
    return toPlain(type, type.decode(data));
  } catch {
    return rawDecode(data);
  }
}

export function decodeNotification(cmd: number, data: Uint8Array): { name: string; data: Record<string, unknown> } {
  const meta = NOTIFY[cmd];
  return { name: meta?.name ?? `notify_${cmd}`, data: decodeWith(notifyTypes.get(cmd), data) };
}

/** Schema-less protobuf decode: {f1: 3, f2: "..."} — used for unknown payloads. */
export function rawDecode(data: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  const varint = (): bigint => {
    let shift = 0n;
    let result = 0n;
    while (i < data.length) {
      const b = data[i++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  };
  try {
    while (i < data.length) {
      const key = Number(varint());
      const field = key >> 3;
      const wire = key & 7;
      let value: unknown;
      if (wire === 0) {
        const v = varint();
        value = v > 0x7fffffffffffffffn ? Number(v - 0x10000000000000000n) : v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      } else if (wire === 1) {
        value = new DataView(data.buffer, data.byteOffset + i, 8).getFloat64(0, true);
        i += 8;
      } else if (wire === 5) {
        value = new DataView(data.buffer, data.byteOffset + i, 4).getFloat32(0, true);
        i += 4;
      } else if (wire === 2) {
        const len = Number(varint());
        const bytes = data.subarray(i, i + len);
        i += len;
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        value = /^[\x20-\x7e\s]*$/.test(text) ? text : Buffer.from(bytes).toString('hex');
      } else {
        break;
      }
      const k = `f${field}`;
      if (k in out) out[k] = ([] as unknown[]).concat(out[k], value);
      else out[k] = value;
    }
  } catch {
    out._hex = Buffer.from(data).toString('hex');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors and enums
// ---------------------------------------------------------------------------

const HINTS: Record<number, string> = {
  [-1]: 'rejected by firmware — usually the device is in the wrong shooting mode/technique for this command',
  [-14520]: 'motors must be homed first (use motor_home)',
};

export function errorText(code: number): string {
  const name = FIRMWARE_ERRORS[code];
  const sdk = getErrorMessage(code);
  const base = name ?? (sdk && !sdk.startsWith('Unknown error') ? sdk : `unknown error`);
  const hint = HINTS[code];
  return `${base} (${code})${hint ? ` — ${hint}` : ''}`;
}

/** SolarSystemTarget enum from the firmware's protocol.proto. */
export const SOLAR_SYSTEM_INDEX: Record<string, number> = {
  mercury: 1,
  venus: 2,
  mars: 3,
  jupiter: 4,
  saturn: 5,
  uranus: 6,
  neptune: 7,
  moon: 8,
  sun: 9,
};

export const OPERATION_STATE = ['idle', 'running', 'stopping', 'stopped'];
export const ASTRO_STATE = ['idle', 'running', 'stopping', 'stopped', 'plate_solving'];
