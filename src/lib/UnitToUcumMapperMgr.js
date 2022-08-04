
// This module manages a set of unit to ucum converters (called mappers here). There are three
// prebuilt mappers, and more mappers may be registered through the registerMapper function.
// This module uses LHC ucum validator to check the unit first, and invokes the mappers only
// when the given unit is not a ucum unit.
//
// At the top level, this module exports only one function, getUcumMapperMgr, which is a hash with
// the following functions (fields):
//     mapToUcum: convert the given unit to ucum, trying all registered mappers until suceeded. Params:
//       - unit, required, the unit to convert to ucum.
//       - opts, optional, the only predefined field is isCI (case insensitive), but other options
//         may be defined and will be ignored by those mappers that don't know about it.
//       - return: a hash with two fields:
//                 == status: missing, valid, invalid, one of the mapping types in ucumMappingFunctions.
//                 == ucum: populate only if the given unit is ucum or can be mapped to a ucum
//     mapWith: similar to the mapToUcum, but will only try the given list of mappers (by name). Params:
//       - mappers: a list of mapper names (see registerMappers below)
//       - for parameters unit, opts, and the return, see mapToUcum
//     registerMapper: register a named unit to ucum mapper. Params:
//       - mapperName: the name you give to the mapper
//       - mapperFunc: the mapper function that takes two parameters:
//         == unit: ee mapToUcum
//         == opts: see mapToUcum
//         == return: returns the converted ucum unit or null
//     getMapperNames: returns the list of all known mapper names. Pre-registered mappers are:
//       - map_direct: a simple mapper using the unit-to-ucum sheet, see combined-unit-mapping file below
//       - map_unit_prop: a mapper using the unit-ucum-properties sheet, see combined-unit-mapping file below
//       - map_regex: a simple, regex-based mapping for various spelling of hours,etc.
//       -- you can register a mapper using the registerMapper function.
//
// This module requires the combined unit mapping file (passed in to the getUcumMapperMgr function):
//   combined-unit-mapping-xxxxx.xlsx (where the xxxx indicates versions/dates, etc.)
// from which the following tabs are used:
// - unit-to-ucum: some 470 entries of direct mapping, from loinc-mapping-validator/data/unit_to_ucum_mapping.json
// - unit-ucum-properties: a unit, property, ucum 3-way maping file


const UcumMapperMgr = {}; // To be populated on first invocation of getUcumMapperMgr.

const {getXlsxSheetJson, delimitedToList, addToValueList} = require('./common');

const ucumUtil = require('@lhncbc/ucum-lhc').UcumLhcUtils.getInstance();
const validateUcum = (unit) => ucumUtil.validateUnitString(unit);


// ======== regex-based ucum to unit mapping ===============
const dayTo24hRegex = /^(.*)\bday\b(.*)/i;
const dotHourRegex = /^([^\d]*)(\d+)([ ]*(h|hr|hour)[sS]?\b)(.*)$/i;
const hourRegex = /^(.*)((HR|Hr|hr|HOUR|Hour|hour)[sS]?)(.*)$/i;
const spaceHRegex = /^([^\d]*)(\d+)[ ]+h$/;

function regexMapper(fromUnit) {
  let result = null;
  if(fromUnit.match(dayTo24hRegex)) {
    result = fromUnit.replace(dayTo24hRegex, '$1(24.h)$2')
  }
  else if(fromUnit.match(dotHourRegex)) {
    result = fromUnit.replace(dotHourRegex, '$1($2.h)$5');
  }
  else if(fromUnit.match(hourRegex)) {
    result = fromUnit.replace(hourRegex, '$1h$4');
  }
  //else if(fromUnit.match(spaceHRegex)) {
  //  result = fromUnit.replace(spaceHRegex, '$1($2.h)');
  //}

  if(! result && fromUnit.indexOf(' ') >= 0) {
    let noSpace = fromUnit.replace(/ /g, '');
    result = regexMapper(noSpace) || null;
  }
  return result;
}


// ======== Direct Mapping ===============
// Get the "direct mapping" function that uses the small unit-to-ucum tab to perform
// direct mapping. The returned function takes two parameters:
// - unit: the unit to convert to ucum, required
// - isCI: whether the mapping is case insensitive, optional default to false
function getDirectMapper(combinedUnitMappingXlsx) {
  let _directUnit2Ucum = {}, _directUnit2UcumCI = {};
  getXlsxSheetJson(combinedUnitMappingXlsx, 'unit-to-ucum').forEach((row, rowNum) => {
    row.UNIT = row.UNIT + ''; row.UCUM = row.UCUM + '';  // could be numbers
    // checkUcum(row.UCUM, 'unit-to-ucum #' + (rowNum + 2));
    _directUnit2Ucum[row.UNIT] = row.UCUM;
    _directUnit2UcumCI[row.UNIT.toUpperCase()] = row.UCUM;
  });

  function toUcumDirect(unit, opts) {
    let isCI = opts && opts.isCI || false;
    let altUnit = isCI? _directUnit2UcumCI[unit.toUpperCase()]: _directUnit2Ucum[unit];
    return altUnit && altUnit !== unit? altUnit: null;
  }

  return toUcumDirect;
}


// ======== Mapping with Regnestrief's unit-ucum-properties table ===========
// Get the ucum mapping fuction that uses the unit-ucum-proprties tab (from RI) to perform
// the unit to ucum mapping. The returned function takes two parameters:
// - unit: the unit to convert to ucum, required
// - isCI: whether the mapping is case insensitive, optional default to false
function getRIucumMapper(combinedUnitMappingXlsx) {
  let riUnitToUcum = loadUnitToUcumFromUnitToProps(combinedUnitMappingXlsx);
  let riUnitToUcumCI = {}; // see unitToUcum, case insensitive here
  Object.keys(riUnitToUcum).forEach(key => {
    riUnitToUcum[key] = riUnitToUcum[key][0]; // picking the first, hopefully the only one there
    riUnitToUcumCI[key.toUpperCase()] = riUnitToUcum[key];
  });

  function toUcumUnitProp(unit, opts) {
    let isCI = opts && opts.isCI || false;
    let altUnit = isCI? riUnitToUcumCI[unit.toUpperCase()]: riUnitToUcum[unit];
    return altUnit && altUnit !== unit? altUnit: null;
  }

  return toUcumUnitProp;
}


/**
 * Get the unit to ucum mapper manager, which manages a list of mappers and has functions to perform unit
 * to ucum mapping. New mappers may be added via the registerMapper()function, but known mappers are as follows:
 * - map_direct: a straight unit to ucum mapping based on the "unit-ucum" sheet in the combined-mapping-files.xlsx
 * - map_unit_prop: mapping based on the entries in the unit-ucum-properties sheet in the combined-mapping-files.xlsx
 * - map_regex: a regex based mapping for units like "mg/24 hour" to "mg/(24.h)"
 * - map_rule_based: exists only if the getLoincParts parameter is specified (see getLoincParts parameter below),
 *                   this is PCORNET-specific rule based unit mapping (or correction).
 *  Check the function mapToUcum(), mapWith() for further details.
 * @param combinedUnitMappingXlsx the Excel file that has 3 sheets related to unit to ucum conversion:
 *        - unit-ucum: a straight one-to-one mapping
 *        - unit-ucum-properties: 3-way mapping for unit, ucum, LOINC property, here we only care about the unit to ucum part
 * @param getLoincParts optional, a function that takes a loinc# as the only parameter and returns a hash of loinc parts,
 *        or null if not found. If specified, the map_rule_based mapper, which is PCORNET-specific, will be added.
 * @return the unit to ucum mapper manager object.
 */
// This function should be called once.
function getUcumMapperMgr(combinedUnitMappingXlsx, getLoincParts) {
  if(UcumMapperMgr.registry) {
    return UcumMapperMgr;
  }

  // By default, register these 3 types of mappers (names and their handler functions)
  UcumMapperMgr.registry = {
    map_direct: getDirectMapper(combinedUnitMappingXlsx),
    map_unit_prop: getRIucumMapper(combinedUnitMappingXlsx),
    map_regex: regexMapper
  }

  // If getLoincParts function is provided, also register the PCORNET-specific, rule-based unit mapping/correction.
  if(getLoincParts) {
    //UcumMapperMgr.registry['map_rule_based'] = (unit, opts) => ruleBasedUnitToUcum(unit, opts, getLoincParts);
    UcumMapperMgr.registry['map_rule_based'] = getRuleBasedUnitToUcumMapper(getLoincParts);
  }

  Object.assign(UcumMapperMgr, {
    mapToUcum,
    mapWith,
    registerMapper: (mapperName, mapperFunc) => { UcumMapperMgr.registry[mapperName] = mapperFunc; },
    getMapperNames: () => Object.keys(UcumMapperMgr.registry)
  });

  return UcumMapperMgr;
}

/**
 * Convert the given unit to ucum, trying all registered mappers.
 * See mapWith() below for more details, see top of this file for general info
 */
function mapToUcum(unit, opts) {
  return mapWith(Object.keys(UcumMapperMgr.registry), unit, opts);
}

/**
 * Normalize the given ucum unit, for now, it's uppper casing the liter "l" in denominator,
 * e.g., mg/ml to mg/mL
 * @param ucum
 */
function normalizeUcum(ucum) {
  return ucum? ucum.replace(/\/[umdc]?l\b/, '/$1L'): ucum;
}


/**
 * Map the given unit to ucum with the given mappers (names) only. Stop when a mapping is found as requested.
 * see the top of this file for more details.
 * @param mappers: can be a single mapper or an array of mappers names as defined in mapping mgr.
 * @param unit: the unit to be mapped.
 * @param opts, optional, with the following possible fields:
 *   - isCI: boolean, default to false. whether case sensitive
 *   - validate: boolean, default to true.
 *     -- When true, no mapping will be performed if the given unit is already valid ucum and return the ucum
 *     -- When false, will not check the validity of the given unit and just run through the mapping process.
 *   - loinc: the loinc number, this is ignored by most mappers but declared as a "common" option.
 *   - other mapper specific options, non-yet, but the name should be specific to the mapper to avoid accidentally
 *     picked up by other mappers.
 * @return a hash of the following fields:
 *   - status: valid - if validation request; invalid - if can't be mapped to ucum; <mapper-name-and-opts> otherwise.
 *   - ucum: the ucum the given unit is mapped to, if any. Undefined otherwise
 *   - ucum_name: only available if validation is requested (in opts), the "human readable name" of the ucum.
 */
function mapWith(mappers, unit, opts) {
  opts = opts || {};
  let doValidate = !opts.hasOwnProperty('validate') || opts.validate;
  mappers = Array.isArray(mappers)? mappers: [mappers];
  if(! unit) {
    return {status: 'missing'};
  }

  if(doValidate) {
    let ucumStatus = validateUcum(unit);
    if(ucumStatus.status === 'valid') {
      return {status: 'valid', ucum: normalizeUcum(unit), ucum_name: ucumStatus.unit.name};
    }
  }

  for(let name of mappers) {
    let altUnit = UcumMapperMgr.registry[name](unit, opts);
    if(! altUnit) continue;
    altUnit = normalizeUcum(altUnit);
    let ucumStatus = doValidate && validateUcum(altUnit) || {};
    if(! doValidate || ucumStatus.status === 'valid') {
      let suffix = Object.keys(opts).map(opt => '[' + [opt, opts[opt]].join('=') + ']').join('-');
      return { status: suffix? name + '-' + suffix: name, ucum: altUnit, ucum_name: doValidate? ucumStatus.unit.name: ''};
    }
  }
  return { status: 'invalid' };
}


// Build a mapping from a unit (from UNITS or DISPLAY_NAME column) to a list of ucum (should be single valued but...)
function loadUnitToUcumFromUnitToProps(combinedUnitMappingXlsx) {
  let unitUcumPropRows = getXlsxSheetJson(combinedUnitMappingXlsx, 'unit-ucum-properties')
    .map(row => ({UNITS: row['Raw UNITS'], ucum: row['ucum unit'], DISPLAY_NAME: row.DISPLAY_NAME}))
    .filter(row => row.UNITS && row.ucum);
  console.log('==== unit-ucum-properties entry count:', unitUcumPropRows.length);

  // hash from unit to a list of ucum units that the unit can be mapped to (should be all single valued, but)
  let unitToUcum = {};
  let delim = /[,;]/; // some columns are unit lists using those as delimiters.

  // the file is mostly fine but has empty cells empty rows, etc.
  unitUcumPropRows.forEach((row, rowNum) => {
    let ucumList = delimitedToList(row.ucum, delim);
    ucumList.forEach(ucum => {
      for(let units of [row.UNITS, row.DISPLAY_NAME].filter(u => u)) {
        if(typeof units !== 'string') {
          // console.error('======= unit-prop UNITS not string corrected, excel-row# %d: %s', rowNum+2, JSON.stringify(row));
          units = units + '';
        }
        let unitList = delimitedToList(units, delim);
        unitList.forEach(unit => {
          addToValueList(unitToUcum, unit, ucum, {unique: true});
        });
      }
    });
  });

  console.log('==== total unit-ucum entry count: %s; ucum(mmol/mol CRT)=%s', Object.keys(unitToUcum).length, unitToUcum['mmol/mol CRT']);

  return unitToUcum;
}


/**
 * Get the special unit to ucum mapping function that is PCORNET-specific - more accurately, the returned function
 * fixes the units (incorrectly) used the in the records.
 * @param getLoincParts a function that returns a hash of LOINC parts for the given LOINC#
 * @return the PCORNET-specific unit to ucum mapping handler function, which takes two parameters, unit and opts,
 *         where opts.loinc must be specified in this case. See mapWIth() for more details.
 */
function getRuleBasedUnitToUcumMapper(getLoincParts) {
  const ruleBasedUnitMapper = require('./pcornetRuleBasedUnit2UcumMapper');
  return function(unit, opts) {
    let {ci, loinc} = (opts || {});
    let altUnit = null;
    let parts = getLoincParts(loinc);
    if(parts) {  // Create a fake record with unit and loinc parts fields so as to use the mapUnitForRec() function
      let fakeRec = Object.assign({UNIT: unit}, parts);
      altUnit = ruleBasedUnitMapper.mapUnitForRec(fakeRec, 'UNIT', ci);
    }
    else {
      console.error('##### Rule-based unit mapping: no/invaid LOINC:', loinc);
    }

    return altUnit && altUnit !== unit? altUnit: null;
  }
}


function checkUcum(ucum, context) {
  if(ucum !== null && ucum !== undefined) {
    ucum = ucum + '';
  }
  let parts = ucum.split(/[^0-9a-zA-Z_]/).map(x=>x.trim()).filter(x => x);
  for(let part of parts) {
    if(part.startsWith('M')) {
      console.log('UPPER-M\t%s\t\t%s', ucum, context);
    }
    if(part.length === 2 && part.endsWith('l')) {
      console.log('LOWER-L\t%s\t\t%s', ucum, context);
    }
  }
}

module.exports = {
  getUcumMapperMgr // see top of the file for description of what a UcumMapperMgr has/does
}


// this is for exploration, troubleshooting, etc.
if(require.main === module) {
  let mgr = getUcumMapperMgr(process.argv[2]); // needed to initialize things
  for(let unit of ['ab c', 'abcd', 'mg/dL']) {
    console.log('to-ucum: "%s" -- "%s"', unit, mgr.mapToUcum(unit));
  }

  function checkSomeSpellings() {
    console.log('\nUpper-M');
    let upperMs = ["MG","Mg","MG/(24.h)","Mg/dL","Mg/dl","MG/L","Mg/L","ML","Ml","Ml/min","Mm","Mm2","Mm3","Mmol/L","MS","MU/L","Mu/L","MV"];
    for(let unit of upperMs) {
      let result = ucumUtil.validateUnitString(unit);
      console.log('%s\t%s\t', unit, result.unit.name);
    }
    console.log('\nLower-L');
    let lowerL = ["R.U/ml","U/ml","[CFU]/ml","kcal/ml","mg/dl","ml/(24.h)","uU/ml","ug/ml"];
    for(let unit of lowerL) {
      let result = ucumUtil.validateUnitString(unit);
      console.log('%s\t%s\t', unit, result.unit.name);
    }

    console.log('\nkG\t%s\t', JSON.stringify(ucumUtil.validateUnitString('kG')));
  }
}
