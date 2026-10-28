/** Weather quantities in the units the server's UNITS setting picks (config.units); the API speaks metric. */
import { state } from './state.js';

export const imperial = () => state.config?.units === 'imperial';
const f1 = (n, d) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '–');

/** An air temperature: "12°C" / "54°F". */
export const temp = (c) => (typeof c !== 'number' ? '–' : imperial() ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`);
/** A temperature difference with no unit letter, for tight cells: "2.2°" / "4.0°". */
export const delta = (c) => `${f1(imperial() ? (c * 9) / 5 : c, 1)}°`;
/** A wind speed's number and its unit word. */
export const speedN = (kmh) => (typeof kmh !== 'number' ? '–' : String(Math.round(imperial() ? kmh / 1.609344 : kmh)));
export const speedUnit = () => (imperial() ? 'mph' : 'km/h');
export const speed = (kmh) => `${speedN(kmh)} ${speedUnit()}`;
/** Precipitation: "0.30 mm" / "0.012 in"; `d` = metric decimals. */
export const precip = (mm, d = 2) => (imperial() ? `${f1(mm / 25.4, d + 1)} in` : `${f1(mm, d)} mm`);
export const precipUnit = () => (imperial() ? 'in' : 'mm');

/** The Rain Guard's metric settings as the form shows them, and back. */
const FIELDS = {
  thresholdMm: { unit: 'in', to: (v) => +(v / 25.4).toFixed(3), from: (v) => v * 25.4 },
  gustKmh: { unit: 'mph', to: (v) => Math.round(v / 1.609344), from: (v) => v * 1.609344 },
  ringKm: { unit: 'mi', to: (v) => Math.round(v / 1.609344), from: (v) => v * 1.609344 },
  minTempC: { unit: '°F', to: (v) => Math.round((v * 9) / 5 + 32), from: (v) => ((v - 32) * 5) / 9 },
};
export const settingUnit = (k, metric) => (imperial() && FIELDS[k] ? FIELDS[k].unit : metric);
export const settingToView = (k, v) => (imperial() && FIELDS[k] ? FIELDS[k].to(v) : v);
export const settingFromView = (k, v) => (imperial() && FIELDS[k] ? Math.round(FIELDS[k].from(v) * 1000) / 1000 : v);
