
const csvReader = require('./csvReader');
const {copyFields, setOR, setAND} = require('./common');
const PartTypeList = ['CLASS', 'COMPONENT', 'PROPERTY', 'TIME', 'SYSTEM', 'SCALE', 'METHOD'];

// See getLoincTableUtil for more details
let loincTable, loincUtils, loincToParts, partLowerToName, getUnitProperties;

module.exports = {
  PartTypeList,
  getLoincTableUtil,
  loadLoincTable
}

/**
 * Initialize the loinc table util
 * @param loincTableFile The Loinc.csv file path (downloadable from http://loinc.org)
 * @param unitPropXlsx excel file for unit-properties mapping (the combined mapping file).
 * @return a promise that resolves to a hash with the following fields:
 *           loincTable: full loinc table rows (as a list)
 *           loincToParts: loinc# to a map of 6 loinc parts plus LOINC_NUM, LONG_COMMON_NAME,
 *                         STATUS, EXAMPLE_UCUM_UNITS, and CLASS.
 *                         ** NOTE THAT ** except for LOINC_NUM, LONG_COMMON_NAME, all keys mapped to a **list**
 *                         with zero or one value (part name) in it.
 *           getStdPartName: a function that takes a part name (with potential case error) and type and return the
 *                           correct part name
 *           getUnitToPropertiesMapper: a function that returns a function for getting the list of properties for a
 *                                      given unit.
 */
function getLoincTableUtil(loincTableFile, unitPropXlsx) {
  /**
   *  Getting standard LOINC part name using a name potentially with incorrect casing
   *  @param name the part name with potential case error
   *  @param type the part type name, e.g., PROPERTY, not that CLASS is consider a part here although it's not
   *  @return the standard LOINC part name or empty string if does not exist
   */
  function getStdPartName(name, type) {
    return name && (name = name.trim().toLowerCase()) && partLowerToName[type] && partLowerToName[type][name] || '';
  }

  /**
   * Get the function that maps a given unit to the list of LOINC properties, or empty list if none.
   * See loadUnitToPropertiesMapping() for parameters and other details.
   * @param unitPropXslxFile see
   * @return a function that maps a  given unit to the list of LOINC properties, or empty list if none
   */
  function getUnitToPropertiesMapper(unitPropXslxFile) {
    if(getUnitProperties) return getUnitProperties;

    let unitToPropertiesMap = loadUnitToPropertiesMapping(unitPropXslxFile);
    getUnitProperties = (unit) => unit && unitToPropertiesMap[unit] || [];
    return getUnitProperties;
  }

  return new Promise((resolve, reject) => {
    if(loincUtils) {
      resolve(loincUtils);
    }
    loadLoincTable(loincTableFile).then(loincs => {
      loincTable = loincs;
      partLowerToName = PartTypeList.reduce((acc, type) => {acc[type] = {}; return acc;}, {});
      loincToParts = {};

      loincs.forEach(row => {
        // build loinc to parts map
        let parts = loincToParts[row.LOINC_NUM] =
          loincToParts[row.LOINC_NUM] || (copyFields(row, {}, ['LOINC_NUM', 'LONG_COMMON_NAME', 'STATUS', 'EXAMPLE_UCUM_UNITS']));
        PartTypeList.forEach(partType => {
          if(row[partType]) {
            parts[partType] = [ row[partType] ];
            partLowerToName[partType][row[partType].toLowerCase()] = row[partType];
          }
          else {
            parts[partType] = [];
          }
        });
      });
      let loincPartIndexex = buildLoincPartsIndex(loincToParts);
      loincUtils = {loincTable, loincToParts, getStdPartName, getUnitToPropertiesMapper,
        getLoincForParts: (partTypeNames) => getLoincForPartsInternal(loincPartIndexex, partTypeNames),
        hasLoincWithPart: (partType, partName) => !!loincPartIndexex[partType][partName]
      };
      if(unitPropXlsx) {
        getUnitToPropertiesMapper(unitPropXlsx);
        loincUtils.getPctUnitPropertiesByClass = getFuncForPctUnitPropertiesByClass(); // required loincUtil so do it separatelys
      }
      resolve(loincUtils);
    });
  });
}


/**
 * Load the Loinc.csv file (from loinc.org), with some of the field names renamed as follow:
 * 'TIME_ASPCT', 'SCALE_TYP', and 'METHOD_TYP' are renamed to 'TIME', 'SCALE', and 'METHOD' respectively.
 * @param loincFileCSV path to the Loinc.csv file (that can be downloaded from https://loinc.org
 * @param fields optional, if provided, will only include those fields in the results
 * @return {Promise<unknown>} a promise that resolves to the list of LOINC records where each record is a map
 *         from field name to field value.
 */
function loadLoincTable(loincFileCSV, fields) {
  return new Promise((resolve, reject) => {
    csvReader.read(loincFileCSV, {columns: true}).then(loincs => {
      // adjust loinc part names, e.g, TIME_ASPECT  to TIME
      loincs.forEach(loinc => {
        ['TIME_ASPCT', 'SCALE_TYP', 'METHOD_TYP'].forEach(f => {
          let nf = f.split('_')[0];
          loinc[nf] = loinc[f] || '';
          delete loinc[f];
        });
      });
      if(fields && fields.length) {
        loincs = loincs.map(rec => {
          let subRec = {};
          for(let f of fields) {
            if(rec.hasOwnProperty(f)) {
              subRec[f] = rec[f];
            }
          }
          return subRec;
        });
      }
      resolve(loincs);
    }).catch((err) => {
      reject('Error occurred loading LOINC table: ' + err);
    });
  });
}


/**
 * Build a map from a unit to a list of LOINC properties, based on unit-ucum-property tab in the
 * combined-mapping-files.xlsx.
 * @param unitPropXslxFile the xlsx file
 * @return the mapping described above.
 */
function loadUnitToPropertiesMapping(unitPropXslxFile) {
  let {getXlsxSheetJson, delimitedToList, addToValueList} = require('./common');
  let unitUcumPropSheet = 'unit-ucum-properties';
  let unitProps = getXlsxSheetJson(unitPropXslxFile, unitUcumPropSheet); // "require" here to avoid circular dependency

  unitProps.forEach(row => { // field renaming and to ensure consistent naming in the code
    row.ucum = row.ucum || row['ucum unit']; delete row['ucum unit'];
    row.UNITS = row.UNITS || row['Raw UNITS']; delete row['Raw UNITS'];
    if(typeof row.UNITS !== 'string') row.UNITS = row.UNITS + ''; // fix one numeric value, wrong, but.
  });
  console.log('==== unit-ucum-properties (properties): %s', unitProps.length);

  unitProps = unitProps.filter(row =>
    (row.UNITS || row.ucum && row.ucum.indexOf('?') < 0) && row.LOINC_PROPERTY && row.LOINC_PROPERTY.indexOf('?') < 0);
  console.log('%d rows of unit-properties after filtering', unitProps.length);

  // currently including all 3 unit columns: UNITS, DISPLAY_NAME, ucum.
  let unitToProps = unitProps.reduce((acc, row) => {
    let prop = loincUtils.getStdPartName(row.LOINC_PROPERTY, 'PROPERTY');
    let addEntry4Units = (units, opts) => {
      units = delimitedToList(units, ';');
      units.forEach(unit => {
        addToValueList(acc, unit, prop, opts);
      });
    }
    addEntry4Units(row.UNITS, {unique: true});
    addEntry4Units(row.DISPLAY_NAME, {unique: true});
    addEntry4Units(row.ucum, {unique: true, first: true});
    return acc;
  }, {});

//  console.log('\n==== Unit-properties: %d entries\n%s', Object.keys(unitToProps).length, JSON.stringify(unitToProps, null, 4));

  return unitToProps;
}


if(require.main === module) {
  let [combinedMappingFile, loincTableFile] = process.argv.slice(2);
  testGetUtil().then(() => {console.log('== DONE ==')});

  function testGetUtil() {
    return getLoincTableUtil(loincTableFile, combinedMappingFile).then(loincUtil => {
      for(let name of ['scnc', 'ssss']) {
        console.log('PartName: %s ==> %s', name, loincUtil.getStdPartName(name, 'PROPERTY'));
      }
      let getUnitPropsFunc = loincUtil.getUnitToPropertiesMapper(combinedMappingFile);
      for(let unit of ['mg/dL', 'whatever']) {
        console.log('UnitProperty: %s ==> %s', unit, getUnitPropsFunc(unit));
      }
    });
  }
}


/**
 * Create indexes that map LOINC parts to the set of LOINC numbers, e.g.,
 * {PROPERTY: {SCNC: {SET '123-4', '234-5'}}}
 * @param loincToParts a map that maps a LOINC# to the record.
 * @return See the description above
 */
function buildLoincPartsIndex(loincToParts) {
  let partIndexes = PartTypeList.reduce((acc, pt) => {acc[pt] = {}; return acc;}, {}); // part to loinc# mapping
  PartTypeList.forEach(pt => {
    Object.entries(loincToParts).forEach(([loinc, rec]) => {
      let partName = rec[pt] || '';
      (partIndexes[pt][partName] = partIndexes[pt][partName] || new Set()).add(loinc);
    });
  });
  return partIndexes;
}


/**
 * Get the SET of LOINC numbers with the given part types and (part name) values
 * @param partIndexes see buildLoincPartIndexes
 * @param partTypeNames a hash of part type name to part name list, e.g., {TIME: [Pt], PROPERTY:[MCnc, SCnc]}
 *        The the conditions between part types are "AND", and part names within each part type are "OR".
 * @return a set of LOINC numbers meeting the requirement
 */
function getLoincForPartsInternal(partIndexes, partTypeNames) {
  let toAND = Object.entries(partTypeNames).map(([partType, partNames]) => {
    let toOR = partNames.map(partName => partIndexes[partType][partName] || new Set());
    return setOR(...toOR);
  });
  return setAND(...toAND);
}


/**
 * Get the function that can be used to get the list of properties for the unit "%" that is restricted to the
 * given classes.
 * @return a function that takes one parameter that is the LOINC class. The function returns the list of properties
 *         compatible with the unit "%" and the given class. Return empty list if no such properties.
 */
function getFuncForPctUnitPropertiesByClass() {
  let pctProps = getUnitProperties('%');
  let propsByClass = {}; // CLASS to the list of properties compatible with that class
  loincUtils.loincTable.forEach(loinc => {
    if(pctProps.includes(loinc.PROPERTY)) {
      propsByClass[loinc.CLASS] = propsByClass[loinc.CLASS] || [];
      if(!propsByClass[loinc.CLASS].includes(loinc.PROPERTY)) {
        propsByClass[loinc.CLASS].push(loinc.PROPERTY);
      }
    }
  });
  propsByClass.COAG = propsByClass.COAG.filter(p => p !== 'ACnc');
  //console.log('percent-unit-props-by-class:', JSON.stringify(propsByClass, null, 4));
  return (lnClass ) => propsByClass[lnClass] || [];
}


/**
 * Returns a promise that resolves to a map from part-type to a hash of:
 *   PartName to record
 * plus a top level (same as part-type) field PartNumber that maps part# to the record, regardless of part-type
 * @param loincPartFile optional, default to the loincPartCSV defined at the top of this file
 * @return {Promise<unknown>}

function loadLoincParts(loincPartFile) {
  loincPartFile = loincPartFile || loincPartCSV;
  return new Promise((resolve, reject) => {
    csvReader.read(loincPartFile, {columns: true}).then(rows => {
      let partMappings = rows.reduce((acc, row) => {
        let typeMapping = acc[row.PartTypeName] = acc[row.PartTypeName] || {};
        typeMapping[row.PartName] = row; // PartName should be unique within a type
        // adding a top level (in addition to each part type) PartNumber field that maps part# to the row, across types
        (acc.PartNumber = acc.PartNumber || {})[row.PartNumber] = row;
        return acc;
      }, {});
      resolve(partMappings);
    });
  });
}
*/