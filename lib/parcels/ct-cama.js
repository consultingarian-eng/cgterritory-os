'use strict';
// Connecticut — statewide CAMA + parcel layer (CT OPM / CT Geodata Portal,
// all 169 towns, CC0). One record per assessed unit of land: houses are one
// polygon each, condo units are one record each with a tiny or stacked
// polygon and no shared master key, so they are NOT grouped here — the join
// in parcels.js sums them by the OSM building that contains them.
//
// Every lot in the hull comes back (the query is no longer limited to
// State_Use 1xxx): homes with u ≥ 1 and a normalised `cls`, and every lot
// that holds no home as a SUPPRESSOR { u: 0, cls, ring } so an OSM building
// drawn on a vacant / commercial / garage lot is not a door (parcels.js §7).
//
// Unit rule (design §1.4) is per town, because the towns code differently:
//   Meriden      — codes look like '102.0'; the code alone gives the count
//                  (Occupancy is not a unit count there: 1,155 single-family
//                  rows carry Occupancy 3).
//   North Haven  — the 3-digit state scheme (100 res, 200 comm, 300 ind, 400
//                  utility, 500 vacant, 600 use-assessment); on '100'
//                  Occupancy is the count, 0/null = no dwelling → vacant.
//   every other  — Vision: Occupancy when ≥ 1 (verified 1040→2, 1050→3,
//                  1110→4, 1111→5-8, 1120→8-716), else a band floor by code.
// u is the raw count; a block whose count is unknown is u=1 + big=true and
// the cap in parcels.js turns anything above UNIT_CAP into one flagged door.
// Those three rules are unchanged; classify() below only decides which lots
// reach them (the residential family: State_Use 1xxx, Meriden 800) and what
// every other lot is.
//
// Class (cls) — 169 towns, ~170 code schemes, so the assessor's own
// State_Use_Description carries the decision wherever the code is ambiguous:
//   condo   1020/102x (Vision), Meriden 105, Parcel_Type Condo_Unit/CONDO/
//           Condominium, or a 'Condo' description — one record per unit as before
//   apt     11xx (1110, 1111/111C, 1120/112C, 1121 …), 108C/108R, boarding /
//           student housing, Meriden 800.0, and 'Apartment' lots coded
//           outside 1xxx (800/801.0/814 …: Occupancy when ≥ 1, else big)
//   mixed   3030/303x, 013/031, 203/204 'Comm Res', 'Retail/Res' …: Occupancy
//           when ≥ 1 (approx — it counts the shop too), Meriden one door
//   res     everything else the unit rules accept
//   vacant  13xx, 106x outbuildings, 1080 accessory land, V-suffixed codes,
//           5xx, bare '100' with no dwelling, and any 'Vacant'/'Land'/'MDL-00'
//   commercial / industrial / institutional (9xx) / garage / parking / other
//           (condo masters 995/CONDOMAIN, farm and forest land, open space)
// A lot outside 1xxx whose description reads like a home (Westport codes
// single-family 201, Bridgeport housing-authority homes 94x, Burlington's
// '1080 1/2 Duplex') gets NO record: this adapter has no count for it, and
// a suppressor would delete a real door. OSM keeps its one door as before.
// The same holds when the assessor's own building record contradicts the
// class — hasDwelling(): a '100 Residential' lot with Occupancy 0 but six
// bedrooms (New Canaan), a '500 Vacant Land' lot with a 2015 house on it
// (Cheshire's Prinz Ct), a '600 Use Assessment' farm with the farmhouse
// (Durham). Those are not suppressors either. Only the policy classes —
// condo masters, garages, parking, institutions — suppress regardless.
//
// One dwelling can come as two records (a lot split by a town line is on
// both towns' rolls; Meriden lists some trailer-park pads twice) — dedupe()
// below keeps one, because the join would sum both into the same door.

const { arcgisAll, ringInfo, ringArea, int, str, splitAddress } = require('../parcels_common');
const { distM } = require('../geo');

const URL = 'https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0/query';
// Every lot in the hull: homes are counted, the rest suppress. (Was
// State_Use LIKE '1%' OR '800.0' — which also hid North Haven's 200-600 codes.)
const WHERE = '1=1';
const OUT = ['OBJECTID', 'Town_Name', 'Parcel_ID', 'Location', 'Location_1', 'ZIP_CODE', 'State_Use', 'State_Use_Description', 'Occupancy', 'Model', 'Parcel_Type', 'Living_Area', 'Number_of_Bedroom'];
const MAX_RING = 12;

// Suffix spellings the CT towns use that the shared normaliser does not know
// (Hamden 'LA' for Lane and 'CR' for Circle, 'TR' for Terrace …). Applied to
// the raw line before splitAddress so 'BEECHWOOD LA' and OSM's 'Beechwood
// Lane' share a key.
const CT_SUFFIX = { LA: 'LN', CR: 'CIR', CI: 'CIR', CIRC: 'CIR', TR: 'TER', TERR: 'TER', BL: 'BLVD', HW: 'HWY', PKY: 'PKWY', PW: 'PKWY', TP: 'TPKE', TPK: 'TPKE', TNPK: 'TPKE', EX: 'EXT', EXTN: 'EXT', CRT: 'CT', DRV: 'DR', STR: 'ST', AVEN: 'AVE', HGTS: 'HTS', HT: 'HTS', SQR: 'SQ', LNDG: 'LANDING', XING: 'CROSSING' };
// Locality tags some towns append after the suffix ('146 EXAMPLE ST SM' =
// South Meriden); they are not part of the street name.
const LOCALITY_TAIL = { Meriden: new Set(['SM']) };

// ── Per-town unit rules ─────────────────────────────────────────────────────
// Each returns { u, approx, big, bldgs } or null to drop the record.
const one = { u: 1, approx: false, big: false, bldgs: 1 };
const unknownBlock = { u: 1, approx: true, big: true, bldgs: 1 };
const exact = (u, bldgs = 1) => ({ u, approx: false, big: false, bldgs });
const floor = (u, bldgs = 1) => ({ u, approx: true, big: false, bldgs });

// Meriden: '101.0' style. Occupancy is ignored on purpose.
function meridenRule(code) {
  switch (parseInt(code, 10)) {
    case 101: case 106: return one;            // dwelling; manufactured home
    case 105: return one;                      // condominium — one record per unit
    case 102: case 107: return exact(2);       // two family; single with in-law
    case 103: return exact(3);
    case 104: return exact(4);
    case 800: return unknownBlock;             // 'Comm Apts' — the apartment blocks, count not given
    default: return null;                      // 100 vacant, 108/109 vacant with outbuilding, anything else
  }
}

// North Haven: on '100' Occupancy is the count, 0/null = no dwelling.
function northHavenRule(occ) {
  return occ >= 1 ? exact(occ) : null;
}

// Every other town: Occupancy first, else a band floor by code prefix.
// Vision towns (Hamden, New Haven, Wallingford …) use 4-char codes; the
// 3-digit towns (Middletown, Southington, Cheshire) disagree with each other
// on what '102' means but all fill Occupancy, so the count path is the same.
function visionRule(code, occ, parcelType) {
  const c = code.toUpperCase();
  const p2 = c.slice(0, 2), p3 = c.slice(0, 3), p4 = c.slice(0, 4);
  // no dwelling: outbuilding, accessory land, vacant (13xx and the 'V' model
  // suffix), condo master, condo parking/garage/development rights, res garage
  if (p3 === '106' || p4 === '1080' || p2 === '13' || c === '995' || /V$/.test(c)) return null;
  if (p4 === '1023' || p4 === '102G' || p4 === '102P' || p4 === '102A' || c === '115') return null;
  if (c === '100') return northHavenRule(occ);                            // bare 'Residential' (Cheshire, Middletown vacant): Occupancy is the count
  // Vision condo unit (1020/1021/102x) or a New Haven Condo_Unit row: one
  // record each, whatever Occupancy says. Only 4-char codes: Middletown's
  // 3-digit '102' is a two-family, Southington's a condo, and both fill Occupancy.
  if ((p3 === '102' && c.length === 4) || parcelType === 'CONDO_UNIT') return one;
  if (occ >= 1) return exact(occ, p4 === '1090' ? 2 : 1);
  switch (p4) {
    case '1012': return exact(2);                                         // single family + attached ADU
    case '1040': return exact(2);
    case '1050': return exact(3);
    case '1090': return floor(2, 2);                                      // several houses on one lot
    case '1110': return exact(4);
    case '1111': case '111C': return floor(5);                            // APT 5-8
    case '1250': return floor(1);                                         // group home
    default: break;
  }
  if (p4 === '108C' || p4 === '108R') return unknownBlock;                // Middletown 'Apartments'
  if (p2 === '10') return one;                                            // 1010, 1011, 1013, 1014, 103U … single family variants
  if (p3 === '112' || p2 === '11') return unknownBlock;                   // 1120/112C over 8, 1121 subsidised, 1112 co-op, 1100 …
  if (p3 === '121' || p3 === '123') return unknownBlock;                  // boarding / rooming / student housing
  return null;                                                            // other 12xx and unknown codes: no count, let OSM default to 1
}

function unitsFor(town, code, occ, parcelType) {
  if (town === 'Meriden') return meridenRule(code);
  if (town === 'North Haven') return northHavenRule(occ);
  return visionRule(code, occ, str(parcelType).toUpperCase());
}

// ── Classification ──────────────────────────────────────────────────────────
// Parcel_Type spellings collapse to one key: 'Condo_Unit' / 'CONDO UNIT' /
// 'Condo Units' → CONDOUNIT(S), 'CONDO MAIN' / 'Condo_Main' → CONDOMAIN.
const ptKey = v => str(v).toUpperCase().replace(/[\s_]+/g, '');
const CONDO_PT = new Set(['CONDO', 'CONDOUNIT', 'CONDOUNITS', 'CONDOMINIUM', 'CONDOMINIUMS']);

// The assessor's description, upper-cased. Each pattern names what the
// towns actually write (see the header): they are tested in a fixed order.
const MIXED_RE   = /MIX|MULTI[- ]?USE|\bMU\b|COMM?\.? ?\/ ?RES|RES\.? ?\/ ?COMM?|RETAIL ?\/ ?(RES|APT)|STORE ?\/ ?APTS?|OFFICE ?\/ ?RES|RES ?\/ ?(OFFICE|RETAIL)|COMM? ?& ?APART|APART ?\/ ?COMM?|\bCOMM? RES\b|\bRES COMM?\b|COM LAND W\/ RES|STRIP RETAIL\/RES/;
const VACANT_RE  = /VAC|UNBUILD|UNBLD|UNDEV|UNIMPROV|ACRE|EXCESS|WETLAND|\bLAND\b|\bLND\b|\bLD\b|\bREAR\b|DEVELO|POT(ENTIAL)? ?DEV|OUTB|O\.B\.|\bOBY?\b|ACLN|ACCLND|MDL-?00\b|\bM-?00\b|\bM00\b/;
// A home this adapter has no unit rule for: never a suppressor. ('Manufactured
// Home' is caught by HOME; 'MANUFAC' alone is a factory.)
const HOME_RE    = /SINGLE|ONE FAM|\b[1-6][ -]?FAM|(TWO|THREE|FOUR|FIVE|SIX)[- ]?FAM|DUPLEX|DWELL|\bSFR\b|\bSFD\b|\bSFAM\b|MOBILE|MOBL|\bMH\b|M HOME|TRAILER|IN-? ?LAW|CLERGY|PARSONAGE|RECTORY|RESIDENCE|\bHOME\b|\bHOUSE|\bHSES|\bPUD\b|PLANNED (COMM|DEV)|RES COMMUNITY|\bADU\b|\bRES\b|RESID(ENT|ENTIAL|ENTL)?\b/;
const NOT_HOME   = /GROUP HOME|NURSING|REST HOME|FUNERAL/;   // institutions that say 'home'
const APT_RE     = /\bAPT|APART|\bUNITS\b|WALK ?UP|MULTI ?-?FAM|\bMULTIFAM/;
const PARKING_RE = /PARKING|PARK(ING)? ?LOTS?\b|CONDO[- ]?PARK|PARK ?SP/;
const GARAGE_RE  = /GARAGE|\bGAR\b/;
const NOT_GARAGE = /SHOP|REPAIR|WKSHP/;                     // 'Com Garage Shop', 'Res Garage/Wkshp' are not car barns
const BOAT_RE    = /DOCKOMIN|RACKOMIN|BOAT SLIP|\bSLIP\b/;    // dock and rack "condos" are not doors
const INSTIT_RE  = /EXEMPT|EXMPT|MUNICIP|\bMUN\b|\bSTATE\b|\bTOWN\b|\bCITY\b|CHURCH|RELIG|SCHOOL|UNIV|COLLEGE|HOSPITAL|CEMET|NON-? ?PROFIT|CHARIT|GOV|HSNG AUTH|HOUSING AUTH|\bFIRE\b|LIBRARY/;
const INDUST_RE  = /\bIND|INDUST|MANUF|\bMFG\b|WHSE|WAREHOUSE|FACTORY|UTIL|ELEC|TELE|\bTEL\b|RAIL|STORAGE|STGE|SAND|GRAVEL|JOB SHOP|CELL SITE|RAD\/TV|SUBSTA/;
const LAND_RE    = /FOREST|WOOD|TILL|PASTURE|ORCHARD|FARM|OPEN ?SP|OP\. ?SP|WATERSHED|USE ASS|490|GOLF|MARINA|CONSERV|\bWATER\b|\bROW\b|RIGHT.OF.WAY|SWAMP|BEACH|DOCK|RACK/;
const COMM_RE    = /COMM|\bCOM\b|STORE|RETAIL|OFFICE|\bOFF\b|BANK|REST|CLUB|GAS|AUTO|CAR WASH|MOTEL|HOTEL|SHOP|MEDICAL|PROF|DAY CARE|FUNERAL|BILLBOARD|PLAZA|MALL|SERVICE/;

// firm: a policy class that suppresses even where the assessor records a
// dwelling (condo masters, garages, parking, institutions). Every other
// suppressor is read off the code and yields to hasDwelling() in fetch().
const sup = (cls, firm = false) => ({ cls, u: 0, firm });

// A one-record-per-unit condo row (never deduped: stacked units share a
// polygon). Mobile-home parks are drawn condo-style in some towns and are
// not condos.
function isCondoUnit(town, code, parcelType, desc = '') {
  if (town === 'Meriden') return parseInt(code, 10) === 105;
  const c = code.toUpperCase(), D = str(desc).toUpperCase();
  if (/MOBILE|MOBL|\bMH\b|M HOME|TRAILER|MFG|MANUF/.test(D)) return false;
  if ((c.slice(0, 3) === '102' && c.length === 4) || CONDO_PT.has(ptKey(parcelType))) return true;
  return /CONDO/.test(D) && !/MAIN|GAR|PARK|VAC|DEV|COMM|OFF|IND|RTL|RETAIL|PROF|MED|OPTION|\bOB\b/.test(D);
}

// 'res' | 'condo' | 'apt' for a lot the unit rules accepted.
function homeClass(town, c, parcelType, D, rule) {
  if (isCondoUnit(town, c, parcelType, D)) return 'condo';
  const p2 = c.slice(0, 2), p3 = c.slice(0, 3), p4 = c.slice(0, 4);
  if (rule.big || p2 === '11' || p4 === '108C' || p4 === '108R' || p3 === '121' || p3 === '123' || APT_RE.test(D)) return 'apt';
  return 'res';
}

// Mixed-use and apartment lots coded outside the residential family.
const mixedRule = (town, occ) => town !== 'Meriden' && occ >= 1 ? { u: occ, approx: true, big: false, bldgs: 1 } : floor(1);
const aptRule   = (town, occ) => town !== 'Meriden' && occ >= 1 ? exact(occ) : unknownBlock;

// State_Use 1xxx (and Meriden 800): the unit rules decide whether a home is
// here; a lot they refuse is classed for suppression, or gets no record.
function resFamily(town, c, occ, parcelType, D) {
  if (PARKING_RE.test(D)) return sup('parking', true);
  if (GARAGE_RE.test(D) && !NOT_GARAGE.test(D)) return sup('garage', true);   // '108.0 CONDO GARAGE', '1030 Condo Gar'
  if (BOAT_RE.test(D)) return sup('other', true);
  if (MIXED_RE.test(D)) return { cls: 'mixed', ...mixedRule(town, occ) };  // Middlebury '115 Res/Comm'
  const rule = unitsFor(town, c, occ, parcelType);
  if (rule) return { cls: homeClass(town, c, parcelType, D, rule), ...rule };
  const p2 = c.slice(0, 2), p3 = c.slice(0, 3);
  const vacantish = VACANT_RE.test(D) || /V$/.test(c);
  if (/^100(\.0)?$/.test(c)) return sup('vacant');                       // bare 'Residential' with no dwelling (North Haven, Cheshire, Middletown)
  if (HOME_RE.test(D) && !NOT_HOME.test(D) && !vacantish) return null;   // a home the count rule does not know: leave OSM's door alone
  if (vacantish || p2 === '13' || p3 === '106' || c === '1080' || /^100[124]$/.test(c) || c === '1061') return sup('vacant');
  if (/DEV RIGHTS|COMMON|\bHOA\b|ASSOC|OPEN/.test(D)) return sup('other');
  return null;                                                           // unknown residential code with no count: no record, OSM defaults to one door
}

// Every other State_Use.
function nonRes(town, c, occ, D) {
  if (MIXED_RE.test(D)) return { cls: 'mixed', ...mixedRule(town, occ) };
  const vacantish = VACANT_RE.test(D) || /V$/.test(c);
  if (HOME_RE.test(D) && !NOT_HOME.test(D) && !vacantish) return null;   // Westport '201 Single Family Res', Bridgeport '941 Hsng Auth 1 Family' …
  const d = c.replace(/^0+/, '')[0] || '';
  if (vacantish || d === '5') return sup('vacant');
  if (APT_RE.test(D)) return { cls: 'apt', ...aptRule(town, occ) };     // '800 Apartment', '814 Comm Apts', '940 Hsng Auth Multifam'
  if (PARKING_RE.test(D)) return sup('parking', true);
  if (GARAGE_RE.test(D) && !NOT_GARAGE.test(D)) return sup('garage', true);
  if (d === '9' || INSTIT_RE.test(D)) return sup('institutional', true);
  if (INDUST_RE.test(D) || d === '4') return sup('industrial');
  if (LAND_RE.test(D) || d === '6' || d === '7' || d === '8') return sup('other');
  if (d === '2' || d === '3' || COMM_RE.test(D)) return sup('commercial');
  return /^\d/.test(d) ? sup('other') : null;                            // a code that is not a number and says nothing: no record
}

// → { cls, u, approx, big, bldgs } for a home, { cls, u: 0 } for a
// suppressor, null for no record.
function classify(town, code, occ, parcelType, desc) {
  let c = str(code).toUpperCase();
  const pt = ptKey(parcelType), D = str(desc).toUpperCase();
  // condo masters first: '995' is stamped Condo_Unit in one town, and North
  // Haven's carry no State_Use at all
  if (pt === 'CONDOMAIN' || c === '995' || /CONDO ?MAIN/.test(D)) return sup('other', true);
  if (pt === 'CONDOGARAGE') return sup('garage', true);
  if (!c) return null;
  if (/^0\d{3}$/.test(c)) c = c.slice(1);                                 // Canterbury / West Haven '0101' = '101'
  if (c[0] === '1' || (town === 'Meriden' && parseInt(c, 10) === 800)) return resFamily(town, c, occ, parcelType, D);
  return nonRes(town, c, occ, D);
}

// The assessor's own dwelling record on a lot the class rules would suppress:
// living area with bedrooms, or any living area on a residential-coded lot
// (1xxx — a new build or a pool house carries 0 bedrooms, but a 'Residential'
// lot with living space holds something OSM may well have drawn as a house).
// Commercial lots report gross floor area as Living_Area, so bedrooms are
// required there. Measured statewide: 24,127 bare-'100' lots have Occupancy
// 0/null and 1,283 of them carry a building; 5,200 lots with bedrooms and
// living area sit on codes that suppress.
function hasDwelling(a, resCoded) {
  return +a.Living_Area > 0 && (resCoded || int(a.Number_of_Bedroom) > 0);
}

// ── Geometry ────────────────────────────────────────────────────────────────
// Visvalingam thinning: drop the vertex whose triangle with its neighbours is
// smallest until the ring has at most `max` vertices. Closing vertex removed.
function thinRing(ring, max) {
  let r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  const tri = (a, b, c) => Math.abs((b[1] - a[1]) * (c[0] - a[0]) - (c[1] - a[1]) * (b[0] - a[0]));
  while (r.length > max) {
    let worst = -1, min = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = tri(r[(i + r.length - 1) % r.length], r[i], r[(i + 1) % r.length]);
      if (a < min) { min = a; worst = i; }
    }
    r.splice(worst, 1);
  }
  return r.length >= 3 ? r : null;
}

// ── Address ─────────────────────────────────────────────────────────────────
function addressOf(a) {
  // '130 1/2 EXAMPLE ST' → '130 EXAMPLE ST' (the fraction is not two more street numbers)
  const line = (str(a.Location) || str(a.Location_1)).replace(/^(\d+[A-Z]?)\s+\d+\/\d+(?=\s)/i, '$1');
  if (!line) return { nums: [], street: '' };
  const toks = line.toUpperCase().replace(/[.,]/g, '').split(/\s+/);
  const tail = LOCALITY_TAIL[str(a.Town_Name)];
  if (tail && toks.length > 2 && tail.has(toks[toks.length - 1])) toks.pop();
  for (let i = toks.length - 1; i > 0; i--) if (CT_SUFFIX[toks[i]]) { toks[i] = CT_SUFFIX[toks[i]]; break; }
  return splitAddress(toks.join(' '));
}

// ── Duplicates ──────────────────────────────────────────────────────────────
// The layer carries two records for one dwelling in two cases, and the join
// would sum both into the same door:
//   (a) a lot split by a town line is on both towns' rolls, each half with
//       the house's address and a dwelling code (e.g. along a town line,
//       where a small sliver of the lot is coded 'Two Family, Occupancy 2');
//   (b) some towns' trailer-park pads (code 106.0) come twice
//       with the same polygon and the same address line.
// (a) keeps the ZIP's own town, else the bigger half, with the larger count;
// (b) keeps the first. Condo unit rows are never touched: they share a
// polygon by design and the join counts one per record. Suppressors never
// come here: a duplicate suppressor ring suppresses the same thing twice.
const SPLIT_M = 60;   // the join's own address-match tolerance
function dedupe(recs, homeTown) {
  const dropped = new Set();
  const exact = new Map();
  for (const r of recs) {
    if (r.condo || !r.p.ring) continue;
    const k = `${r.town}|${r.loc}|${r.p.kind}|${r.p.ring.join(';')}`;
    if (exact.has(k)) dropped.add(r); else exact.set(k, r);
  }
  const byAddr = new Map();
  for (const r of recs) {
    if (dropped.has(r) || !r.p.street || !r.p.nums.length) continue;
    const k = `${r.p.nums[0]}|${r.p.street}`;
    (byAddr.get(k) || byAddr.set(k, []).get(k)).push(r);
  }
  for (const group of byAddr.values()) {
    if (group.length < 2 || new Set(group.map(r => r.town)).size < 2) continue;
    group.sort((a, b) => (b.town === homeTown) - (a.town === homeTown) || b.area - a.area);
    const kept = [];
    for (const r of group) {
      const twin = kept.find(k => k.town !== r.town && distM(k.p.lat, k.p.lng, r.p.lat, r.p.lng) <= SPLIT_M);
      if (!twin) { kept.push(r); continue; }
      twin.p.u = Math.max(twin.p.u, r.p.u); twin.p.big = twin.p.big || r.p.big; twin.p.approx = twin.p.approx || r.p.approx;
      dropped.add(r);
    }
  }
  return recs.filter(r => !dropped.has(r)).map(r => r.p);
}

// ── Fetch ───────────────────────────────────────────────────────────────────
async function fetch(zip, { hull, envelope, meta }) {
  let feats = await arcgisAll(URL, { where: WHERE, outFields: OUT, ring: hull, oid: 'OBJECTID', pageSize: 2000 });
  if (!feats.length && envelope) feats = await arcgisAll(URL, { where: WHERE, outFields: OUT, envelope, oid: 'OBJECTID', pageSize: 2000 });

  const seen = new Set();
  const homes = [];          // through dedupe()
  const suppressors = [];    // straight out: small records, ring required
  for (const f of feats) {
    const a = f.attributes || {};
    const id = String(a.OBJECTID ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const town = str(a.Town_Name), code = str(a.State_Use);
    const k = classify(town, code, int(a.Occupancy), a.Parcel_Type, a.State_Use_Description);
    if (!k) continue;
    const g = ringInfo(f.geometry);
    if (!g) continue;
    const ring = g.ring ? thinRing(g.ring, MAX_RING) : null;
    const kind = code || ptKey(a.Parcel_Type);
    const { nums, street } = addressOf(a);
    if (!(k.u >= 1)) {
      // the class says no home, the assessor lists one: no record, OSM keeps its door
      if (!k.firm && hasDwelling(a, /^0?1/.test(code))) continue;
      if (ring) suppressors.push({ id, lat: g.lat, lng: g.lng, ring, nums, street, u: 0, cls: k.cls, kind });
      continue;
    }
    homes.push({
      p: { id, lat: g.lat, lng: g.lng, ring, nums, street, u: k.u, cls: k.cls, kind, approx: k.approx, big: k.big, bldgs: k.bldgs },
      town, loc: (str(a.Location) || str(a.Location_1)).toUpperCase(),
      condo: k.cls === 'condo', area: g.ring ? Math.abs(ringArea(g.ring)) : 0,
    });
  }
  return dedupe(homes, str(meta?.municipality || meta?.city)).concat(suppressors);
}

module.exports = {
  name: 'ct-cama',
  attribution: 'Connecticut Office of Policy and Management / CT Geodata Portal — statewide parcel and CAMA data (CC0)',
  rollNote: 'CT statewide CAMA layer; towns submit annually (refreshed each September)',
  fetch,
  // exported for unit tests
  _rules: { unitsFor, meridenRule, northHavenRule, visionRule, isCondoUnit, classify, hasDwelling, thinRing, addressOf, dedupe },
};
