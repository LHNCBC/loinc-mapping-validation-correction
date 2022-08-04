
// Parsing out LOINC parts from raw lab name or raw unit.
// . SYSTEM: parsing from the raw lab names
// . TIME: from raw lab name and from raw unit.
//
// A general framework has been designed that can be used to configure the parsing of LOINC parts out of a string -
// lab name, unit, or whatever.
// Each configuration entry can specify a pattern (string) or regex that can be used to match the raw record string,
// an extract function that used the pattern/regex to pull out LOINC parts, etc.
// See defaultLoincPartExtractionConfigMapper() for details on the configurations.


const {isNEU} = require('./common');
const util = require('util');

// ==== A framework for detecting and checking certain "balanced" keywords between the raw name and the mapped-to
// analyte/component. The configuration entry current has the following fields (some optional):
// - token: the keyword to look for on the LOINC side. A token is usually connected to the other parts of
//          the component with a connector, e.g., the dot in: xxx.free, or the hat in "xxx yyy^peak"
// - delim: the connector - see token above.
// - class: the list of LOINC classes the entry applies to, optional, default to ['CHEM', 'DRUG/TOX']
// - nameRegex: the regular expression used to find the keyword (may not be exact spelling) in the raw name,
//              optional, default to word-boundary search for the token above. Details see the code below.
// A few other modifiers proposed by Clem but not added due to issues (some processed in a custom way in the code)
// activated: couldn't find a way to construct the correct component with it
// fragments: two instances go in opposite directions: #1990 helps; #1958 hurts
// inhibitor: workable but if enforced, only hurts: #1991, #2027, #2961, #2962 (last 2 could fix "inhib")
// control: not seeing how it could help, and not used in components except for "control transcript"
// high sensitivity: sensitivity not used in components
// ag: not seeing value and involves many records
const componentModifiers = [
  // token, class (optional,default to [CHEM,DRUG/TOX]), delim (connector), nameRegex (optional)
  {token: 'bioavailable', connector: '.'},
  {token: 'bound', connector: '.'},
  {token: 'free', connector: '.', nameRegex: new RegExp("\\bfr|free\\b", 'i')},
  //{token: 'ionized', connector: '.'},
  {token: 'total', connector: '.'},
  {token: 'nucleated', connector: '.', class: ['CHEM', 'DRUG/TOX', 'HEM/BC']},
  //{token: 'intact', connector: '.'}, // causing isses?

  {token: 'panel', connector: ' '},

  {token: 'trough', connector: '^'},
  {token: 'peak', connector: '^'},
  {token: 'post dialysis', connector: '^'},
  {token: 'pre dialysis', connector: '^'},
  {token: 'standard', connector: '^^'},
].map(entry => {
  let m = entry.token;
  if(! entry.class && !['panel'].includes(m)) entry.class = ['CHEM', 'DRUG/TOX'];//, 'HEM/BC'];
  if(! entry.nameRegex) {
    let regexStr = m.indexOf(' ') > 0 ? util.format('(%s|%s|%s)', m, m.replace(' ', '-'), m.replace(' ', '')) : m;
    entry.nameRegex = new RegExp("\\b" + regexStr + "\\b", 'i');
  }
  entry.modifier = entry.connector + m;
  entry.isInName = function modInName(name) { return this.nameRegex.test(name); }
  entry.isInComponent = function modInComponent(component) {
    return typeof component === 'string' && component.indexOf(this.modifier) >= 0;
  }
  return entry;
});


//console.log('component modifiers:', JSON.stringify(componentModifiers, null, 4));


let applyRestrictions = true; // for test/experiment ONLY, whether to apply rule restrictions, i.e., mapToClass, unless.


/**
 * Default function that can be used to pre-process an entry in the loinc part extraction configuration, by mapping
 * such a configuration entry to one that can be used by the runExtractors() function.
 * The idea is the configuration entry can specify the parsing in simpler ways and this mapping function will
 * fill out the rest automatically, e.g., the regex (from "pattern" string) and a default extract() function that
 * uses the regex, etc. See the extractionConfig param description below for further details.
 * @param partType LOINC part type (to extract), this could go beyond LOINC parts.
 * @param rawRuleConfig A manually configured entry that could have some of the following entries:
 *        - extract: optional, a function that is used to extract the loinc part. Takes two parameters:
 *                     -- text: the text to extract from (could be unit string or any string)
 *                     -- row: optional - the pcornet data row (real or faked), some rules need the mapped-to loinc parts.
 *                   When specified, this function 100% controls the behavior and may choose to ignore everything else;
 *                   When absent, a default extractor will be used
 *        - pattern: optional, single pattern string or a list of pattern strings to look for, case-insensitive.
 *                   See partName and IMPORTANT NOTE below
 *        - regex: optional, the regex used to check the match, see IMPORTANT NOTE below
 *        - unless: optional, regex, if present, the specimen matching will be skipped if unless test to be true
 *                  -- try use mapToClass if at all possible.
 *        - mapToClass: optional, if specified, a list of mapped-to-classes for which the extraction rule applies
 *                      or not apply - each class can have an optional "!" prefix to indicate exclusion (not apply)
 *                      Normally either all inclusive or all exclusive. Undefined if mixed
 *        - partName: optional, the part name to use (extracted part name) when regex matches the given string.
 *                    IF NOT SPECIFIED, "pattern" must be specified as a single string (not an array), and "pattern"
 *                    is used as partName.
 *                    This could go beyond LOINC part and for other types of entities.
 *        - IMPORTANT NOTE: At least one of "pattern" and "regex" must appear.
 *                          When only one appears, it'll be used to generate the other.
 *                          The regex, provided or generated, is the one to use during matching.
 *        See specimenMatchers for an example.
 * @return {*} a new mapping configuration that is guaranteed to have the extract() function
 */
function defaultLoincPartExtractionConfigMapper(partType, rawRuleConfig) {
  let atLeastOneRequiredMsg = (p1, p2) =>
    util.format("At least one of %s or %s must be specified for %s extractors: %s", p1, p2, partType, rawRuleConfig);
  if(! rawRuleConfig.regex && ! rawRuleConfig.pattern) {
    throw new Error(atLeastOneRequiredMsg('pattern', 'regex'));
  }
  if(! rawRuleConfig.partName && (! rawRuleConfig.pattern || typeof rawRuleConfig.pattern !== 'string')) {
    throw new Error(atLeastOneRequiredMsg('pattern', 'partName'));
  }

  let extractorEntry = Object.assign({type: partType}, rawRuleConfig);
  extractorEntry.partName = extractorEntry.partName || extractorEntry.pattern;
  if(! rawRuleConfig.regex) {
    let patterns = Array.isArray(rawRuleConfig.pattern)? rawRuleConfig.pattern: [rawRuleConfig.pattern];
    extractorEntry.regex = new RegExp('\\b(' + patterns.join('|') + ')\\b', 'i');
  }
  extractorEntry.pattern = extractorEntry.pattern || ('' + extractorEntry.regex);
  if(rawRuleConfig.mapToClass) {
    if(rawRuleConfig.mapToClass[0][0] === '!') {
      extractorEntry.mapToClassExcl = rawRuleConfig.mapToClass.map(x => x.substr(1).trim());
    }
    else {
      extractorEntry.mapToClassIncl = rawRuleConfig.mapToClass.map(x => x); // copy
    }
    delete rawRuleConfig.mapToClass;
  }

  let toFilterOut = (rule, text, row) => { // returns true IFF the given data meets the filter-out condition
    return !applyRestrictions? false:  // this applyRestrictions flag is for some test/experiment purpose only.
      rule.mapToClassIncl && !rule.mapToClassIncl.includes(row.CLASS) ||
      rule.mapToClassExcl && rule.mapToClassExcl.includes(row.CLASS) ||
      rule.unless && rule.unless.test(text);
  }
  // the extractor function - if specified, this is the only thing that matters; if not, create one based on the config
  extractorEntry.extract = extractorEntry.extract || function(text, row) {
    text = isNEU(text)? '': text + '';
    return text && this.regex.test(text) && !toFilterOut(this, text, row || {})? this.partName: null;
  }

  return extractorEntry;
}


// Proposed but not yet added (not seeing benefits):
// - IVC (not finding it)
// - TODO: are we sure we want adrenal vein, renal vein: ???
// See the descriptions at the top of this file for for the general ideas, and see
//   defaultLoincPartExtractionConfigMapper()
// for details on possible fields and their definitions.
let specimenExtractors = [{
  pattern: ['CSF', 'CEREBROSPINAL FLUID'], partName: 'CSF'
}, {
  pattern: ['Urine', 'UA', 'Ur', 'urn'], partName: 'Urine', mapToClass: ['!ALLERGY']
}, {
  //pattern: ['salivary', 'saliva','oral fld','oral fluid'], partName: 'Saliva'
  pattern: ['saliva','oral fld','oral fluid'], partName: 'Saliva'
}, {
  pattern: ['plasma', 'plas'], partName: 'Ser/Plas', mapToClass: ['!CELLMARK', '!HEM/BC']
}, {
  pattern: ['red blood cell', 'red blood cells', 'RBC', 'RBCs'], partName: 'RBC', mapToClass: ['CHEM', 'DRUG/TOX']
}, {
  pattern: ['white blood cell','white blood cells', 'WBC'], partName: 'WBC', mapToClass: ['NEVER'] // disabled by class NEVER
}, {
  pattern: ['leukocyte', 'leukocytes', 'leucocyte', 'leucocytes'], partName: 'WBC', mapToClass: ['CHEM'] // TODO
}, {
  pattern: ['platelet', 'platelets'], partName: 'Platelets', mapToClass: ['NEVER'], unless: /\b(poor|rich) plasma\b/i // TODO
//}, {
//  pattern: 'packed red blood cell', partName: 'DOES NOT EXIXST'
}, {
  pattern: 'Bld'
}, {
  pattern: 'whole blood', partName: 'Bld'
}, {
  pattern: ['Stool', 'feces', 'fecal'], partName: 'Stool'
}, {
  pattern: 'serum', partName: 'Ser/Plas'
}, {
  pattern: 'tissue', partName: 'Tiss'
}, {
  pattern: 'pleural fluid', partName: 'Plr fld'
}, {
  pattern: 'pericardial fluid', partName: 'Pericard fld'
}, {
  pattern: 'peritoneal fluid', partName: 'Periton fld'
}, {
  pattern: 'dialysis fluid', partName: 'Dial fld'
}, {
  pattern: ['Body fluid', 'Body fld'], partName: 'Body fld', mapToClass: ['!UA'],
}, {
  pattern: ['Amniotic Fluid', 'Amnio fld'], partName: 'Amnio fld'
}, {
  pattern: ['fluid'], partName: 'Body fld', mapToClass: ['!UA'], unless: /\binfluenz/i,
}, {
  pattern: ['fld'], partName: 'Body fld', mapToClass: ['!UA'], unless: /\b(flu|influenz)/i,
}, {
  pattern: 'adrenal vein', partName: 'Adrenal vein'
}, {
  pattern: 'renal vein', partName: 'Renal vein'
}, {
  pattern: ['DBS', 'Dried blood spot'], partName: 'Bld.dot'
}, {
  pattern: 'Hair', partName: 'Hair', unless: /\b(animal|horse|cow)\b/i
}, {
  pattern: 'breath', partName: 'Exhl gas'
}, {
  pattern: ['inferior vena cava', 'IVC'], partName: 'Vena cava.inferior'
}, {
  pattern: ['Right adrenal vein', 'R adrenal Vein'], partName: 'Adrenal vein.right'
}, {
  pattern: ['Left adrenal vein', 'L adrenal Vein'], partName: 'Adrenal vein.left'
}, {
  pattern: ['blood capillary', 'capillary blood'], partName: 'BldC'
}, {
  pattern: 'Semen', partName: 'Semen'
}, {
  pattern: 'POC', partName: 'Bld', mapToClass: ['NEVER'] // disabled by class NEVER
}].map(mapping => defaultLoincPartExtractionConfigMapper('SYSTEM', mapping));

// TODO: not using it just yet, just documenting based on:
//       2021-07-30-Futher-rules-to-classify-lab-terms-pcornet.docx
let defaultSpecimenPerClass = {
  CHEM: 'Ser/Plas',
  ['DRUG/TOX']: 'Ser/Plas',
  ['HEM/BC']: 'Bld',
  COAG: 'PPP', // could be plasma - Clem's note
  MICRO: 'Ser' // IF compoenent contains "Ab.", this is still of low confidence per Clem
}

// See the descriptions at the top of this file for for the general ideas, and see defaultLoincPartExtractionConfigMapper()
// for details on possible fields and their definitions.
let timeExtractors = [{
  selector: 'RAW_LAB_NAME',
  pattern: 'random',
  partName: 'Pt'
}, { // disabled by class NEVER below
  selector: 'RAW_LAB_NAME',
  pattern: 'spot',
  partName: 'Pt',
  mapToClass: ['NEVER']
}, {
  selector: 'RAW_UNIT',
  regex: /\/\s*([0-9]+)\s*(h|hr|hrs|hour|hours)\s*$/i, // /<number>(h, hr, hrs, hour, hours) to <number>H TODO: how?
  extract: function(unit) {
    let m = isNEU(unit)? null: (unit + '').match(this.regex);
    return m? m[1] + 'H': null;
  },
  partName: 'N/A' // the custom extract() function above will produce the partName
}
].map(mapping => defaultLoincPartExtractionConfigMapper('TIME', mapping));

/**
 * Get the default specimen for a record - this is based on defaultSpecimenPerClass.
 * Strictly speaking, there is no such a thing as default specimen, but when specimen can not be parsed
 * out of the raw name and the record SPECIMEN_SOURCE does not have value.
 * This function does not check for those conditions and just return the default specimen. The caller
 * need to know when to use such default specimen.
 * @param row
 */
function getDefaultSpecimen(row) {
  return defaultSpecimenPerClass[row.CLASS];
}


/**
 * Try to find specimen candidates in the lab name and return as an array, return empty array if not found.
 * There could be more than one candidates if multiple rules match, and will be returned in the order of match.
 * This function may be called with either a single row parameter or a text and row parameter.
 * @param text the text (e.g., lab name) to extract from, "optional when row is specified", will row.RAW_LAB_NAME
 * @param row can be a record/row or just the string text to extract from. When it's a hash:
 *        - text will be pulled from input.RAW_LAB_NAME
 *        - may consider LOINC parts (e.g., PROPERTY, SYSTEM) and RAW_UNIT to further check/filter
 *          and make sure the extraction is valid. E.g., RBC with CLASS=UA will not be detected as specimen
 *        -- therefore, using a row with CLASS, etc., will result in safer extraction.
 * @return a list of results, see runExtractors() for more details
 */
function extractSpecimen(text, row) {
  if(typeof text === 'object') { // text parameter not given, this is the row
    row = text;
    text = row.RAW_LAB_NAME;
  }
  if(isNEU(text)) return [];

  return runExtractors(text + '', specimenExtractors, row || {});
}


/**
 * Parse out LOINC TIME part from raw data record, specifically, lab name or raw unit.
 * In theory there could be more than one results returned.
 * @param selector optional, narrow down the set of extractors to use,
 *        apply all extractors if not specified,
 * @param sourceValue the string value from which to extract the TIME
 * @param row optional parameter for the data row, may be used in some rules (not yet)
 * @return {[]} a list of extracted values, with fields: type (TIME), value (part name), and pattern
 */
function extractTime(sourceValue, selector, row) {
  return runExtractors(sourceValue, timeExtractors, row||{}, selector);
}


/**
 * Run the given extractors against the given value to extract the entity as defined by the rules.
 * @param extractors the extractors to run
 * @param sourceValue the string value from which to extract
 * @param selectors optional, a rules selector used to select the set of extractors to use, which can be a list of
 *        selector types or single selector string value.
 *        Currently only applicable to TIME parsing with possible selectors of RAW_LAB_NAME, RAW_UNIT.
 *        Apply all extractors if not specified.
 * @param row optional, the data row, with the mapped-to LOINC parts info to aid the rules
 * @return {[]} a list (empty list if no matches) of results objects with the following fields:
 *          type: the type of "thing" extracted, typically, a LOINC part type
 *          value: the extracted entity, e.g., LOINC part name (standardized)
 *          pattern: the pattern string to look for
 *          regex: the regex, directly specified or inferred from "pattern", used in the extraction.
 *                 use this with caution - some extractors may doing things their own way.
 *          selectors: if any, comma-space-separated list of selector names
 *          ==== NOTE that if a record matches multiple patterns, even when mapped to the same part, all matches will
 *          be returned, e.g., "serum plasma" will return two "Ser/Plas" entries, one for each serum and plasma pattern.
 */
function runExtractors(sourceValue, extractors, row, selectors) {
  row = row || {};
  if(selectors) selectors = Array.isArray(selectors)? selectors: [selectors];
  let extracted = [];
  if(! sourceValue) {
    return extracted;
  }

  sourceValue += '';
  for(let extractor of extractors) {
    if(!selectors || selectors.includes(extractor.selector)) {
      let extractedName = extractor.extract(sourceValue, row);
      if(extractedName) {
        let result = {type: extractor.type, value: extractedName, pattern: extractor.pattern, regex: extractor.regex};
        if(selectors) result.selector = selectors.join(', ');
        extracted.push(result);
        if(! applyRestrictions) { // this can only be experiment, so add a flag to show filtering status
          applyRestrictions = true;
          result.filtered_out = extractor.extract(sourceValue, row)? 'No': 'Yes';
          applyRestrictions = false;
        }
      }
    }
  }

  return extracted;
}


function getAdjustedComponentByModifier(row) {
  let result = getAdjustedComponentByModifierPredefinedRules(row);
  if(result.component || result.status === 'blank') {
    return result;
  }
  return getAdjustedComponentByModifierIgX(row);
}



/**
 * Based on balanced modifier (e.g., .free, ^peak, etc.), suggest alternative component.
 * Essentially:
 * - if the modifier shows in name but not in the mapped to component, add it to the component;
 * - if the modifier is not in name but is in the mapped to component, remove it from the component;
 * @param row the pcornet (results) data row, this function uses RAW_LAB_NAME, COMPONENT, and CLASS
 * @return return null if not found; otherwise, a hash with 3 fields:
 *         - component: the alternative component found. Only populated if status is "name" or "component"
 *         - modifier: the modifier applied
 *         - status: matching status, can be none, both, name, component, blank (one or both name/component are null/empty/undefine)
 */
function getAdjustedComponentByModifierPredefinedRules(row) {
  let [rawName, mappedComponent] = [row.RAW_LAB_NAME, row.COMPONENT];
  if(! rawName || ! mappedComponent) return {status: 'blank'};

  for(let m of componentModifiers) {
    if(m.class && !m.class.includes(row.CLASS)) {
      continue;
    }
    let [isInName, isInComponent] = [m.isInName(rawName), m.isInComponent(mappedComponent)];
    if(isInName && !isInComponent) {
      return {status: 'name', modifier: m.modifier, component: mappedComponent + m.modifier};
    }
    if(!isInName && isInComponent) {
      return {status: 'component', modifier: m.modifier, component: mappedComponent.substr(0, mappedComponent.length - m.modifier.length)};
    }
    if(isInName && isInComponent) {
      return {status: 'both', modifier: m.modifier};
    }
  }
  return {status: 'none'};
}

// IgA, IgE, IgG, IgM, IgG[1234]
function extractIgX(name) {
  let m = name && name.match(/\b(IgA|IgE|IgG[1234]?|IgM)\b/i);
  if(!m) return null;
  return m[1][0].toUpperCase() + m[1][1].toLowerCase() + m[1][2].toUpperCase() + m[1].substring(3);
}


// If IgX is in the raw name and IgY in the component, and IgX !== IgY, change IgY to IgX in the
// mapped-to component as new component
function getAdjustedComponentByModifierIgX(row) {
  let [igxInName, igxInComp] = [extractIgX(row.RAW_LAB_NAME), extractIgX(row.COMPONENT)];
  if(igxInName && igxInComp && igxInName !== igxInComp) {
    let component = row.COMPONENT.replace(igxInComp, igxInName);
    //console.log('==== IgX adjustment at #%s, %s: %s --> %s', row.ROW_NUM, row.RAW_LAB_NAME, row.COMPONENT, component);
    return {status: 'fixed', modifier: 'IgX', component};
  }
  return {status: 'none'}
}


module.exports = {
  extractSpecimen,
  extractTime,
  getAdjustedComponentByModifier,
  getDefaultSpecimen
}

//console.log('=== specimen-extractors:%s', JSON.stringify(specimenExtractors, null, 4));
//console.log('=== time-extractors:%s', JSON.stringify(timeExtractors, null, 4));

// For testing only
if(require.main === module) {
  ['blah plasma or serum', 'some whole blood test', 'partial blood', 'PH OF BODY FLUID',
    'xyz poc abc', 'xyz pocabc', 'xyz poc urine', 'fluid', 'oral fluid', 'saliva', 'mouse urine'].forEach(text => {
    console.log('SYSTEM: %s ===> %s', text, JSON.stringify(extractSpecimen(text, {CLASS: 'ALLERGY'})));
  });

  ['RAW_LAB_NAME', 'RAW_UNIT', ''].forEach(selector => {
    console.log('\n---- selector =', selector);
    ['some-1/24', 'some-2/24H', 'some-3/6Hrs', 'some-4/24Hx', 'spot test', 'random test', 'some random spot test'].forEach(text => {
      console.log('TIME: %s ===> %s', text, JSON.stringify(extractTime(text, selector)));
    });
  });
  let getAltComponentX = (RAW_LAB_NAME, COMPONENT) => getAdjustedComponentByModifier({RAW_LAB_NAME, COMPONENT, CLASS: 'CHEM'});
  [{name: 'xx post-dialysis', comp: 'abc^post dialysis'}, {name: 'xx postdialysis', comp: 'abc^post-dialysis'},
    {name:'move free', comp: 'what free'}, {name:'movefree', comp: 'what.free'}].forEach(({name, comp}) => {;
    console.log('ALT-COMP=%s: name=%s; comp=%s', JSON.stringify(getAltComponentX(name, comp)), name, comp);
  });
}
