
// Helper module for parsing out/inferring LOINC parts from test name or unit, or other cues.

const util = require('util');
const {addPartSynonyms, getPartSynonyms} = require('./lib/loincPartSynonyms');
const PartTypeList = require('./lib/loincUtils').PartTypeList;
const {extractSpecimen, extractTime, getAdjustedComponentByModifier} = require('./lib/labNameParser');
const EX_UCUM = 'example ucum'; // field name

// To be populated in getMgr();
let getUnitProperties, theLoincTableUtil;

module.exports = {getMgr}

function getMgr(loincTableUtil, unitToPropertiesMapper) {
  theLoincTableUtil = loincTableUtil;
  getUnitProperties = unitToPropertiesMapper;

  return {
    inferAndValidate,
    partsCompatible,
    getXformedRawUnit
  }
}

/**
 * Test if the two given LOINC parts are compatible. Normally they must be strictly the same but
 * there are some special rules for the purpose of judging if a LOINC mapping is correct
 * @param partType LOINC part type
 * @param p1 part name 1
 * @param p2 part name 2
 * @param row optional, the data raw, whose CLASS, and potentially other fields may be used.
 */
function partsCompatible(partType, p1, p2, row) {
  let bothInList = (plist, p1, p2) => plist.includes(p1) && plist.includes(p2);
  let lnClass = row && row.CLASS || '';

  if( p1 === p2 || !p1 && !p2) return true;
  if(!p1 || !p2) return false;

  if(partType === 'SCALE' && bothInList(['Qn', 'OrdQn'], p1, p2)) return true;
  if(partType === 'SYSTEM') {
    if(lnClass === 'UA' && bothInList(['Urine', 'Urine sed'], p1, p2)) return true;
    if(lnClass === 'COAG' && bothInList(['PPP', 'Plas', 'Ser/Plas'], p1, p2)) return true;
    if(bothInList(['Ser', 'Plas', 'Ser/Plas', 'Ser/Plas/Bld'], p1, p2)) return true;
    if(bothInList(['Urine', 'Urine+Ser', 'Urine+Ser/Plas'], p1, p2)) return true;
    if(bothInList(['CSF', 'Ser+CSF', 'Ser/Plas+CSF'], p1, p2)) return true;
  }

  let isCompatible = (getPartSynonyms(partType, p1) || []).includes(p2) || (getPartSynonyms(partType, p2) || []).includes(p1);

  return isCompatible;
}



/**
 * Run the unit-based validator to set initial validation status, then
 * parse out LOINC parts from raw name and/or raw unit and use as basis to further flag problematic mappings.
 * @param row the pcornet data row
 * @param altUnits all (well, all we can do) unit forms (e.g., ucum) derived from the raw unit
 * @param rowNum 0-based row number, for troubleshooting only
 */
function inferAndValidate(row, altUnits, rowNum) {
  let propsOfUnits = altUnits.reduce((acc, unit) => {
    getUnitProperties(unit).forEach(prop => acc[prop] = true);
    return acc;
  }, {});
  propsOfUnits = Object.keys(propsOfUnits);

  // setting algo-judgement based on certian manual judgement cateogries - OK if no manual judgement
  if(!row.ALGO_JUDGEMENT === 'NON_QN' && ! row.ALGO_JUDGEMENT.startsWith('WACKO')) {
    row.ALGO_JUDGEMENT = 'CORRECT_aj'; // default, will detect discrepancies
  }

  inferComponentByModifier(row);
  inferLoincSystem(row);
  inferLoincTime(row); // also infer some properties
  inferScaleAndProperty(row, altUnits, propsOfUnits, rowNum);
  inferWithHfpLpf(row, altUnits, propsOfUnits, rowNum);
  inferLoincPartsUAxPF(row);
  inferLoincPartsCDxAntibody(row);

  let props = row.inferred && row.inferred.PROPERTY && row.inferred.PROPERTY.names || [row.PROPERTY];
  if(row.SYSTEM === 'Urine' && props.includes('SRto') && !row.COMPONENT.endsWith('/Creatinine')) {
    let component = row.COMPONENT + '/Creatinine';
    if(theLoincTableUtil.hasLoincWithPart('COMPONENT', component)) {
      addInferredLoincParts(row, 'COMPONENT', [component], 'inferred');
      addAlgoIssueAndJudgementIfPartsDisagree(row, 'COMPONENT', [component], 0.8);
      //console.log('#%sUsing constructed component: %s', row.ROW_NUM, component);
    }
    else {
      //console.log('#### ERROR: constructed component does not exist:', component);
    }
  }

  combineInferredParts(row);
}


/**
 * Infer the correct component based on the raw lab name and the mapped to component using the
 * modifier (e.g., .free, ^peak, etc.) balance, restricted to certain classes.
 * IMPORTANT: such inferred component is recorded ONLY IF such component exists in the LOINC table.
 *            relaxing/removing this rule will cause many false incorrect judgements
 * @param row the pcornet data row
 */
function inferComponentByModifier(row) {
  let status = getAdjustedComponentByModifier(row);
  if(status.component) {
    if(theLoincTableUtil.hasLoincWithPart('COMPONENT', status.component)) {
      addInferredLoincParts(row, 'COMPONENT', [status.component], 'inferred');
      addAlgoIssueAndJudgementIfPartsDisagree(row, 'COMPONENT', [status.component], 0.8);
    }
    else {
      //console.log('#%s WARN: constructed component does not exist, ignored:', row.ROW_NUM, status.component);
    }
  }
}

/**
 * Infer SYSTEM (specimen) from the given record:
 * - parse out system/specimen from the raw name, and if still not found,
 * - assume "Bld" if:
 *   -- the mapped class is HEM/BC and mapped system starts with "bld" (case insensitive)
 * @param row
 */
function inferLoincSystem(row) {
  let sysUpper = row.SYSTEM && row.SYSTEM.toUpperCase() || '';

  let type='parsed';
  let inferredSystem = extractSpecimen(row).map(entry => entry.value); // array of {type, pattern, value, regex}
  if(! inferredSystem.length && sysUpper && sysUpper.startsWith('BLD') && sysUpper !== 'BLD' && row.CLASS === 'HEM/BC') {
    type = 'inferred';
    inferredSystem = ['Bld']; // TODO: flag type? Is it strong enough to flag a record wrong?
  }

  if(inferredSystem.length) {
    addInferredLoincParts(row, 'SYSTEM', inferredSystem, type);
    addAlgoIssueAndJudgementIfPartsDisagree(row, 'SYSTEM', inferredSystem, 0.6);
  }
}


/**
 * Infer TIME from the record, in some cases the property can be "deduced", too.
 * - parse out time if unit contains "24 h" or similar time duration, accordingly,
 *   if the mapped property is *Cnc, it can be inferred that the property should be *Rat.
 * - otherwise, if name contains random, spot, etc., it's Pt, accordingly,
 *   if the mapped property is *Rat, it can be inferred that the property should be *Cnc.
 * @param row
 */
function inferLoincTime(row) {
  let inferredProperty;
  let mappedToProp = row.PROPERTY || '';

  let inferredTime = extractTime(row.RAW_UNIT, 'RAW_UNIT').map(entry => entry.value);
  if(inferredTime.length) {
    // If time is duration (e.g., 24H) and property is *Cnc, it should be rate (*Rat)
    if(inferredTime[0].match(/^[0-9]+H$/) && mappedToProp.endsWith('Cnc')) { // also change property to *Rat (e.g., MRat)
      inferredProperty = [mappedToProp.substr(0,mappedToProp.length - 3) + 'Rat'];
    }
  }
  else {
    inferredTime = extractTime(row.RAW_LAB_NAME, 'RAW_LAB_NAME').map(entry => entry.value);
    if(inferredTime.length) {
      // If time is Pt, the property should be *Cnc if it were rate (*Rat)
      if (inferredTime[0] === 'Pt' && mappedToProp.endsWith('Rat')) { // also change property to *Rat (e.g., MRat)
        inferredProperty = [mappedToProp.substr(0, mappedToProp.length - 3) + 'Cnc'];
      }
    }
  }

  if(inferredTime && inferredTime.length) {
    addInferredLoincParts(row, 'TIME', inferredTime, 'parsed');
    addAlgoIssueAndJudgementIfPartsDisagree(row, 'TIME', inferredTime, 0.5);
  }
  if(inferredProperty) {
    addInferredLoincParts(row, 'PROPERTY', inferredProperty, 'inferred');
    addAlgoIssueAndJudgementIfPartsDisagree(row, 'PROPERTY', inferredProperty, 0.6);
  }
}


/**
 * Here are the basic rules:
 * - the presence of raw unit indicates the scale is Qn (inferred scale)
 * - the properties implied by the raw unit (and its other mapped forms) are inferred properties.
 * See inferLoincParts() on params and other details.
 * @param row
 * @param altUnits
 * @param unitProperties properties implied by the unit(s)
 * @param rowNum
 */
function inferScaleAndProperty(row, altUnits, unitProperties, rowNum) {
  // restrict unitProperties to the mapped-to class if unit is/contains "%"
  if(row.RAW_UNIT.indexOf('%') >= 0) {
    unitProperties = theLoincTableUtil.getPctUnitPropertiesByClass(row.CLASS);
    if(unitProperties.length) {
      //console.log('==== found property for percent by class %s: %s', row.CLASS, unitProperties);
    }
  }
  // Interpretation in name implies SCALE ['Nom', 'Nar', 'Ord', 'Doc'], PROPERTY=['Imp']
  let isInterpretation = row.RAW_LAB_NAME.toUpperCase().indexOf('INTERPRETATION') >= 0;

  let scale = isInterpretation? ['Nom','Nar','Ord','Doc']: row.RAW_UNIT? ['Qn']: null;
  if(scale) {
    if(addAlgoIssueAndJudgementIfPartsDisagree(row, 'SCALE', scale, 1.0)) {
      addInferredLoincParts(row, 'SCALE', scale, 'inferred'); // only add if there are issues to avoid too much noise
    }
  }

  let property = isInterpretation? ['Imp']: unitProperties.length? unitProperties: null;
  if(property) {
    if(addAlgoIssueAndJudgementIfPartsDisagree(row, 'PROPERTY', property, 0.6)) {
      addInferredLoincParts(row, 'PROPERTY', property, 'inferred');  // only add if there are issues to avoid too much noise
    }
  }
}

/**
 * Extracting the key "HPF" or "LPF" in method or unit
 * @param unitOrMethod the given unit or method string
 * @return HPF or LPF as extracted, or null if not.
 */
function extractHpfLpf(unitOrMethod){
  if(! unitOrMethod) return null;
  unitOrMethod = unitOrMethod.toUpperCase().replace(/\s*]\s*$/, '');
  return unitOrMethod.endsWith('HPF')? 'HPF': unitOrMethod.endsWith('LPF')? 'LPF': null;
}


/**
 * Infer method where possible when the raw unit is HPF/LPF.
 * @param row
 * @param altUnits
 * @param unitProperties
 * @param rowNum
 */
function inferWithHfpLpf(row, altUnits, unitProperties, rowNum) {
  let rawXpf = altUnits.reduce((acc, unit) => acc? acc: extractHpfLpf(unit), null);
  if(rawXpf) {
    let methodXpf = extractHpfLpf(row.METHOD);
    let mappedXpf = methodXpf || extractHpfLpf(row[EX_UCUM]);
    if(mappedXpf && mappedXpf !== rawXpf) {
      addAlgoMappingIssue(row, [mappedXpf, rawXpf].join('-'), 1.0);
      row.ALGO_JUDGEMENT = 'INCORRECT_aj';
      if(methodXpf) {
        addInferredLoincParts(row, 'METHOD', [row.METHOD.replace(mappedXpf, rawXpf)], 'inferred');
      }
    }
  }
}


/**
 * Add to row.ALGO_MAPPING_ISSUES and update ALGO_JUDGEMENT to INCORRECT_aj if the
 * inferred parts disagree with the mapped parts.
 * @param row
 * @param partType
 * @param inferredPartNames
 * @param confidence a number from 0 to 1.0, which may be turned on/off (not currently used).
 * @param absenceOK optional default true; when true and no mapped part for the type, then it's not an issue (don't add)
 * @return true if added or if the same issue is already there, false otherwise (no parts disagrements)
 */
function addAlgoIssueAndJudgementIfPartsDisagree(row, partType, inferredPartNames, confidence, absenceOK = true) {
  if(!inferredPartNames.length || absenceOK && !row[partType]) {
    return false;
  }
  let inferredWithSynonyms = inferredPartNames.slice();
  addPartSynonyms(partType, inferredWithSynonyms)

  // issue of absence already addressed above
  if(! row[partType] || ! inferredWithSynonyms.some(partName => partsCompatible(partType, partName, row[partType], row))) {
    addAlgoMappingIssue(row, partType, confidence);
    row.ALGO_JUDGEMENT = 'INCORRECT_aj';
    return true;
  }
  return false;
}


/**
 * The purpose of this function is to make the ALGO_MAPPING_ISSUES consistent and making it easier
 * for future changes as needed.
 * @param row the pcornet data row
 * @param type issue type, e.g., loinc part type or other issue, should be a "token" for potential parsing down the road
 * @param confidence confidence score that should be between 0.0 to 1.0
 */
function addAlgoMappingIssue(row, type, confidence) {
  addRowUpdates(row, 'ALGO_MAPPING_ISSUES', [type]);
}


/**
 * Add (not replace) the given values to the given field (whose value is a list)
 * @param row
 * @param fieldName
 * @param newValues
 * @param unique optional default true. When true, will ensure the resulting values are unique.
 */
function addRowUpdates(row, fieldName, newValues, unique = true) {
  let currValues = row[fieldName] = row[fieldName] || [];
  newValues.forEach(value => {
    if(! unique || !currValues.includes(value)) {
      currValues.push(value);
    }
  });
}


/**
 * Add to inferred LOINC parts, row.inferred, which is a hash from part type to a hash with two fields:
 * - names: part names list
 * - types: inferred, parsed, potentially others types. Type list corresponding to the names list.
 * Names are unique; adding names that already exists have no effect.
 * @param row the row to add to.
 * @param loincPart
 * @param newPartNames
 * @param inferType e.g., "inferred", "parsed"
 */
function addInferredLoincParts(row, loincPart, newPartNames, inferType) {
  if(! PartTypeList.includes(loincPart) || !newPartNames.length) {
    throw new Error('addInferredLoincParts - invalid input:', [loincPart, newPartNames]); // should not happen
  }
  row.inferred = row.inferred || {};
  row.inferred[loincPart] = row.inferred[loincPart] || {names:[], types:[]};
  let {names, types} = row.inferred[loincPart];

  newPartNames.forEach(partName => {
    if(!names.includes(partName)) {
      names.push(partName);
      types.push(inferType);
    }
  });
}


/**
 * Merge inferred LOINC parts of the same infer-type into one list and set as <type>_parts. Keeping the individual inferred
 * parts for other internal use. Inferred types: "inferred" and "parsed"
 * @param row
 */
function combineInferredParts(row) {
  if(! row.inferred) return;
  let mergedByInferType = {};
  Object.entries(row.inferred).filter(e => PartTypeList.includes(e[0])).forEach(([partType, info]) => {
    let typesToParts = {};
    let {names, types} = info;
    for(let i=0; i < names.length; ++i) {
      (typesToParts[types[i]] = typesToParts[types[i]] || []).push(names[i]);
    }
    Object.entries(typesToParts).forEach(([type, names]) => {
      let field = type + '_parts';
      names.sort();
      (mergedByInferType[field] = mergedByInferType[field] || []).push(util.format('%s=[%s]', partType, names.join(',')));
    });
  });
  Object.entries(mergedByInferType).forEach(([f, parts]) => {
    row[f] = parts.join('; ');
  });
}



/**
 * In some cases, raw unit needs to be transformed based on the data record, that is, sometimes units were
 * incorrectly used but can be fixed based on the context.
 * @param row
 */
function getXformedRawUnit(row) {
  let rawUnit = row.RAW_UNIT || '';
  if(rawUnit) { // there are other, earlier rules that directly changes RAW_UNIT
    if(/\bIU\b/.test(rawUnit) && /.*ase\b/i.test(row.RAW_LAB_NAME)) { // fix IU unit and use it for ucum mapping
      rawUnit = rawUnit.replace(/\bIU\b/, 'U');
    }
    else if(rawUnit.endsWith(' Cr')) {
      rawUnit = rawUnit.slice(0, -3).trim();
    }
  }
  return rawUnit;
}


/**
 * Infer LOINC parts for class UA where raw unit signifies LPF/HPF.
 * For UA, all possible specimens are: XXX, Urine, Urine sed, and CSF,
 * where CSF has one record in LOINC table and not applicable here either.
 * Therefore, for UA, can assume the specumen is either Urine or Urine sed.
 * @param row
 */
function inferLoincPartsUAxPF(row) {
  let rawXpf = extractHpfLpf(row.RAW_UNIT);
  let mappedXpf = extractHpfLpf(row.METHOD) || extractHpfLpf(row[EX_UCUM]);
  let methodWrong = rawXpf !== mappedXpf && (mappedXpf || row.METHOD.startsWith('Microscopy.light'));

  if(row.CLASS === 'UA' && rawXpf &&
    (row.SCALE !== 'Qn' || row.PROPERTY !== 'Naric' || methodWrong)) {
    // {SYSTEM: ['Urine', 'Urine sed'], PROPERTY: ['Naric'], SCALE: ['Qn'], METHOD: ['Microscopy.light.' + rawXpf]};
    addInferredLoincParts(row, 'SYSTEM', ['Urine', 'Urine sed'], 'inferred'); // just safeguard against Urine/Urine sed mismatch
    if(row.SCALE !== 'Qn') {
      addInferredLoincParts(row, 'SCALE', ['Qn'], 'inferred');
      addAlgoIssueAndJudgementIfPartsDisagree(row, 'SCALE', ['Qn'], 0.5);
    }
    if(row.PROPERTY !== 'Naric') {
      addInferredLoincParts(row, 'PROPERTY', ['Naric'], 'inferred');
      addAlgoIssueAndJudgementIfPartsDisagree(row, 'PROPERTY', ['Naric'], 0.5);
    }
    if(methodWrong) {
      let method = ['Microscopy.light.' + rawXpf];
      addInferredLoincParts(row, 'METHOD', method, 'inferred');
      addAlgoIssueAndJudgementIfPartsDisagree(row, 'METHOD', method, 0.5);
    }
  }

  if(row.ROW_NUM === 4550) {
    console.log('#4550 inferLoincPartsUAxPF: rawXpf=%s; mappedXpf=%s; scale=%s; prop=%s; inferred=%s', rawXpf, mappedXpf, row.SCALE, row.PROPERTY, JSON.stringify(row.inferred));
  }
}


/**
 * There is this pattern where the raw name is "CD<num> Antibody" but the current mapping isn't mapping the
 * record to  CELLMARK class. CD10 ANTIBODY
 * @param row
 */
function inferLoincPartsCDxAntibody(row) {
  let nameMatch = row.RAW_LAB_NAME && row.RAW_LAB_NAME.match(/^CD([0-9]+) ANTIBODY$/i);
  if(nameMatch && row.CLASS !== 'CELLMARK' &&
    row.SPECIMEN_SOURCE && row.SPECIMEN_SOURCE.toUpperCase() === 'BLD' &&
    row.RAW_UNIT && row.RAW_UNIT.indexOf('%') >= 0) {

    Object.entries({
      COMPONENT: util.format('Cells.CD%s/100 cells', nameMatch[1]),
      CLASS: 'CELLMARK', PROPERTY: 'NFr', SCALE: 'Qn', TIME: 'Pt', SYSTEM: 'Bld'
    }).forEach(([partType, value]) => {
      if(row[partType] !== value) {
        addInferredLoincParts(row, partType, [value], 'inferred');
        addAlgoIssueAndJudgementIfPartsDisagree(row, partType, [value], 0.5);
      }
    });
    // console.log('CDX ANTIBODY detected, row=%s; name=%s', row.ROW_NUM, row.RAW_LAB_NAME);
  }
}
