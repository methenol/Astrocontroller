/** Weather quantities in the units the user picked (UNITS); everything is computed in metric. */
export type Units = 'metric' | 'imperial';

const round = (n: number, d: number) => (d ? n.toFixed(d) : String(Math.round(n)));

export interface UnitFormat {
  /** an air temperature: "12°C" / "54°F" */
  temp(c: number): string;
  /** a temperature difference (dew-point spread): "2.2°C" / "4.0°F" */
  tempDelta(c: number): string;
  /** a wind speed: "45 km/h" / "28 mph" */
  speed(kmh: number): string;
  /** precipitation: "0.30 mm" / "0.012 in"; `d` = metric decimals */
  precip(mm: number, d?: number): string;
  /** snowfall: "2 cm" / "0.8 in" */
  snow(cm: number): string;
  /** a distance: "20 km" / "12 mi" */
  dist(km: number): string;
}

export function unitFormat(u: Units): UnitFormat {
  if (u === 'imperial') {
    return {
      temp: (c) => `${Math.round((c * 9) / 5 + 32)}°F`,
      tempDelta: (c) => `${((c * 9) / 5).toFixed(1)}°F`,
      speed: (kmh) => `${Math.round(kmh / 1.609344)} mph`,
      precip: (mm, d = 2) => `${(mm / 25.4).toFixed(d + 1)} in`,
      snow: (cm) => `${(cm / 2.54).toFixed(1)} in`,
      dist: (km) => `${Math.round(km / 1.609344)} mi`,
    };
  }
  return {
    temp: (c) => `${Math.round(c)}°C`,
    tempDelta: (c) => `${c.toFixed(1)}°C`,
    speed: (kmh) => `${Math.round(kmh)} km/h`,
    precip: (mm, d = 2) => `${round(mm, d)} mm`,
    snow: (cm) => `${round(cm, 1)} cm`,
    dist: (km) => `${Math.round(km)} km`,
  };
}
