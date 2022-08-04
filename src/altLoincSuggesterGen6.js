
// The key idea of the algorithms:
// - identify key information from raw name and raw unit (e.g., specimen, time, scale, etc.)
// - if the identified information is inconsistent with that of the mapped-to loinc, it implies
//   that the mapped-to loinc is probably wrong, and an attempt is made to find a better loinc
//   by constructing a "target loinc term" based on the identified information and the mapped-to
//   loinc and see if such a loinc exists, if it does then that should be a better LOINC.
// - identified information are mostly loinc parts, e.g., specimen, time, scale, etc., but it could
//   also be checking the balance of certain modifiers (keywords) between the raw name/unit and the
//   mapped-to term, e.g., .free, .total, etc.

// Implementation notes:
// - To preserve manual work (color/highlighting, notes, etc.) in the file between runs, this script takes
//   an input xlsx file and output to another xlsx file, preserving the non-textual features.
// - However, excel.js is slow'ish and is not very convenient to work with (as compared with json). Therefore,
//   the data are first loaded as json and processed there and then, update the spreadsheet with the results.

const path = require('path');
const excUtil = require('./lib/exceljsUtil');
const util = require('util');
const ucumUtil = require('@lhncbc/ucum-lhc').UcumLhcUtils.getInstance();
const {writeCSV, delimitedToList, copyFields, getSort, isNEU} = require('./lib/common');
const {getDefaultSpecimen} = require('./lib/labNameParser');
const loincUtils = require('./lib/loincUtils');
const PartType = loincUtils.PartTypeList; // part types plus CLASS
const addPartSynonyms = require('./lib/loincPartSynonyms').addPartSynonyms;
const pcornetValidationMgrHandle = require('./pcornetValidationMgr'); // used to initialize pcornetValidationMgr below

const INC_CATEGORY = 'Inclusion category'; // use value "non qn" to exclude a record
const SGG_FIELDS = ['SGG_LOINC', 'SGG_LONG_COMMON_NAME', 'SGG_OTHER'];

// To be initialized in main, see loincUtils.getLoincTableUtil() for more details.
let loincTableUtil, loincToParts, getStdPartName, getUnitProperties, ucumMapperMgr, unitBasedValidationHelper,
  getLoincForParts, hasLoincWithPart, pcornetValidationMgr;

let globalOutputDir; // to be populated later

// The values of these fields are generated and should be cleared before processing.
let COMPUTED_FIELDS = [
  ... SGG_FIELDS,
  // inferred has an entry for each part that has inferred values, each entry is a hash {names, types}
  // where types list corresponds to the names list, with values "parsed" or "inferred". The types are not
  // being used in any way but can potentially be useful, and more types may be added.
  // In final results file, all inferred parts are merged into two string fields: parsed_parts, inferred_parts
  'inferred', 'inferred_parts', 'parsed_parts', 'ucum_converted',
  'ALGO_MAPPING_ISSUES', 'ALGO_JUDGEMENT',
  'RULE_RELAXED_BY', 'TARGET_TERM'
];


module.exports = {
  initAsyncGlobals,
  validateAndSuggest,
  updateResultsFile
}


function validateAndSuggest(pcnRows) {
  preProcessAndValidate(pcnRows);
  // There used to be a few dozens of rules but have been abstracted into one general rule.
  // But keeping the structure/workflow in case more rules will need to be added.
  // let rules = loadAltLoincRules(combinedMappingRuleXlsx, 'alt-loinc-suggest-guiding-table', getStdPartName);
  let rules = [{ _ruleType: 'GeneralReplace', _rowNum: 99999, RULE_NUM: 99999,
    description: 'As the last resort, just use row.inferred to try finding corrections. Must be the last'
  }];
  executeRules(rules, pcnRows);
  pcnRows.forEach(row => reformatValuesToString(row));

  return pcnRows;
}


/**
 * Initialize necessary global variables that are needed, mostly async.
 * @param combinedMappingRuleXlsx the xlsx file that has unit to ucum, unit to property mappings
 * @param loincFileCSV the Loinc.csv file path. THe file may be downloaded from LOINC website.
 * @param outputDir the location/directory where the output file(s) will be written to.
 */
async function initAsyncGlobals(outputDir, combinedMappingRuleXlsx, loincFileCSV) {
  globalOutputDir = outputDir;

  // initialize some tools
  loincTableUtil = await loincUtils.getLoincTableUtil(loincFileCSV, combinedMappingRuleXlsx);
  ({loincToParts, getStdPartName, getLoincForParts, hasLoincWithPart} = loincTableUtil);

  getUnitProperties = loincTableUtil.getUnitToPropertiesMapper(combinedMappingRuleXlsx); // already init above but fine
  pcornetValidationMgr = pcornetValidationMgrHandle.getMgr(loincTableUtil, getUnitProperties);

  function getLoincParts(loinc) {
    let partLists = loincToParts[loinc]; // the return hash has a list of part values (though at most 1) for each part type
    return !partLists? null: PartType.reduce((acc, pt) => {
      acc[pt] = partLists[pt] && partLists[pt][0] || '';
      return acc;
    }, {});
  }
  ucumMapperMgr = require('./lib/UnitToUcumMapperMgr').getUcumMapperMgr(combinedMappingRuleXlsx, getLoincParts);
}


/**
 * Pre-process the pcornet data, e.g., standardize RAW_LAB_NAME to string type, turn
 * @param pcnRows
 */
function preProcessAndValidate(pcnRows) {
  addLoincPartsFillMissingColumns(pcnRows);
  // SPECIMEN_SOURCE values that can't be converted by getStdPartName(). Per Clem, "UN" is likely unknown
  let pcnSpcmMapping = {SER_PLAS: 'Ser/Plas', BODY_FLD: 'Body fld', PLR_FLD: 'Plr fld', RESPIRATOR: 'Respiratory', UN: ''}
  let pcnSpcmIssues = {multi_values: [], unknowns: {}}; // for logging only
  function normalizeSPECIMEN_SOURCE(row) {
    let spcList = [];
    delimitedToList(row.SPECIMEN_SOURCE, ';').forEach(spcm => {
      let stdPartName = pcnSpcmMapping[spcm] || getStdPartName(spcm, 'SYSTEM');
      if(!stdPartName) { // for troubleshooting - keep, full/55DM data set will likely have surprises..
        pcnSpcmIssues.unknowns[spcm] = true;
      }
      else if(! spcList.includes(stdPartName)) {
        spcList.push(stdPartName); // TODO: should use single value, but how? convert first, check length and disqualify
      }
    });
    // Ignore a few rows with multiple SPECIMEN_SOURCE: #2098: ['Bld', 'PPP']; #4486: ['Bld', 'Urine'], etc.
    row.SPECIMEN_SOURCE = spcList.length === 1? spcList[0]: '';
    if(spcList.length > 1) {
      pcnSpcmIssues.multi_values.push(spcList + ' at #' + row.ROW_NUM);
    }
  }

  // add a new ucum_converted for the converted ucum (from RAW_UNIT) or empty string if no raw unit or no conversion
  function convertToUcum(row) {
    row.ucum_converted = '';
    let rawUnit = pcornetValidationMgr.getXformedRawUnit(row);
    if(rawUnit) {
      let loinc = row.LAB_LOINC || '';
      row.ucum_converted = ucumMapperMgr.mapToUcum(rawUnit, {loinc}).ucum ||
                           ucumMapperMgr.mapToUcum(rawUnit, {loinc, isCI: true}).ucum || '';
    }
  }

  pcnRows.forEach((row, rowNum) => {
    row.RAW_LAB_NAME = isNEU(row.RAW_LAB_NAME) ? '' : row.RAW_LAB_NAME + ''; // some are numeric

    // clear the computed fields for recomputing
    for(let f of COMPUTED_FIELDS) {
      if(row.hasOwnProperty(f)) row[f] = '';
    }

    normalizeSPECIMEN_SOURCE(row);
    convertToUcum(row);

    row.ALGO_JUDGEMENT = getInitialRowStatus(row);
    if(! isExcludeStatus(row)) {
      let units = getAllPossibleUnits(row); // raw unit and ucum unit
      // parse and infer LOINC parts based on SPECIMEN_SOURCE, RAW_LAB_NAME, RAW_UNIT, etc.
      pcornetValidationMgr.inferAndValidate(row, units, rowNum);
    }
  });
//  console.log('#### SPECIMEN_SOURCE issues:\n%s', JSON.stringify(pcnSpcmIssues, null, 4));
}

/**
 * The LOINC mapping validation/correction process requires the records to have the LOINC parts, class, long name, and
 * example ucum units. Add or override the fields using data from LOINC.
 * There are other columsn (e.g., NUM_RECORDS)
 * @param pcnRows
 */
function addLoincPartsFillMissingColumns(pcnRows) {
  pcnRows.forEach((row, index) => {
    if(!row.hasOwnProperty('ROW_NUM')) {
      row.ROW_NUM = index + 2;
    }
    let loinc = loincToParts[row.LAB_LOINC];
    if(loinc) {
      copyFields(loinc, row, ['LONG_COMMON_NAME', 'EXAMPLE_UCUM_UNITS:example ucum'], {delim: ':'});
      for(let part of PartType) { // also includes CLASS
        row[part] = loinc[part][0] || '';
      }
    }
  });
}

// try default specimen only if no specimen found in the raw name
function shouldTryDefaultSpecimen(row) {
  return false; // DISALBED FOR NOW, need to figure out the sequence - allow this if specimen is the only mismatch
  let tryIt = false;
  if(!(row.inferred && row.inferred.SYSTEM && row.inferred.SYSTEM.names && row.inferred.SYSTEM.names.length)) {
    let defaultSys = getDefaultSpecimen(row);
    tryIt = !!(defaultSys && ! pcornetValidationMgr.partsCompatible('SYSTEM', defaultSys, row.SYSTEM, row));
  }
  if(row.ROW_NUM === 1595) console.log('#%s: try-default-specimen = %s', row.ROW_NUM, tryIt);
  return tryIt;
}

/**
 * Use a set of rules to validate and correct existing LOINC mappings. There used to be a few dozens of
 * rules based on LOINC class, etc., but have now been generalized into one rule.
 * See the descriptions at the top of the file and replaceAndFind() for more details.
 * @param rules
 * @param pcnRows
 */
// 3. Rules - from combined-unit-mapping (some latest version). See replaceAndFind() for more details.
function executeRules(rules, pcnRows) {
  console.log('\n====== started executeRules: %d rules; %d pcnRows', rules.length, pcnRows.length);
  let multiplesInfo = {multiples: 0, corrected: 0, needFix: 0}; // needFix are those with mapping issues that will need to run the rules
  pcnRows.forEach((row, rowNum) => {
    if(isExcludeStatus(row)) return;  // for now, WACKO* and NON_QN; some rules may want to run even without ALGO_MAPPING_ISSUES
    if(row.ALGO_MAPPING_ISSUES) multiplesInfo.needFix += 1;

    let recLoincParts = loincToParts[row.LAB_LOINC];
    let units = getAllPossibleUnits(row);
    units = units.length? units: ['NA-NA']; // just so that the record gets to go through the process - some rules don't care about unit

    // run the record row though the rules using each unit to find possible alternative LOINCs
    let allMatches = [];
    for(let unit of units) {
      let propOfUnit = getUnitProperties(unit);
      let altLoincs4Unit = executeRulesForRecord(recLoincParts, unit, propOfUnit, rules, row, rowNum);
      altLoincs4Unit.forEach(loincInfo => allMatches.push(loincInfo));
    }

    if(! allMatches.length) return;
    multiplesInfo.corrected += 1;

    let [bestMatch, rest] = selectBestMatch(allMatches, row, rules);
    if(rest.length > 0) multiplesInfo.multiples += 1;

    //addSubstitutionInfo(row, bestMatch.altLoincParts || {}, {replace: true});
    allMatches = [bestMatch]; // put in an array to reuse the below process.

    // TODO:
    //    IMPORTANT: loincInfo parts are arrays, but because they have a single element, when used as key,
    //    javascript's automatic to-string conversion makes the part name (not the array object) the key.
    //    Therefore, there is a bug here but it does not affect the results. Should be fixed, still
    // unique values of each SGG_* field seen in all corrections for the row
    let uniqVals = SGG_FIELDS.reduce((acc, f) => {acc[f] = {}; return acc;}, {});
    let relaxations = [];
    allMatches.forEach(loincInfo => {
      uniqVals.SGG_LOINC[loincInfo.LOINC_NUM] = true;
      uniqVals.SGG_LONG_COMMON_NAME[loincInfo.LONG_COMMON_NAME] = true;
      (loincInfo.relaxations || []).forEach(relax => { if(! relaxations.includes(relax)) relaxations.push(relax); });
    });

    Object.keys(uniqVals).forEach(key => { // turn unique hash into unique value list then join as a string
      uniqVals[key] = Object.keys(uniqVals[key]).join('; ');
    });
    uniqVals.RULE_RELAXED_BY = relaxations.join('; ');
    uniqVals.ALGO_JUDGEMENT = 'FIXED';

    Object.assign(row, uniqVals);
    row.SGG_OTHER = rest.map(m => util.format('%s:{%s}', m.LOINC_NUM, m.LONG_COMMON_NAME)).join('; ');
  });

  console.log('=== multiples-info====', JSON.stringify(multiplesInfo, null, 4));
}


// TODO: combine this with the above "unique" block
/**
 * Select one best match. Best, first and foremost, is defined as matching all (alt) parts, then
 * not DEPRECATED/DISCOURAGED, then just pick the first.
 * @param allMatches all matches as collected in executeRules, where each match is a map:
 *           <loinc-part>: [<single-or-no-part-name>] (also include CLASS)
 *           LOINC_NUM,  LONG_COMMON_NAME, STATUS: single string value
 *           RULE_NUM: numeric, corresponding to rule.RULE_NUM
 * @param row the data row
 * @param rules the list of rules
 * @return the best match (one element in the allMatches list)
 */
function selectBestMatch(allMatches, row, rules) {
  if(! allMatches || !allMatches.length) return [null, null];
  if(allMatches.length === 1) return [allMatches[0], []];

  let candidates = allMatches.slice();
  candidates.forEach(m => {
    m.score = 50; // default
    if(m.relaxations) m.score -= 25 * Math.pow(m.relaxations.length, 0.25);
    if(m.STATUS === 'DEPRECATED') m.score -= 20;
    if(m.STATUS === 'DISCOURAGED') m.score -= 10;
    if(row.SYSTEM === 'XXX' && !(row.inferred && row.inferred.SYSTEM && row.inferred.SYSTEM.names)) {
      // no inferred specimen + XXX skipped specimen match, need to boost by default or SPECIMEN_SOURCE
      if(pcornetValidationMgr.partsCompatible('SYSTEM', m.SYSTEM[0], row.SPECIMEN_SOURCE, row) ||
        pcornetValidationMgr.partsCompatible('SYSTEM', m.SYSTEM[0], getDefaultSpecimen(row), row)) {
        m.score += 35;
        //console.log('#%s: boosted for SPECIMEN_SOURCE or default specimen: %s', row.ROW_NUM, JSON.stringify(m));
      }
    }
    let count = PartType.reduce((acc, part) => { // count the number of parts that match
      let inferredParts = row.inferred && row.inferred[part] && row.inferred[part].names;
      if(inferredParts && inferredParts.length) {
        return (inferredParts.some(name => name === m[part][0]))? acc + 1: acc;
      }
      return (!row[part] && !m[part][0] || row[part] === m[part][0])? acc + 1: acc;
    }, 0);
    if(row.RAW_UNIT && row.RAW_UNIT === m.EXAMPLE_UCUM_UNITS) m.score += 10;
    if(count === PartType.length) m.score += 50;
    if(row.ROW_NUM === 881) {
      //console.log('#MATCHED-PARTS=%d; inferred=%s alts=%s; candidate=%s', count, JSON.stringify(row.inferred), JSON.stringify(m.altLoincParts), JSON.stringify(m));
    }
  });

  candidates.sort(getSort([m => m.score, true])); // higher score first

  // log some info for analysis - unique loincs
  let loincSeen = new Set([candidates[0].LOINC_NUM]);
  for(let index=1; index < candidates.length; ++index) {
    if(loincSeen.has(candidates[index].LOINC_NUM)) {
      candidates.splice(index, 1);
      --index;
    }
    else {
      loincSeen.add(candidates[index].LOINC_NUM);
    }
  }

  if(candidates.length > 1) {
    let scores = candidates.map(c => c.LOINC_NUM + ': ' + c.score);
    //console.log('==== #%s - MULTIPLE for data=(%s, %s, %s): scores=%s\n%s',
    //  row.ROW_NUM, row.LAB_LOINC, row.RAW_LAB_NAME, row.RAW_UNIT, scores, JSON.stringify(candidates));
  }


  return [candidates[0], candidates.slice(1)];
}


/**
 * @param unit one for of the unit (e.g., raw or after converting to ucum
 * @param unitProperties: a list of properties for the record's unit
 * @param recLnParts: the current mapped to LOINC as a hash of parts plus LOINC_NUM
 * @param rules all the rules to be tried one after another, will run through all regardless
 * @param row the pcornet data row
 * @param rowNum: 0-based row#, +2 to get the native spreadsheet row#
 * @return a list of alternative LOINCs where each is a hash that has the 7 parts as a field, plus LOINC_NUM, RULE_NUM.
 */
function executeRulesForRecord(recLnParts, unit, unitProperties, rules, row, rowNum) {
  // The rules can generally be categories into types by LOINC parts (see loadAltLoincRules), each handle by
  // a rule executor. Such executors return:
  // - null if the rule is not applicable to the record
  // - a result object with result.altLoincs as an empty array if the rule is applicable but no corrections found
  // - a result object where result.altLoincs is a list, each is a correction

  let ruleExecutors = {  // rule._ruleType to executor function - should move it out of this function but ok
    // check the lastest gen-4 version for these functions, they have been replaced by the one,
    // executeGeneralRule().
    // keeping the structure here just in case new rules are needed.
    //PROPERTY: executePropertyRule, // Got one issue, row #1818, ionized balanced issue, but resolved after removing .ionized from the modifier list
    // SCALE: executeScaleRule,
    // METHOD: executeMethodRule, // rule 42 covered by rule 77, should be fine.
    //SYSTEM: executeSystemRule,
    //TIME: executeTimeRule, // fine to remove this, general rule captures it.
    // SpecimenInName: executeParsedSpecimenRule, // This is hooked in using a "fake" rule #99990
    // ParsedTime: executeParsedTimeRule,         // This is hooked in using a "fake" rule #99991
    // ComponentModifier: executeModifierRule,    // This is hooked in using a "fake" rule #99992, now handled by the general rule
    GeneralReplace: executeGeneralRule         // Use as the last resort, rule #99999
  }
  let altLoincs = [];
  for(let rule of rules) {
    let result;
    if(shouldTryDefaultSpecimen(row) || row.ALGO_MAPPING_ISSUES) {
      let executor = ruleExecutors[rule._ruleType];
      if(executor) {
        result = executor(rule, recLnParts, unit, unitProperties, row, rowNum);
      }
      else {
        console.log('==WARM: NO executor for rule-type %s defined, skipped', rule._ruleType);
      }
    }
    if(! result) { // rule not fired (conditions not met); result.altLoincs (array) indicate if there are any actual fixes
      continue;
    }

    // addSubstitutionInfo(row, result.altLoincParts || {}); // add for each rule, but all may be replaced by THE one if a best fix is found
    if(result.targetTerm) { (row.TARGET_TERM = row.TARGET_TERM || []).push(result.targetTerm); }

    if(result.altLoincs && result.altLoincs.length) {
      result.altLoincs.forEach(altPartsInfo => {
        altPartsInfo.RULE_NUM = rule.RULE_NUM; // returned loinctPart info is just already deep-copied.
        altLoincs.push(altPartsInfo);
      });
    }
    else {
      if(row.ALGO_JUDGEMENT !== 'INCORRECT_aj') {
        console.error('---- BUG for row#=%d: rule %s fired, ALGO_JUDGEMENT=%s', rowNum, rule.RULE_NUM, row.ALGO_JUDGEMENT);
      }
    }
  }

  if(row.inferred && !row.ALGO_MAPPING_ISSUES || !row.inferred && row.ALGO_MAPPING_ISSUES) {
    //console.log('== WARN: algo-mapping-issue and inferred disagree, row#=%s:\n%s', rowNum, JSON.stringify(row));
  }

  return altLoincs;
}


/**
 * Rule #99999:
 * This rule is a last-report general rule: if a row has inferred LOINC parts (implying mapping issue)
 * and no corrections have been found after all rules, just try replacing in the inferred parts.
 * See executeRulesForRecord for details on the parameters
 */
function executeGeneralRule(rule, recLnParts, unit, unitProperties, row, rowNum) {
  let altParts = getAltPartsFromInferred(row);
  // if(row.ROW_NUM === 4528) { console.log('#4528: altParts/inferred parts: ', JSON.stringify(altParts)); }

  return Object.keys(altParts).length === 0 && !shouldTryDefaultSpecimen(row)? null:
    replaceAndFind(recLnParts.LOINC_NUM, altParts, {rule, row, rowNum});
}


// Get the altParts from the parsed/inferred parts as inferred/populated by pcornetValidationMgr.inferAndValidate()
// row.inferred: {partType: {names: [], types[]}}, see pcornetValidationMgr.addInferredLoincParts() for more details.
// returns empty hash when no parsed/inferred parts
function getAltPartsFromInferred(row) {
  return Object.entries(row.inferred || {})
    .filter(e => PartType.includes(e[0])) // keeping only LOINC parts info - other fields are noise
    .reduce((acc, entry) =>{
      let partType = entry[0], partNames = entry[1].names;
      if(partNames.length !== 1 || partNames[0] !== row[partType]) {
        acc[partType] = partNames.slice();
      }
      return acc;}, {});
}


// For efficient search, the function first find the subset of LOINC terms that might be applicable using
// the parts that must match. The loinc table has been pre-indexed to allow such subset selection.
// ====### under-filtering is fine, over-filtering is not ###====
// - CLASS, METHOD: not filtering on these two due to possible "relaxation"
// - COMPONENT: not filtering on it for now due to relaxation, e.g., ingoring the denonimator (xxx/100 yyy)
//              potentially we oculd index the numerator part of the component as well, but for now, it's fine.
// - SYSTEM: add the synonyms before getting the subset.
// See matchPart() for more details - here, we pull the list of loinc terms by not limiting on those flexibilities.
/**
 * The "routine" that Clem described in his word document.
 * Search for new loinc(s) with the part names replaced with the given part type/name.
 * It's "AND" between part types but "OR" between part names of a given part type.
 * @param loinc the "target LOINC code" mentioned above
 * @param replacementParts a harsh from part type name (e.g., PROPERTY) to the list of
 *        alternative part names, e.g., MCnc. When the value is null for a part type,
 *        that part type will NOT be compared (ignore, assuming fine)
 * @param context has 3 (for now) elements: rule, row, and 0-based rowNum for the row in the data
 * @return a list "loincPartInfo" object (as returned by loincToParts but deep copied)
 */
function replaceAndFind(loinc, replacementParts, context) {
  let row = context.row;
  // skip/does not require SYSTEM match if mapped-to is XXX and no replacement system specified.
  if(!replacementParts.hasOwnProperty('SYSTEM') && row.SYSTEM === 'XXX') {
    replacementParts = Object.assign({SYSTEM: null}, replacementParts);
    // console.log('==== XXX SKIP MATCH FOR SPECIMEN');
  }
  let refPartsInfo = loincToParts[loinc];
  let result = {altLoincParts: replacementParts}; // has either an "error" field or a list (could be empty) of alternatice LOINCs found.
  if(! refPartsInfo) {
    result.error = 'Unknown LOINC: ' + loinc;
    return result;
  }

  // Build the "target-loinc-term" to look for. A null value for a part would be a request to skip the part match
  let targetTermParts = PartType.reduce((acc, partType) => {
    acc[partType] = replacementParts.hasOwnProperty(partType) && !replacementParts[partType]? null:
      replacementParts[partType] || refPartsInfo[partType] || [];
    addPartSynonyms(partType, acc[partType]);
    return acc;
  }, {});

  // Build a filter used to select the set of LOINC terms (from LOINC table) to check for match
  let filterParts = ['PROPERTY', 'TIME', 'SYSTEM', 'SCALE'].reduce((acc, part) => {
    if(targetTermParts[part]) {
      acc[part] = targetTermParts[part].slice();
      if(acc[part].length === 0) acc[part].push(''); // explicitly represent no/empty part name
      if(part === 'SYSTEM') {
        acc[part].push('XXX');
        if(acc[part].some(name => ['Urine', 'CSF'].includes(name))) {
          let toAdd = acc[part].includes('Urine')? ['Urine+Ser', 'Urine+Ser/Plas']: ['Ser+CSF', 'Ser/Plas+CSF'];
          acc[part] = [...acc[part], ...toAdd];
        }
      }
    }
    return acc;
  }, {});

  let loincsToCheck = getLoincForParts(filterParts);

  result.altLoincs = [];
  loincsToCheck.forEach(loinc => {
    if(loinc === refPartsInfo.LOINC_NUM) return; // self, no need to check
    let candidateLoincPartsInfo = loincToParts[loinc];
    let status = isAltLoinc(refPartsInfo, replacementParts, targetTermParts, candidateLoincPartsInfo, context);
    if(status.matched) {
      let rec = JSON.parse(JSON.stringify(candidateLoincPartsInfo));
      if(status.relaxations) {
        rec.relaxations = status.relaxations;
      }
      result.altLoincs.push(rec);
    }
  });

  (result.altLoincs || []).forEach(m => m.altLoincParts = replacementParts); // set it for each match to be used later.
  // not ideal as the various details/relaxations in isAltLoinc() and lower are lost for records without a fix, but you
  // may not want to log all the failed combinations, anyways.
  let targetTerm = Object.values(targetTermParts).map(names => names? names.join(',') || '-': '*').join('; ');
  result.targetTerm = {rule: context.rule.RULE_NUM, term: targetTerm};

  return result;
}



/**
 * Replacing the parts in refLoincParts as specified in partTypesAndAltNames and see if the resulting
 * parts data match that of the candidateLoincParts. For part type with multiple part names, any overlapping
 * is considered a match. For example, if the reference (with replacement if specified) has CLASS CHEM and
 * the candidate has CLASS CHEM and CHEM-X, then it's a match.
 * @param refLoincParts reference LOINC, for each part, an array of part names (single value, really( - see loincToParts for details
 * @param targetTermParts: really computed from refLoincParts and partTypesAndAltNames but passing in for efficiency,
 *        while keeping refLoincParts, partTypesAndAltNames for possible other uses down the road.
 * @param partTypesAndAltNames for each part, an array of part names (could be multiple) - see replaceAndFind() for details
 * @param candidateLoincParts parts for candidate LOINC, , see loincToParts for details
 * @param context has 3 (for now) elements: rule, row, and 0-based rowNum for the row in the data
 * @param currRelaxLevel optional, used for recursive call ONLY, for relaxing METHOD and/or perhaps other matching
 *        criteria. For now:
 *        - 0: or not specified: no relaxation (except for the existing SCALE rule specific relaxation
 *        - 1: if candidate does not have METHOD, then METHOD match can be waived
 *        - 2: including level(1), METHOD match is waived
 *        - 3: including level (2), CLASS match is waived - not sure we'll get there
 * @return a hash with two fields: matched (true/false) and optional "relaxations", which is a list of relaxations
 */
function isAltLoinc(refLoincParts, partTypesAndAltNames, targetTermParts, candidateLoincParts, context, currRelaxLevel) {
  currRelaxLevel = currRelaxLevel || 0;
  let maxRelaxLevel = 3; // See parameter doc above for what this means

  // Here, in additional to determine match or not, we also record near-misses (2 or less parts mismatch) for analysis
  let mismatches = {count: 0}; // mis-matched parts
  let relaxations = [];
  for(let partType of PartType) {
    if(! matchPart(context, partType, targetTermParts, candidateLoincParts, currRelaxLevel, relaxations)) { // record down method mismatch
      mismatches.count += 1;
      mismatches[partType] = true;
      if(mismatches.count > 2) { // at most 2 relaxations at this point.
        break;
      }
    }
  }

  if(mismatches.count === 0) {
    return relaxations.length? {matched: true, relaxations}: {matched: true};
  }
  else if(currRelaxLevel < maxRelaxLevel &&
    ( mismatches.count === 1 && (mismatches.METHOD || mismatches.CLASS) ||
      mismatches.count === 2 && mismatches.METHOD && mismatches.CLASS)) {
    return isAltLoinc(refLoincParts, partTypesAndAltNames, targetTermParts, candidateLoincParts, context, currRelaxLevel + 1);
  }

  return {matched: false};
}


/**
 * There could be various relaxations when it's not an exact match.
 * @param context: has these fields: rule: the rule being applied, row: the data row
 * @param partType the part type being compared
 * @param srcParts the parts to look for in candidates (current with requested replacement parts), all part types
 *        null part indicates this part should be skipped (considered matched). Note that empty list still requires match
 * @param candidateLoincParts candidate LOINC parts
 * @param currRelaxLevel relaxation level (0-3 for now)
 * @param relaxations an array to return/hold relaxation info, must be a list.
 * @return true if the candidate meets the requirements, false if not.
 */
function matchPart(context, partType, srcParts, candidateLoincParts, currRelaxLevel, relaxations) {
  let {row, rule} = context;
  let candidates = candidateLoincParts[partType];
  let matched = srcParts[partType] === null || // null for skipping the match and considered matched
                srcParts[partType].length === 0 && candidates.length === 0 ||
                srcParts[partType].some(e => candidates.includes(e));
  if(matched) return matched;

  switch (partType) {
    case 'METHOD':
      if(currRelaxLevel > 0 && candidates.length === 0) {
        matched = true;
        relaxations.push('METHOD-empty-ok');
      }
      else if(currRelaxLevel > 1) {
        matched = true;
        relaxations.push('METHOD-match-waived');
      }
      break;
    case 'CLASS':
      if(currRelaxLevel > 2) {
        matched = true;
        relaxations.push('CLASS-match-waived');
      }
      break;
    case 'COMPONENT':
      matched = relaxedComponentMatch(row, srcParts, candidateLoincParts, relaxations)
      break;
    case 'SYSTEM':
      matched = srcParts.SYSTEM.some(sys => pcornetValidationMgr.partsCompatible('SYSTEM', sys, candidates[0], row));
      if(!matched && shouldTryDefaultSpecimen(row) &&
        pcornetValidationMgr.partsCompatible('SYSTEM', getDefaultSpecimen(row), candidates[0], row)) {
        matched = true;
        relaxations.push('matched-with-default-specimen');
        console.log('#%s matched-with-default-specimen: %s', row.ROW_NUM, defaultSys);
      }
      if(!matched && candidates[0] === 'XXX') {
        relaxations.push('specimen-xxx-match-waived');
        // console.log('#%s specimen-xxx-match-waived', row.ROW_NUM);
        matched = true;
      }
      break;
    default:
      break;
  }

  return matched;
}


/**
 * Check to see if the given candidate loinc matches/satisfies the target loinc (constructed/imagined loinc to look for).
 * This match is done after straightfoward (direct) mathc fails.
 * @param row
 * @param targetLoincParts the constructed/imagined LOINC (parts set) to look for in the LOINC table.
 * @param candidateLoincParts the candidate loinc terms (as parts set) in the loinc table
 * @param relaxations
 */
function relaxedComponentMatch(row, targetLoincParts, candidateLoincParts, relaxations) {
  let candidateComp = candidateLoincParts.COMPONENT[0];
  let targetComp = targetLoincParts.COMPONENT[0]; // so far it's always a single component in target loinc parts.

  let matched = false;
  if(row.RAW_UNIT.indexOf('%') >= 0 && targetComp.indexOf('/') < 0 && candidateComp.indexOf('/') > 0) {
    let relaxedTarget = targetComp;
    if(!/crystal/i.test(row.RAW_LAB_NAME) && relaxedTarget.endsWith(' crystals') && !/crystal/i.test(candidateComp)) {
      relaxedTarget = relaxedTarget.slice(0, -9);
    }
    if(candidateComp.startsWith(relaxedTarget + '/') || relaxedTarget + ' actual/Normal' === candidateComp) {
      let relax = relaxedTarget === targetComp? 'COMP-denom for %': 'COMP-denom for %, dropping crystals';
      //console.log('#%s: %s', row.ROW_NUM, relax);
      relaxations.push(relax);
      matched = true;
    }
  }
  else if(targetLoincParts.PROPERTY.includes('NCnc') && candidateComp + '/100 leukocytes' === targetComp) {
    matched = true;
    relaxations.push('matchPart: NCnc ignoring "/100 leukocytes"'); // ignore /* on the mapped-to side
  }
  if(! matched &&
    targetLoincParts.PROPERTY.some(p => p && p.endsWith('Cnc')) &&
    targetComp.endsWith(' actual/Normal') &&
    targetComp.slice(0, -14) === candidateComp) {
    matched = true;
    relaxations.push('matchPart: dropping actual/Normal for ACnc');
    // console.log('#%s: matchPart: dropping actual/Normal for ACnc', row.ROW_NUM);
  }

  if(! matched && !/fragments/i.test(row.RAW_LAB_NAME) && /fragments/i.test(targetComp) &&
    targetComp.replace(/[ ]?fragments/i, '').trim() === candidateComp) {
    matched = true;
    relaxations.push('matchPart: dropping fragments');
    //console.log('#%s: matchPart: dropping fragments', row.ROW_NUM);
  }

  if(! matched && !/nucleated/i.test(row.RAW_LAB_NAME) && /[.]nucleated/i.test(targetComp) &&
    targetComp.replace(/[.]nucleated/i, '').trim() === candidateComp) {
    matched = true;
    relaxations.push('matchPart: dropping .nucleated');
    // console.log('#%s: matchPart: dropping nucleated', row.ROW_NUM);
  }
  return matched;
}


/**
 * Update the xlsx file from the processed rows - the processed rows should have been loaded
 * from the exact xlsx file, processed. See COMPUTED_FIELDS above, no other fields should have been changed.
 * Otherwise the rows should be exactly the same as in the xlsx file
 * @param processedRows the processed pcornet rows, update based on the COMPUTED_FIELDS
 * @param pcornetXlsx the pcornet data spreadsheet file
 * @param outputFile the output file name
 * @return {Promise<string>} the output file written
 */
async function updateResultsFile(processedRows, pcornetXlsx, outputFile) {
  let [workbook, worksheet] = await excUtil.getWorksheet(pcornetXlsx);
  let cellMgr = excUtil.getCellMgr(worksheet);
  let colSet = new Set(cellMgr.getColNames());
  //let setValue = (field, rowOrd, value) => cellMgr.setValue(field, rowOrd, value);
  let setValue = (field, rowOrd, value) => {if(colSet.has(field)) cellMgr.setValue(field, rowOrd, value)};
  let outputFields = [...SGG_FIELDS,
    'ALGO_MAPPING_ISSUES', 'ALGO_JUDGEMENT', 'TARGET_TERM', 'parsed_parts', 'inferred_parts', 'RULE_RELAXED_BY'];

  for(let rowNum = 2; rowNum <= worksheet.rowCount; ++rowNum) {
    let updatedRow = processedRows[rowNum - 2];
    for(let f of outputFields) {
      setValue(f, rowNum, updatedRow[f] || '');
    }
  }
  // TODO: when finalized, set the denominator/numerator column? for which status column?
  await workbook.xlsx.writeFile(outputFile);

  basicStats(worksheet, cellMgr, 'ALGO_JUDGEMENT');

  let missingOutCols = outputFields.filter(f => !colSet.has(f));
  if(missingOutCols.length) {
    console.log('WARMING: output columns missing in the input file will not be included in the output file:\n%s', missingOutCols);
  }
}


/**
 * Get the initial status of the data row:
 * - invalid loinc, numeric RAW_LAB_NAME, non-quantitative (based on 'Inclusion category'), or NOT_JUDGED.
 * @param row
 * @return the initial judgement status
 */
function getInitialRowStatus(row) {
  let excludeStatus =
    (!row.LAB_LOINC || !loincToParts[row.LAB_LOINC])? 'WACKO_INVALID_LOINC':
    (!row.RAW_LAB_NAME || row.RAW_LAB_NAME.match(/^[^a-zA-Z]+$/))? 'WACKO_NUMERIC_RAW_NAME':
    (row[INC_CATEGORY] === 'non qn')? 'NON_QN': 'CORRECT_aj';

  return excludeStatus;
}


/**
 * Check if a row needs to be processed.
 * @param status
 * @return {boolean}
 */
function isExcludeStatus(row) {
  return ['WACKO_INVALID_LOINC', 'WACKO_NUMERIC_RAW_NAME', 'NON_QN'].includes(row.ALGO_JUDGEMENT)
}


/**
 * For the given (pcornet) row, get all possible units, raw unit, ucum units from every mapper.
 * This is unfortunately necessary to alleviate the defects of ucum and unit to property mapping.
 * @param row
 * @return {string[]}
 */

function getAllPossibleUnits(row) {
  let uniqUnits = row.RAW_UNIT === 'nm'? {'nmol/mL': true, 'nmol': true}: {};
  if(row.ucum_converted) uniqUnits[row.ucum_converted] = true;
  [pcornetValidationMgr.getXformedRawUnit(row)].forEach(unit => {
    if(unit) {
      uniqUnits[unit] = true;
      // Try all possible ucum mappings to get alternative unit spellings/formats
      ucumMapperMgr.getMapperNames().forEach(mapper => {
        [false, true].forEach(isCI => {
          let ucumStatus = ucumMapperMgr.mapWith(mapper, unit, {isCI, loinc: row.LAB_LOINC, validate: false});
          if(ucumStatus && ucumStatus.ucum) {
            uniqUnits[ucumStatus.ucum] = true;
          }
        });
      });
    }
  });

  return Object.keys(uniqUnits);
}


// for now, only support one level hash, with simple value or value list.
function objToNVpairString(obj) {
  return Object.entries(obj||{}).map(([name, value]) => {
    value = Array.isArray(value)? value: [value || ''];
    return util.format('%s=%s', name, value.join(','));
  }).join('; ')
}

// format the following structured field values to string:
// - ALGO_MAPPING_ISSUES
// - TARGET_TERM, the constructed "LOINC-ish" term (the parts) that's likely the correct LOINC. If
//   such a LOINC exists, that will be the suggested LOINC (or one of)
// Also, if from/to parts have exact value then remove it from both.
function reformatValuesToString(row) {
  row.ALGO_MAPPING_ISSUES = (row.ALGO_MAPPING_ISSUES || []).join('; ');

  // there is only one rule, 99999 now, so no need to do this.
  // let targetTerms = (row.TARGET_TERM || []).sort(getSort([t=> t.rule, true])); // let rule 99999 be the first
  // let uniqTerms = targetTerms.reduce((acc, t) => { acc[t.term] = util.format('{%s}', t.rule, t.term); return acc;}, {});
  let uniqTerms = (row.TARGET_TERM || []).reduce((acc, t) => { acc[t.term] = t.term; return acc;}, {});
  row.TARGET_TERM = Object.values(uniqTerms).join('; ');
  //if(row.TARGET_TERM) console.log('#%s: %s TARGET_TERM: %s', row.ROW_NUM, Object.keys(uniqTerms).length, row.TARGET_TERM);
}


// ================ stats stuff, non core stuff =================

function basicStats(worksheet, cellMgr, statusField) {
  let stats = {};
  let total = { TOTAL: 0, agg_TOTAL: 0};
  let colSet = new Set(cellMgr.getColNames());
  // get cell value and use default if the COLUMN DOES NOT EXIST.
  let getWithDefault = (field, rowOrd, defaultValue) => colSet.has(field)? cellMgr.getValue(field, rowOrd): defaultValue;


  for(let rowNum = 2; rowNum <= worksheet.rowCount; ++rowNum) {
    // let numRecords = parseInt(cellMgr.getValue('NUM_RECORDS', rowNum)) || 0;
    // let currStatus = cellMgr.getValue(statusField, rowNum);
    let numRecords = parseInt(getWithDefault('NUM_RECORDS', rowNum, 1));
    let currStatus = getWithDefault(statusField, rowNum, 'COL-NOT-EXIST');

    total.TOTAL += 1; total.agg_TOTAL += numRecords;
    stats[currStatus] = (stats[currStatus] || 0) + 1;
    stats['agg_' + currStatus] = (stats['agg_' + currStatus] || 0) + numRecords;
  }

  let sortKeys = (obj) => Object.keys(obj).sort().reduce((acc, key) => { acc[key] = obj[key]; return acc; }, {});
  stats = sortKeys(stats);
  stats = Object.assign(total, stats);
  if(statusField === 'ALGO_JUDGEMENT') { // only field for now.
    statsReport_algo(stats);
  }
}


function statsReport_algo(stats) {
  let simple = {TYPE: 'simple'}, weighted = {TYPE: 'weighted'};

  ['TOTAL', 'WACKO_INVALID_LOINC', 'WACKO_NUMERIC_RAW_NAME', 'CORRECT_aj', 'INCORRECT_aj', 'FIXED'].forEach(f => {
    simple[f.replace('WACKO_', '')] = stats[f];
    weighted[f.replace('WACKO_', '')] = stats['agg_' + f];
  });
  simple.CORRECT_aj += (stats.CORRECT_aj_PrThr_ASSUMED || 0);        // just for presentation, already in the numerator
  weighted.CORRECT_aj += (stats.agg_CORRECT_aj_PrThr_ASSUMED || 0);  // same as above

  writeCSV([simple, weighted],  path.join(globalOutputDir, 'overview-stats-algo.csv'));
  console.log('==== algo-judgement====%s', JSON.stringify([simple, weighted], null, 4));
}
