/**
 * Object designations: the one normalisation used for every lookup key, so "Messier 31", "m31",
 * "NGC 0224", "Sharpless 2-155", "alpha Lyrae" and "α Lyr" all land on the same object.
 * Shared by the runtime catalog and the catalog build tool (src/tools/build-catalog.ts).
 */

export const TYPE_NAMES: Record<string, string> = {
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
};

export const TYPE_GROUPS: Record<string, string[]> = {
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
};

/** 88 constellations: IAU abbreviation, name, genitive. */
export const CONSTELLATIONS: [string, string, string][] = [
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
];

const CON_KEY = new Map<string, string>();
for (const [abbr, name, gen] of CONSTELLATIONS) for (const k of [abbr, name, gen]) CON_KEY.set(k.toLowerCase(), abbr.toLowerCase());

/** canonical 3-letter Bayer abbreviation, its symbol, and the spellings people (and catalogs) use */
const GREEK: [string, string, string[]][] = [
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
  const m = s.toLowerCase().match(/^([a-zα-ω.]+?)0*(\d?)$/);
  const abbr = m ? GREEK_KEY.get(m[1]) : undefined;
  return abbr ? `${GREEK_SYMBOL.get(abbr)}${m![2]}` : undefined;
}

// Catalog prefixes in the form normalised keys use; longer synonyms map onto these first.
const PREFIX_SYNONYMS: [RegExp, string][] = [
  [/^messier\s*/, 'm'],
  [/^caldwell\s*/, 'c'],
  [/^(?:sharpless|sh)\s*2?\s*-\s*|^sh2\s*-?\s*|^sh\s*2\s+/, 'sh2-'],
  [/^(?:collinder|cl)\s*(?=\d)/, 'cr'],
  [/^melotte\s*/, 'mel'],
  [/^trumpler\s*/, 'tr'],
  [/^barnard\s*/, 'b'],
  [/^van\s*den\s*bergh\s*/, 'vdb'],
  [/^cederblad\s*/, 'ced'],
  [/^hickson\s*(?:compact\s*group\s*)?/, 'hcg'],
  [/^(?:abell\s*cluster|aco)\s*/, 'aco'],
];
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
  const m = t.match(NUMBERED);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  // Bayer: "alpha lyrae", "alf lyr", "α2 cap", "alp-2 cap", with an optional Flamsteed number before it.
  const b = t.match(/^(?:\d+\s*)?([a-zα-ω]+)[\s.-]*0*(\d?)\s+([a-z ]+)$/);
  if (b && GREEK_KEY.has(b[1]) && CON_KEY.has(b[3])) return `${GREEK_KEY.get(b[1])}${b[2]} ${CON_KEY.get(b[3])}`;
  const f = t.match(/^(\d+)\s+([a-z ]+)$/);
  if (f && CON_KEY.has(f[2])) return `${Number(f[1])} ${CON_KEY.get(f[2])}`;
  return t.replace(/[^a-z0-9+-]+/g, ' ').trim();
}

/** OpenNGC's packed names: "NGC0224" → "NGC 224", "Sh2155" → "Sh2-155". */
export function prettyId(raw: string): string {
  const m = raw.match(/^([A-Za-z]+?)(\d+)(.*)$/);
  if (!m) return raw;
  const prefix = m[1] === 'Sh2' ? 'Sh2-' : `${m[1]} `;
  return `${prefix}${Number(m[2])}${m[3]}`;
}

/** True for catalog designations (as opposed to common names like "Orion Nebula"). */
export function isDesignation(s: string): boolean {
  return /^[A-Za-z][A-Za-z+]*(?: G)?\s?[-+]?\d/.test(s)
    || /^[α-ω]\d? [A-Z][A-Za-z]{2}$/.test(s)
    || /^\d+ [A-Z][A-Za-z]{2}$/.test(s)
    || (/^[a-z]+\d* [A-Z][A-Za-z]{2}$/.test(s) && greekSymbol(s.split(' ')[0]) !== undefined); // "gam Cyg"
}
