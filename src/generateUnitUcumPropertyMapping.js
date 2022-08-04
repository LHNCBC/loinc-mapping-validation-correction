
// This is used to generate a unit-ucum-loinc_property 3-way mapping.
// We use a mapping table that has third party content and we can't make it public. This generated
// mapping (from LOINC) is not as comprehensive but not too far off.

const {loadLoincTable} = require('./lib/loincUtils');
const {writeCSV, delimitedToList, getSort} = require('./lib/common');

if(process.argv.length !== 1) {
  console.log("Usage: %s <path-to-Loinc.csv>", process.argv[1]);
  process.exit(-1);
}
let loincTableFile = process.argv[2];

(async () => {
  let loincs = await loadLoincTable(loincTableFile);
  let rows = generateUnitUcumPropertyMapping(loincs);
  rows.forEach(row => row.DISPLAY_NAME = ''); // The original file for RI has it, the code may expect the column
  rows.sort(getSort([x=>x.LOINC_PROPERTY], [x=>x['ucum unit']]));
  writeCSV(rows, 'unit-ucum-property-from-loinc.csv');
})();

/**
 * Creating a 3-way mapping of unit-ucum-property, where:
 * unit: each unique value of SUBMITTED_UNITS or EXAMPLE_UNITS
 * ucum: each unique value of EXAMPLE_SI_UCUM_UNITS or EXAMPLE_UCUM_UNITS
 * PROPERTY: the LOINC property
 * The presense of non-empty PROPERTY and a non-empty UCUM unit is required to form a row in the result.
 * If the unit and ucum unit are the same, an empty string will be used.
 * @param loincs the LOINC table rows
 * @return a list of (unique) trios object with fields: LOINC_PROPERTY, "Raw UNITS", and "ucum unit"
 */
function generateUnitUcumPropertyMapping(loincs) {
  let uniqMapping = {}; // unit-ucum-property unique key to a row of the trio.
  loincs.forEach(loinc => {
    let units = new Set([...delimitedToList(loinc.EXAMPLE_UNITS), ...delimitedToList(loinc.SUBMITTED_UNITS)]);
    let ucums = new Set([...delimitedToList(loinc.EXAMPLE_UCUM_UNITS), ...delimitedToList(loinc.EXAMPLE_SI_UCUM_UNITS)]);
    let property = loinc.PROPERTY;
    if(property && ucums.size) {
      units.forEach(unit => {
        ucums.forEach(ucum => {
          unit = unit === ucum? '': unit;
          let key = [unit, ucum, property].join('-');
          if(!uniqMapping[key]) {
            uniqMapping[key] = {
              "LOINC_PROPERTY": property,
              "Raw UNITS": unit,
              "ucum unit": ucum
            }
          }
        });
      });
    }
  });

  return Object.values(uniqMapping);
}

