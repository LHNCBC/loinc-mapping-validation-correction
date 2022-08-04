
// Use a set of custom rules based on LOINC parts and other attributes to do some custom unit mapping
// This is based on Clem's word file (somehow renamed as):
//    clem-2020-08-09-12-42-LOINC-map-fix-for-ExUCUMSr-xluan.docx

// Rules used to fix the unit in a given record - picking the first rule that matches and stop.
let RuleFields = ['CLASS', 'COMPONENT', 'PROPERTY', 'NOT_PROPERTY'];
// Note that all values of fields in RuleFields will be converted to upper-case.
// Units are sensitive and will not be covnerted.
let caseInsensitive = true; // keep for backward compatibility, not respected by mapUnitForRec2()
let rulesDisabled = [6, 10]; // 7th and 11th
let rulesCaseSensitive = [
  {
    UNIT: ['kU/L', 'kAU/L'],
    CLASS: ['ALLERGY'],
    MapTO: 'k[IU]/L'
  },
  {
    UNIT: ['U/mL', 'AU/mL', 'AU'],
    CLASS: ['ALLERGY'],
    MapTO: '[IU]/mL'
  },
  {
    UNIT: ['%'],
    CLASS: ['CHEM'],
    COMPONENT: ['ACETONE', 'METHANOL', 'ETHANOL', 'ISOPROPANOL'],
    MapTO: 'dL/mL'
  },
  // #### 4 - 6
  {
    UNIT: ['IU/L', '[IU]/L', 'UNITS/L', 'Units/L', 'units/L'], // TODO: word file has only two units
    CLASS: ['CHEM'],
    PROPERTY: ['CCnc'],
    MapTO: 'U/L'
  },
  {
    UNIT: ['Units', 'IU', '[IU]'],
    CLASS: ['CHEM'],
    PROPERTY: ['ACnc'],
    MapTO: "[arb'U]"
  },
  {
    UNIT: ['Units/mL', '[IU]/mL'],
    CLASS: ['CHEM'],
    PROPERTY: ['ACnc'],
    MapTO: "[arb'U]/mL"
  },
  // #### 7 - 9
  {
    UNIT: ['IU', 'IU/mL', 'U/mL', 'U', 'units/mL'],
    CLASS: ['SERO'],
    MapTO: "[arb'U]/mL"
  },
  // Round-2 starts here
  {
    UNIT: ['IU/mL', '[IU]/mL'],
    CLASS: ['CHEM'],
    PROPERTY: ['CCnc'],
    MapTO: "U/mL"
  },
  // This is about the catalytic stuff, which already converts fine.
  {
    // UNIT: ['nmol/h/mg Hb'], //The entry with "See list below", but all others are already working fine.
    UNIT: ['nmol/h/mg{protein}', 'U/g{Hb}', 'U/g Hb', 'nmol/min/mg protein', 'U/g Hb}', 'nmol/min/mg{protein}', 'mU/g{Hb}', 'nmol/h/mg Hb', 'IU/g', '[IU]/g'],
    CLASS: ['CHEM'],
    PROPERTY: ['CCnt'],
    MapTO: "U/g"
  },
  // #### 10 - 12
  {
    UNIT: ['Ug/24h', 'ug/72h'],
    CLASS: ['CHEM'],
    PROPERTY: ['MRat'],
    MapTO: "ug/(24.h)"
  },
  {
    UNIT: ['U/mL', 'm[IU]/L', 'u[IU]/ml', 'mU/L', 'uU/ML'],
    CLASS: ['CHEM'],
    NOT_PROPERTY: ['CCnc'],
    MapTO: "[arb'U]/mL"
  },
  {
    UNIT: ['nd/dL'],
    CLASS: ['CHEM'],
    COMPONENT: ['Progesterone'],
    MapTO: "ng/dL"
  },
  // #### 13 - 15
  {
    UNIT: ['AU', 'AU/ml', 'Index val', 'APL U/mL', 'MPS ISA', 'ARU', 'SGU', 'Bethesda', 'EU/dL',
      'E.U/dL', 'GPL u/mL', 'GPS IgM', 'MPL U/mL', 'MPS IgM','{index_val}', 'IV'],
    CLASS: ['CHEM', 'SERO'],
    MapTO: "[arb'U]/mL"
  },
  {
    UNIT: ['K/uL'],
    CLASS: ['HEM/BC'],
    PROPERTY: ['NCnc'],
    MapTO: "10*3/uL"
  },
  {
    UNIT: ['mm'],
    CLASS: ['HEM/BC'],
    PROPERTY: ['Vel'],
    MapTO: "mm/h"
  },
  // #### 16 - 18
  {
    UNIT: ['[IU]/g{Hb}', 'IU/g{Hb}', 'U/g{Hb}'],
    CLASS: ['CHEM'],
    PROPERTY: ['CCnt'],
    MapTO: "nmol/min/mg{protein}"
  },
  {
    UNIT: ["Ehrlich units", "EU", "[EU]","{Ehrlich’U}"],
    CLASS: ['CHEM'],
    COMPONENT: ['Urobilinogen'],
    MapTO: "mg/dL,[EU]"
  },
  {
    UNIT: ['{Log_copies}/mL' ,'log', 'log copies'],
    CLASS: ['MICRO'],
    PROPERTY: ['LnCnc'],
    MapTO: "{log copies}/mL"
  },
  // #### 19 - 20
  {
    UNIT: ['#/HPF','{#}/HPF','/HPF','/hpf', '/ hpf'],
    CLASS: ['UA'],
    PROPERTY: ['Naric'],
    MapTO: "/[HPF]"
  },
  {
    UNIT: ['#/LPF','{#}/LPF','/lpf'],
    CLASS: ['UA'],
    PROPERTY: ['Naric'],
    MapTO: "/[LPF]"
  },
  {
    UNIT: ['U/mL'],
    CLASS: ['COAG', 'SERO', 'CHEM', 'MICRO', 'HEM/BC'],
    MapTO: "[arb'U]/mL"
  }
].map(rule => {
  RuleFields.forEach(f => {
    if(rule[f]) {
      for(let i=0; i < rule[f].length; ++i) {
        rule[f][i] = rule[f][i].toUpperCase();
      }
    }
  })
  return rule;
});

let rulesCaseInsensitive = rulesCaseSensitive.map(rule => JSON.parse(JSON.stringify(rule)));
rulesCaseInsensitive.forEach(rule => {
  rule.UNIT = rule.UNIT.map(unit => unit.toUpperCase());
});

/**
 * Map the unit in the record to a new unit and return - the record itself is NOT changed.
 * @param rec input data record, expected to have RAW_UNIT column and LOINC part columns
 * @param unitField the name of the unit field to map from.
 * @param ci: case insensitive if true.
 * @return the unit the RAW_UNIT is mapped to (for use in validation), or null if not mapped.
 */
function mapUnitForRec(rec, unitField, ruleNum) {
  return mapUnitForRec2(rec, unitField, true, ruleNum);
}

function mapUnitForRec2(rec, unitField, ci, ruleNum) {
  let inUnit = rec[unitField || 'RAW_UNIT'];
  if(! inUnit) {
    return null;
  }
  let rulesSet = ci? rulesCaseInsensitive: rulesCaseSensitive;
  let fromUnit = ci? inUnit.toUpperCase(): inUnit;

  // <0: don't run any; 0/null/undefined: run all; otherwise ruleNum-1 to pick a rule to test.
  let rulesToApply = ruleNum < 0? []: ruleNum? [rulesSet[ruleNum-1]]: rulesSet;
  for(let rn = 0; rn < rulesToApply.length; ++rn) {
    let rule = rulesToApply[rn];
    if(! rule.UNIT.includes(fromUnit)) {
      continue;
    }
    if(rulesToApply.length > 1 && rulesDisabled.includes(rn)) {
      continue;
    }
    let fields = RuleFields.filter(f => rule[f]);
    let satisfied = true;
    for(let field of fields) {
      let uValue = rec[field] && rec[field].toUpperCase();
      if(field.startsWith('NOT_')) {
        if(uValue && rule[field].includes(uValue)) {
          satisfied = false;
        }
      }
      else if(!(uValue && rule[field].includes(uValue))) {
        satisfied = false;
        break;
      }
    }
    if(satisfied) {
      //console.log('====', fromUnit, rule.MapTO);
      return rule.MapTO;
    }
  }
  // do a round of hard-coded conversion
  return hardMapping(inUnit);
}


// hardcoded mapping.
let dotHourRegex = RegExp(/^([^\d]*)(\d+)([ ]*(HR|Hr|hr|HOUR|Hour|hour)[sS]?)(.*)$/);
let hourRegex = RegExp(/^(.*)((HR|Hr|hr|HOUR|Hour|hour)[sS]?)(.*)$/);
let spaceHRegex = RegExp(/^([^\d]*)(\d+)[ ]+h$/);
function hardMapping(fromUnit) {
  let result = null;
  let dotMatch = fromUnit.match(dotHourRegex);
  if(dotMatch) {
    result = fromUnit.replace(dotHourRegex, '$1($2.h)$5');
  }
  else {
    let hourMatch = fromUnit.match(hourRegex);
    if(hourMatch) {
      result = fromUnit.replace(hourRegex, '$1h$4');
    }
    /*
    else {
      let spaceHMatch = fromUnit.match(spaceHRegex);
      if(spaceHMatch) {
        result = fromUnit.replace(spaceHRegex, '$1($2.h)');
      }
    }
     */
  }
  if(! result && fromUnit.indexOf(' ') >= 0) {
    let noSpace = fromUnit.replace(/ /g, '');
    result = hardMapping(noSpace) || noSpace;
  }
  return result;
}


module.exports = {
  mapUnitForRec
}