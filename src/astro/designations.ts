/**
 * Object designations: the one normalisation used for every lookup key, so "Messier 31", "m31",
 * "NGC 0224", "Sharpless 2-155", "alpha Lyrae" and "α Lyr" all land on the same object.
 * Shared by the runtime catalog and the catalog build tool (src/tools/build-catalog.ts).
 */

/** OpenNGC object type codes → readable names. */
export const TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '*': 'star',
  '**': 'double star',
  '*Ass': 'stellar association',
  OCl: 'open cluster',
  GCl: 'globular cluster',
  'Cl+N': 'cluster with nebula',
  G: 'galaxy',
  GPair: 'galaxy pair',
  GTrpl: 'galaxy triplet',
  GGroup: 'galaxy group',
  GClstr: 'galaxy cluster',
  PN: 'planetary nebula',
  HII: 'emission nebula (HII)',
  DrkN: 'dark nebula',
  EmN: 'emission nebula',
  Neb: 'nebula',
  RfN: 'reflection nebula',
  SNR: 'supernova remnant',
  Nova: 'nova',
  Other: 'other',
});

/** Search groups ("galaxy", "nebula", ...) → the type codes they cover. */
export const TYPE_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  galaxy: ['G', 'GPair', 'GTrpl', 'GGroup'],
  galaxy_cluster: ['GClstr', 'GGroup'],
  nebula: ['HII', 'EmN', 'Neb', 'RfN', 'Cl+N', 'SNR', 'DrkN'],
  emission: ['HII', 'EmN', 'Cl+N', 'SNR', 'PN'],
  planetary: ['PN'],
  cluster: ['OCl', 'GCl', 'Cl+N', '*Ass'],
  globular: ['GCl'],
  open_cluster: ['OCl'],
  supernova_remnant: ['SNR'],
  reflection: ['RfN'],
  dark: ['DrkN'],
  star: ['*', '**'],
});

/** The readable name of a type code (the code itself when unknown); only own keys, so "constructor" is not a type. */
export function typeName(code: string): string {
  return Object.hasOwn(TYPE_NAMES, code) ? TYPE_NAMES[code] : code;
}

/** The type codes of a search group (case-insensitive), or undefined when it is not a group. */
export function typeGroup(key: string): readonly string[] | undefined {
  const k = key.toLowerCase();
  return Object.hasOwn(TYPE_GROUPS, k) ? TYPE_GROUPS[k] : undefined;
}

/** 88 constellations: IAU abbreviation, name, genitive. */
export type Constellation = readonly [abbr: string, name: string, genitive: string];
export const CONSTELLATIONS: readonly Constellation[] = Object.freeze<Constellation[]>([
  ['And', 'Andromeda', 'Andromedae'], ['Ant', 'Antlia', 'Antliae'], ['Aps', 'Apus', 'Apodis'], ['Aqr', 'Aquarius', 'Aquarii'],
  ['Aql', 'Aquila', 'Aquilae'], ['Ara', 'Ara', 'Arae'], ['Ari', 'Aries', 'Arietis'], ['Aur', 'Auriga', 'Aurigae'],
  ['Boo', 'Bootes', 'Bootis'], ['Cae', 'Caelum', 'Caeli'], ['Cam', 'Camelopardalis', 'Camelopardalis'], ['Cnc', 'Cancer', 'Cancri'],
  ['CVn', 'Canes Venatici', 'Canum Venaticorum'], ['CMa', 'Canis Major', 'Canis Majoris'], ['CMi', 'Canis Minor', 'Canis Minoris'], ['Cap', 'Capricornus', 'Capricorni'],
  ['Car', 'Carina', 'Carinae'], ['Cas', 'Cassiopeia', 'Cassiopeiae'], ['Cen', 'Centaurus', 'Centauri'], ['Cep', 'Cepheus', 'Cephei'],
  ['Cet', 'Cetus', 'Ceti'], ['Cha', 'Chamaeleon', 'Chamaeleontis'], ['Cir', 'Circinus', 'Circini'], ['Col', 'Columba', 'Columbae'],
  ['Com', 'Coma Berenices', 'Comae Berenices'], ['CrA', 'Corona Australis', 'Coronae Australis'], ['CrB', 'Corona Borealis', 'Coronae Borealis'], ['Crv', 'Corvus', 'Corvi'],
  ['Crt', 'Crater', 'Crateris'], ['Cru', 'Crux', 'Crucis'], ['Cyg', 'Cygnus', 'Cygni'], ['Del', 'Delphinus', 'Delphini'],
  ['Dor', 'Dorado', 'Doradus'], ['Dra', 'Draco', 'Draconis'], ['Equ', 'Equuleus', 'Equulei'], ['Eri', 'Eridanus', 'Eridani'],
  ['For', 'Fornax', 'Fornacis'], ['Gem', 'Gemini', 'Geminorum'], ['Gru', 'Grus', 'Gruis'], ['Her', 'Hercules', 'Herculis'],
  ['Hor', 'Horologium', 'Horologii'], ['Hya', 'Hydra', 'Hydrae'], ['Hyi', 'Hydrus', 'Hydri'], ['Ind', 'Indus', 'Indi'],
  ['Lac', 'Lacerta', 'Lacertae'], ['Leo', 'Leo', 'Leonis'], ['LMi', 'Leo Minor', 'Leonis Minoris'], ['Lep', 'Lepus', 'Leporis'],
  ['Lib', 'Libra', 'Librae'], ['Lup', 'Lupus', 'Lupi'], ['Lyn', 'Lynx', 'Lyncis'], ['Lyr', 'Lyra', 'Lyrae'],
  ['Men', 'Mensa', 'Mensae'], ['Mic', 'Microscopium', 'Microscopii'], ['Mon', 'Monoceros', 'Monocerotis'], ['Mus', 'Musca', 'Muscae'],
  ['Nor', 'Norma', 'Normae'], ['Oct', 'Octans', 'Octantis'], ['Oph', 'Ophiuchus', 'Ophiuchi'], ['Ori', 'Orion', 'Orionis'],
  ['Pav', 'Pavo', 'Pavonis'], ['Peg', 'Pegasus', 'Pegasi'], ['Per', 'Perseus', 'Persei'], ['Phe', 'Phoenix', 'Phoenicis'],
  ['Pic', 'Pictor', 'Pictoris'], ['Psc', 'Pisces', 'Piscium'], ['PsA', 'Piscis Austrinus', 'Piscis Austrini'], ['Pup', 'Puppis', 'Puppis'],
  ['Pyx', 'Pyxis', 'Pyxidis'], ['Ret', 'Reticulum', 'Reticuli'], ['Sge', 'Sagitta', 'Sagittae'], ['Sgr', 'Sagittarius', 'Sagittarii'],
  ['Sco', 'Scorpius', 'Scorpii'], ['Scl', 'Sculptor', 'Sculptoris'], ['Sct', 'Scutum', 'Scuti'], ['Ser', 'Serpens', 'Serpentis'],
  ['Sex', 'Sextans', 'Sextantis'], ['Tau', 'Taurus', 'Tauri'], ['Tel', 'Telescopium', 'Telescopii'], ['Tri', 'Triangulum', 'Trianguli'],
  ['TrA', 'Triangulum Australe', 'Trianguli Australis'], ['Tuc', 'Tucana', 'Tucanae'], ['UMa', 'Ursa Major', 'Ursae Majoris'], ['UMi', 'Ursa Minor', 'Ursae Minoris'],
  ['Vel', 'Vela', 'Velorum'], ['Vir', 'Virgo', 'Virginis'], ['Vol', 'Volans', 'Volantis'], ['Vul', 'Vulpecula', 'Vulpeculae'],
]);

const CON_KEY = new Map<string, string>();
for (const [abbr, name, gen] of CONSTELLATIONS) for (const k of [abbr, name, gen]) CON_KEY.set(k.toLowerCase(), abbr.toLowerCase());

/** canonical 3-letter Bayer abbreviation, its symbol, and the spellings people (and catalogs) use */
const GREEK: readonly (readonly [abbr: string, symbol: string, spellings: readonly string[]])[] = [
  ['alp', 'α', ['alpha', 'alf']], ['bet', 'β', ['beta']], ['gam', 'γ', ['gamma']], ['del', 'δ', ['delta']],
  ['eps', 'ε', ['epsilon']], ['zet', 'ζ', ['zeta']], ['eta', 'η', []], ['the', 'θ', ['theta', 'tet']],
  ['iot', 'ι', ['iota']], ['kap', 'κ', ['kappa']], ['lam', 'λ', ['lambda', 'lmd']], ['mu', 'μ', []],
  ['nu', 'ν', []], ['xi', 'ξ', ['ksi']], ['omi', 'ο', ['omicron']], ['pi', 'π', []],
  ['rho', 'ρ', []], ['sig', 'σ', ['sigma']], ['tau', 'τ', []], ['ups', 'υ', ['upsilon']],
  ['phi', 'φ', []], ['chi', 'χ', []], ['psi', 'ψ', []], ['ome', 'ω', ['omega']],
];
const GREEK_KEY = new Map<string, string>();
const GREEK_SYMBOL = new Map<string, string>();
for (const [abbr, sym, alts] of GREEK) {
  for (const k of [abbr, sym, ...alts]) GREEK_KEY.set(k, abbr);
  GREEK_SYMBOL.set(abbr, sym);
}

/** "Alp", "alf", "alpha" → "α"; with an index ("alf02") → "α2". Undefined when not a Greek letter. */
export function greekSymbol(s: string): string | undefined {
  const m = /^([a-zα-ω.]+?)0*(\d?)$/.exec(s.toLowerCase());
  if (!m) return undefined;
  const abbr = GREEK_KEY.get(m[1]);
  return abbr === undefined ? undefined : `${GREEK_SYMBOL.get(abbr)}${m[2]}`;
}

// Catalog prefixes in the form normalised keys use; longer synonyms map onto these first. Each one
// only applies before a number, so a common name such as "Barnard's Loop" is left alone.
const PREFIX_SYNONYMS: readonly (readonly [RegExp, string])[] = [
  [/^messier\s*(?=\d)/, 'm'],
  [/^caldwell\s*(?=\d)/, 'c'],
  [/^(?:sharpless|sh)\s*2?\s*-\s*(?=\d)|^sh2\s*-?\s*(?=\d)|^sh\s*2\s+(?=\d)/, 'sh2-'],
  [/^(?:collinder|cl)\s*(?=\d)/, 'cr'],
  [/^melotte\s*(?=\d)/, 'mel'],
  [/^trumpler\s*(?=\d)/, 'tr'],
  [/^barnard\s*(?=\d)/, 'b'],
  [/^van\s*den\s*bergh\s*(?=\d)/, 'vdb'],
  [/^cederblad\s*(?=\d)/, 'ced'],
  [/^hickson\s*(?:compact\s*group\s*)?(?=\d)/, 'hcg'],
  [/^(?:abell\s*cluster|aco)\s*(?=\d)/, 'aco'],
];
const BAYER = /^(?:\d+\s*)?([a-zα-ω]+)[\s.-]*0*(\d?)\s+([a-z ]+)$/;
const FLAMSTEED = /^(\d+)\s+([a-z ]+)$/;
const NUMBERED = /^(m|ngc|ic|c|b|sh2-|ldn|lbn|vdb|mel|cr|tr|pgc|ugc|abell|aco|arp|rcw|ced|hcg|gum|hr|hd|hip|pal|stock|king|berkeley|czernik|dolidze)\s*0*(\d+)\s*([a-z]?)$/;

/** Lookup key for any designation or name: "M31", "m 31", "Messier 31" → "m31"; "NGC 0224" → "ngc224"; "α Lyr", "alpha Lyrae" → "alp lyr". */
export function normalizeName(s: string): string {
  let t = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [re, to] of PREFIX_SYNONYMS) {
    if (re.test(t)) {
      t = t.replace(re, to);
      break;
    }
  }
  const m = NUMBERED.exec(t);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  // Bayer: "alpha lyrae", "alf lyr", "α2 cap", "alp-2 cap", with an optional Flamsteed number before it.
  const b = BAYER.exec(t);
  if (b) {
    const letter = GREEK_KEY.get(b[1]);
    const con = CON_KEY.get(b[3]);
    if (letter !== undefined && con !== undefined) return `${letter}${b[2]} ${con}`;
  }
  const f = FLAMSTEED.exec(t);
  const fcon = f ? CON_KEY.get(f[2]) : undefined;
  if (f && fcon !== undefined) return `${Number(f[1])} ${fcon}`;
  return t.replace(/[^a-z0-9+-]+/g, ' ').trim();
}

/** OpenNGC's packed names: "NGC0224" → "NGC 224", "Sh2155" → "Sh2-155". */
export function prettyId(raw: string): string {
  const sh = /^Sh2-?(\d+)(.*)$/.exec(raw);
  if (sh) return `Sh2-${Number(sh[1])}${sh[2]}`;
  const m = /^([A-Za-z]+?)(\d+)(.*)$/.exec(raw);
  return m ? `${m[1]} ${Number(m[2])}${m[3]}` : raw;
}

/** True for catalog designations (as opposed to common names like "Orion Nebula"). */
export function isDesignation(s: string): boolean {
  return /^[A-Za-z][A-Za-z+]*(?: G)?\s?[-+]?\d/.test(s)
    || /^[α-ω]\d? [A-Z][A-Za-z]{2}$/.test(s)
    || /^\d+ [A-Z][A-Za-z]{2}$/.test(s)
    || (/^[a-z]+\d* [A-Z][A-Za-z]{2}$/.test(s) && greekSymbol(s.split(' ')[0]) !== undefined); // "gam Cyg"
}
