/** Firmware enums the controller names. */

/** SolarSystemTarget enum from the firmware's protocol.proto. */
export const SOLAR_SYSTEM_INDEX: Readonly<Record<string, number>> = Object.freeze({
  mercury: 1,
  venus: 2,
  mars: 3,
  jupiter: 4,
  saturn: 5,
  uranus: 6,
  neptune: 7,
  moon: 8,
  sun: 9,
});

export const OPERATION_STATE: readonly string[] = ['idle', 'running', 'stopping', 'stopped'];
export const ASTRO_STATE: readonly string[] = ['idle', 'running', 'stopping', 'stopped', 'plate_solving'];
