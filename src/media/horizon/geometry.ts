/**
 * Where the wide camera looks, in true azimuth and altitude, for a given motor pose — in Alt-Az
 * and in EQ alike.
 *
 * The Dwarf is a two-axis mount: rotation turns about the mount's axis P (the zenith on the
 * alt-az head, the celestial pole when tilted onto a wedge for EQ), pitch tilts away from P's
 * equator (pitch 90 is perpendicular to P, 180 along it). In the mount's own spherical frame a pose
 * is a latitude φ = pitch − 90 + δ and a longitude λ = λ0 + s·rotation. P comes from the telescope
 * (zenith, or the polar axis its calibration reports); δ, λ0 and s come from anchors: poses whose
 * true direction is known because the telescope's own plate-solved GoTo put them there.
 *
 * Directions are unit vectors in east-north-up. Azimuth is from north through east.
 */

export type Vec = [number, number, number];

const D = Math.PI / 180;
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const add = (...vs: Vec[]): Vec => vs.reduce<Vec>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
const unit = (a: Vec): Vec => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));
const norm360 = (a: number) => ((a % 360) + 360) % 360;

export function fromAltAz(azDeg: number, altDeg: number): Vec {
  const c = Math.cos(altDeg * D);
  return [c * Math.sin(azDeg * D), c * Math.cos(azDeg * D), Math.sin(altDeg * D)];
}

export function toAltAz(v: Vec): { az: number; alt: number } {
  return { az: norm360(Math.atan2(v[0], v[1]) / D), alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) / D };
}

/** Angle between two directions, degrees. */
export const angleDeg = (a: Vec, b: Vec) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / D;

/** The mount's axes in east-north-up: z along P, y toward the zenith side of P (north when P is the zenith). */
export interface MountFrame {
  x: Vec;
  y: Vec;
  z: Vec;
}

export function mountFrame(poleAz: number, poleAlt: number): MountFrame {
  const z = fromAltAz(poleAz, poleAlt);
  const up: Vec = [0, 0, 1];
  const ref = Math.abs(dot(z, up)) > 0.999 ? ([0, 1, 0] as Vec) : unit(add(up, scale(z, -dot(up, z))));
  return { x: cross(ref, z), y: ref, z };
}

/** The fitted relation between motor angles and the mount frame. */
export interface MountModel {
  pole: { az: number; alt: number };
  /** λ at rotation 0, degrees */
  lambda0: number;
  /** +1 or −1: λ = lambda0 + sense·rotation */
  sense: 1 | -1;
  /** φ = pitch − 90 + pitchOffset */
  pitchOffset: number;
}

/** The pointing direction (and the camera's up and right) for a motor pose. */
export function poseBasis(model: MountModel, rotationDeg: number, pitchDeg: number, frame = mountFrame(model.pole.az, model.pole.alt)): { b: Vec; u: Vec; r: Vec } {
  const phi = (pitchDeg - 90 + model.pitchOffset) * D;
  const lam = (model.lambda0 + model.sense * rotationDeg) * D;
  const inMount = (c: Vec): Vec => add(scale(frame.x, c[0]), scale(frame.y, c[1]), scale(frame.z, c[2]));
  // the formulas stay valid past φ = 90° (pitch beyond the pole), so the camera turns over continuously
  const b = inMount([Math.cos(phi) * Math.sin(lam), Math.cos(phi) * Math.cos(lam), Math.sin(phi)]);
  const u = inMount([-Math.sin(phi) * Math.sin(lam), -Math.sin(phi) * Math.cos(lam), Math.cos(phi)]);
  return { b, u, r: cross(b, u) };
}

/** The motor pose that points along v: the solution with pitch ≤ 180 when there is one. null when out of the mount's travel. */
export function poseFor(model: MountModel, v: Vec, ranges: { rotation: readonly [number, number]; pitch: readonly [number, number] }, frame = mountFrame(model.pole.az, model.pole.alt)): { rotationDeg: number; pitchDeg: number } | null {
  const c: Vec = [dot(v, frame.x), dot(v, frame.y), dot(v, frame.z)];
  const phi = Math.asin(Math.max(-1, Math.min(1, c[2]))) / D;
  const lam = Math.atan2(c[0], c[1]) / D;
  // the direct pose, and the one through the pole (pitch mirrored about 180, longitude turned half round)
  const options = [
    { pitch: phi + 90 - model.pitchOffset, lam },
    { pitch: 180 - phi + 90 - model.pitchOffset, lam: lam + 180 },
  ];
  for (const o of options) {
    if (o.pitch < ranges.pitch[0] || o.pitch > ranges.pitch[1]) continue;
    const rot0 = norm360((o.lam - model.lambda0) * model.sense);
    for (const rot of [rot0, rot0 - 360]) {
      if (rot >= ranges.rotation[0] && rot <= ranges.rotation[1]) return { rotationDeg: Math.round(rot * 100) / 100, pitchDeg: Math.round(o.pitch * 100) / 100 };
    }
  }
  return null;
}

/** An anchor: a motor pose whose true direction is known. */
export interface Anchor {
  rotationDeg: number;
  pitchDeg: number;
  az: number;
  alt: number;
}

/**
 * Fit λ0, the sense and the pitch offset to the anchors by search (robust to the wrap-around and to
 * poses past the pole). With one anchor the sense is the one the hardware showed (rotation angle
 * decreasing pans right, i.e. toward increasing azimuth: −1). The residual is the RMS miss in degrees.
 */
export function fitMount(pole: { az: number; alt: number }, anchors: Anchor[], defaultSense: 1 | -1 = -1): { model: MountModel; residualDeg: number } {
  if (!anchors.length) throw new Error('no anchors to fit the mount to');
  const frame = mountFrame(pole.az, pole.alt);
  const targets = anchors.map((a) => fromAltAz(a.az, a.alt));
  const cost = (m: MountModel) => {
    let s = 0;
    anchors.forEach((a, i) => {
      s += angleDeg(poseBasis(m, a.rotationDeg, a.pitchDeg, frame).b, targets[i]) ** 2;
    });
    return Math.sqrt(s / anchors.length);
  };
  const senses: Array<1 | -1> = anchors.length > 1 ? [-1, 1] : [defaultSense];
  let best: { model: MountModel; residualDeg: number } | null = null;
  for (const sense of senses) {
    // coarse: λ0 every degree, offset every degree within ±15°
    for (let off = -15; off <= 15; off += 1) {
      for (let l0 = 0; l0 < 360; l0 += 1) {
        const m: MountModel = { pole, lambda0: l0, sense, pitchOffset: off };
        const c = cost(m);
        if (!best || c < best.residualDeg) best = { model: m, residualDeg: c };
      }
    }
  }
  // refine around the coarse best, halving the step
  let step = 0.5;
  let cur = best!;
  while (step > 0.01) {
    let moved = false;
    for (const [dl, dp] of [[step, 0], [-step, 0], [0, step], [0, -step]] as const) {
      const m = { ...cur.model, lambda0: norm360(cur.model.lambda0 + dl), pitchOffset: cur.model.pitchOffset + dp };
      const c = cost(m);
      if (c < cur.residualDeg) {
        cur = { model: m, residualDeg: c };
        moved = true;
      }
    }
    if (!moved) step /= 2;
  }
  return cur;
}

/** The wide camera: its pixel size, focal length in pixels, and where the motor pose points in it. */
export interface CameraGeom {
  width: number;
  height: number;
  /** focal length in pixels */
  f: number;
  /** pixel of the pointing direction (the tele boresight inside the wide frame) */
  cx: number;
  cy: number;
}

export function cameraGeom(width: number, height: number, hfovDeg: number, boresight = { x: 0.5, y: 0.5 }): CameraGeom {
  return { width, height, f: width / 2 / Math.tan((hfovDeg / 2) * D), cx: boresight.x * width, cy: boresight.y * height };
}

/** The direction seen at a pixel. */
export function pixelToDir(cam: CameraGeom, basis: { b: Vec; u: Vec; r: Vec }, px: number, py: number): Vec {
  return unit(add(basis.b, scale(basis.r, (px - cam.cx) / cam.f), scale(basis.u, (cam.cy - py) / cam.f)));
}

/** The pixel a direction falls on, or null when it is behind the camera. (May be outside the frame.) */
export function dirToPixel(cam: CameraGeom, basis: { b: Vec; u: Vec; r: Vec }, v: Vec): { x: number; y: number } | null {
  const z = dot(v, basis.b);
  if (z <= 0.05) return null;
  return { x: cam.cx + (cam.f * dot(v, basis.r)) / z, y: cam.cy - (cam.f * dot(v, basis.u)) / z };
}
