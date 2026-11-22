/**
 * Which DWARFLAB model is on the other end. The Dwarf 3 and the Dwarf mini speak the same protocol,
 * but their mounts differ:
 *  - Dwarf 3: both axes have a reference switch; a reset references rotation and pitch.
 *  - Dwarf mini: only pitch has one. Its rotation axis has no home/limit sensor, so a rotation reset
 *    never completes (-14511 every ~4.3 s, the base turning all the while) and rotation never reports
 *    a position (-14520). The firmware's own calibration resets pitch only and plate-solves from
 *    wherever rotation points (verified 2026-11-21 on fw 1.1.4.19; stevejcl/dwarf_python_api and
 *    astro_dwarf_session found the same). Its tilt range is 225° (DWARFLAB spec).
 * The model comes from the device info (`DWARF_mini_6A7478`, serial `DM…`), read over HTTP on connect.
 */
export type DwarfModel = 'dwarf3' | 'mini';

export function dwarfModel(device: { name?: string; serial?: string } | undefined): DwarfModel | null {
  if (!device) return null;
  if (/mini/i.test(device.name ?? '') || /^DM/i.test(device.serial ?? '')) return 'mini';
  return device.name || device.serial ? 'dwarf3' : null;
}

export const MODEL_LABEL: Record<DwarfModel, string> = { dwarf3: 'Dwarf 3', mini: 'Dwarf mini' };
