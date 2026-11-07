/**
 * The per-telescope settings a profile can set for its own process, with the same names, ranges and
 * defaults the process reads them with (src/config.ts reads these keys through this table, so the
 * two cannot drift). The profile editor in the hub shows each as a field, and the hub checks every
 * value against it before saving: a value the process would refuse (PLAN_BORTLE=abc) is turned
 * away in the form, not discovered when the process fails to start.
 */
import { Env } from './env.js';

export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

interface Base {
  key: string;
  label: string;
  group: 'Sky and site' | 'Optics and mount' | 'Agent';
  hint: string;
  unit?: string;
}
export interface NumberSetting extends Base {
  kind: 'number';
  /** null: unset means "not known", and the planner says what it is missing */
  default: number | null;
  min?: number;
  max?: number;
  int?: boolean;
  step?: number;
}
export interface TextSetting extends Base {
  kind: 'text';
  default: string;
  /** offered in the field's suggestion list; any value is accepted */
  suggest?: readonly string[];
}
export interface BoolSetting extends Base {
  kind: 'bool';
  default: boolean;
}
export interface ChoiceSetting extends Base {
  kind: 'choice';
  default: string;
  choices: readonly string[];
}
export type Setting = NumberSetting | TextSetting | BoolSetting | ChoiceSetting;

const n = <D extends number | null>(s: Omit<NumberSetting, 'kind' | 'default'> & { default: D }): NumberSetting & { default: D } => ({ kind: 'number', ...s });

export const S = {
  PLAN_BORTLE: n({ key: 'PLAN_BORTLE', label: 'Bortle class', group: 'Sky and site', default: 5, min: 1, max: 9, step: 0.1, hint: '1 is a dark site, 5 a suburb, 9 inner city. Fractions from a light-pollution map (6.6) are fine.' }),
  PLAN_SKY_SQM: n({ key: 'PLAN_SKY_SQM', label: 'Sky brightness (SQM)', group: 'Sky and site', default: null, min: 16, max: 22.5, step: 0.01, unit: 'mag/arcsec²', hint: 'From a sky meter. Wins over Bortle and over the rig’s own sky measurements.' }),
  PLAN_MIN_ALTITUDE_DEG: n({ key: 'PLAN_MIN_ALTITUDE_DEG', label: 'Minimum altitude', group: 'Sky and site', default: 25, min: 0, max: 90, step: 1, unit: '°', hint: 'Lowest altitude the plan uses (trees, houses, haze).' }),
  PLAN_FILTERS: { kind: 'text', key: 'PLAN_FILTERS', label: 'Filters on the scope', group: 'Optics and mount', default: 'Astro,Duo-Band', suggest: ['Astro,Duo-Band', 'none,LP'], hint: 'Comma-separated. Each target is planned through the best of them.' } as TextSetting,
  PLAN_FILTER: { kind: 'text', key: 'PLAN_FILTER', label: 'Force one filter', group: 'Optics and mount', default: '', suggest: ['none', 'astro', 'duo-band', 'ha 7nm', 'optolong l-extreme'], hint: 'Plan every target through this glass. Empty: the best of the filters above.' } as TextSetting,
  PLAN_DEVICE: { kind: 'text', key: 'PLAN_DEVICE', label: 'Device spec', group: 'Optics and mount', default: '', suggest: ['dwarf-3', 'dwarf-mini', 'seestar-s30', 'seestar-s30-pro', 'seestar-s50', 'seestar-s50-pro'], hint: 'A devices/*.json id. Empty: picked from what the scope reports.' } as TextSetting,
  PLAN_APERTURE_MM: n({ key: 'PLAN_APERTURE_MM', label: 'Aperture', group: 'Optics and mount', default: null, min: 1, max: 2000, step: 1, unit: 'mm', hint: 'Clear aperture of the tele lens: the one optics number the scope cannot report.' }),
  PLAN_READ_NOISE_E: n({ key: 'PLAN_READ_NOISE_E', label: 'Read noise', group: 'Optics and mount', default: null, min: 0.1, max: 50, step: 0.1, unit: 'e⁻', hint: 'Without it the sub advice is a range rather than one number.' }),
  PLAN_PLATE_SCALE_ARCSEC: n({ key: 'PLAN_PLATE_SCALE_ARCSEC', label: 'Plate scale', group: 'Optics and mount', default: null, min: 0.05, max: 60, step: 0.001, unit: '″/px', hint: 'Empty: the app’s own tele plate scale.' }),
  PLAN_MOUNT: { kind: 'choice', key: 'PLAN_MOUNT', label: 'Mount', group: 'Optics and mount', default: 'alt-az', choices: ['alt-az', 'eq'], hint: 'A wedge or a pier-mounted rig is eq: it changes what trails and how soon.' } as ChoiceSetting,
  PLAN_GUIDED: { kind: 'bool', key: 'PLAN_GUIDED', label: 'Guided', group: 'Optics and mount', default: false, hint: 'Guiding removes the trailing ceiling: the sky alone sets the sub length.' } as BoolSetting,
  PLAN_SWAMP_FACTOR: n({ key: 'PLAN_SWAMP_FACTOR', label: 'Swamp factor', group: 'Optics and mount', default: 10, min: 1, max: 100, step: 0.5, hint: 'Sky noise² over read noise² a sub should reach. 10 is Deep Sky Detail’s recommendation; 3–5 is lenient.' }),
  DUTY_INTERVAL_S: n({ key: 'DUTY_INTERVAL_S', label: 'Duty interval', group: 'Agent', default: 300, min: 30, max: 900, step: 10, unit: 's', hint: 'How often the agent is woken while on duty (events wake it at once).' }),
  STACK_AUTOSTOP_MIN: n({ key: 'STACK_AUTOSTOP_MIN', label: 'Stop a stack that keeps nothing after', group: 'Agent', default: 10, min: 0, step: 1, unit: 'min', hint: '0 = only notify.' }),
  PROMPT_TRANSFER_ON_CHARGE: { kind: 'bool', key: 'PROMPT_TRANSFER_ON_CHARGE', label: 'Transfer and shut down when put on charge', group: 'Agent', default: false, hint: 'Wake the agent when the scope is plugged in with sessions on its card.' } as BoolSetting,
  LLM_MODEL: { kind: 'text', key: 'LLM_MODEL', label: 'Model', group: 'Agent', default: 'qwen', hint: 'The model this telescope’s agent uses.' } as TextSetting,
  REASONING_EFFORT: { kind: 'choice', key: 'REASONING_EFFORT', label: 'Reasoning effort', group: 'Agent', default: 'medium', choices: REASONING_EFFORTS, hint: '' } as ChoiceSetting,
} as const satisfies Record<string, Setting>;

export type SettingKey = keyof typeof S;
export const SETTINGS: readonly Setting[] = Object.values(S);
const BY_KEY = new Map<string, Setting>(SETTINGS.map((s) => [s.key, s]));
export const settingFor = (key: string): Setting | undefined => BY_KEY.get(key);

/** Read one setting the way the process does, so a bad value is reported the same way. */
function read(env: Env, s: Setting): void {
  switch (s.kind) {
    case 'number':
      env.optNum(s.key, s);
      break;
    case 'bool':
      env.bool(s.key, s.default);
      break;
    case 'choice':
      env.oneOf(s.key, s.choices, s.default);
      break;
    case 'text':
      break;
  }
}

/** What is wrong with a profile's variables, as the process would report it ([] = it starts). */
export function settingProblems(vars: Record<string, string>): string[] {
  const env = new Env(vars);
  for (const k of Object.keys(vars)) {
    const s = BY_KEY.get(k);
    if (s) read(env, s);
  }
  return env.problemList();
}
