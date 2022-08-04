const fs = require('fs');
const path = require('path');
const util = require('util');
const csv = require('csv');
const xlsx = require('xlsx');

/**
 * Write the given rows into the given csv file (or standard output if filename is not provided.
 * @param fileName
 * @param rows
 */
function writeCSV(rows, fileName, delimiter) {
  let options = {header: true};
  if(delimiter) {
    options.delimiter = delimiter;
  }
  let output = fileName? fs.createWriteStream(fileName): process.stdout;
  let csvWriter = csv.stringify(options);
  csvWriter.pipe(output);

  for (let rec of rows) {
    csvWriter.write(rec);
  }
  csvWriter.end();
}


/**
 * Fixed the unit to make it a ucum based on some simple rules.
 * @param unit
 * @return {*}
 */
function fixUnit(unit) {
  unit = unit.replace(/[\s]+(H2O|water|creatinine)$/, '{$1}');
  unit = fixHoursInInut(unit) || unit;

  return unit;
}

// fix hour related unit problems.
function fixHoursInInut(fromUnit) {
  let dotHourRegex = RegExp(/^([^\d]*)(\d+)([ ]*(HR|Hr|hr|HOUR|Hour|hour)[sS]?)(.*)$/);
  let hourRegex = RegExp(/^(.*)((HR|Hr|hr|HOUR|Hour|hour)[sS]?)(.*)$/);
  let spaceHRegex = RegExp(/^([^\d]*)(\d+)[ ]+(h|H)$/);

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
    else {
      let spaceHMatch = fromUnit.match(spaceHRegex);
      if(spaceHMatch) {
        result = fromUnit.replace(spaceHRegex, '$1($2.h)');
      }
    }
  }

  return result;
}

// Get the list of column headers (row-1 value, must NOT empty)
function xlsxColNamesForSheet(sheet) {
  let names = [];
  for(let cellKey of Object.keys(sheet)) {
    if(!cellKey.startsWith('!')) {
      if(cellKey.replace(/[^0-9]/g, '') === '1') {
        names.push(sheet[cellKey].v);
      }
      else {
        break; // really javascript and xlsx package is consistent in the cell ordering
      }
    }
  }
  return names;
}

/**
 * Get the json for the given sheet in the given xslx file.
 * @param xlsFileName
 * @param sheetName optional, default to the first sheet in the file.
 */
function getXlsxSheetJson(xlsFileName, sheetName) {
  return getXlsxWorksheetAndJson(xlsFileName, sheetName)[2];
}

function getXlsxWorksheetAndJson(xlsFileName, sheetName) {
  let workbook = xlsx.readFile(xlsFileName);
  let worksheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
  return [ workbook, worksheet, xlsx.utils.sheet_to_json(worksheet, {raw: true, defval:'', blankrows: true}) ];
}


// Add the given value to the list obj[key]. If obj[key] does not exist, a new list
// will be created and assigned to obj[key]. For unique and first operation (see opts), it
// works only if the value is a string or number; when opts.first is specified, the order
// of elements in the final results is undefined except that the last such call is guarantee to
// place the value as the first element.
// opts: optional options:
// - opts.unique if true, add value only if it's not already in the list.
// - opts.first if true, will insert the value as the first element, otherwise append to the end
function addToValueList(obj, key, value, opts) {
  opts = opts || {};
  let values = obj[key] = obj[key] || [];
  let index = values.indexOf(value);

  if(opts.first && index > 0) {
    values[index] = values[0];
    values[0] = value;
  }
  if(! opts.unique || index < 0) {
    if(opts.first) {
      values.unshift(value);
    }
    else {
      values.push(value);
    }
  }
}

// check if the given value is one of null, empty string, or undefined value. if parameter blank is provided
// and is true, it will also check if the given value has just blank spaces (trim to empty).
// blank: optional.
function isNEU(value, blank) {
  return !! (value === null || value === '' || value === undefined || (blank && !(value + '').trim()));
}

// will trim value and remove empty elements
// default delimiter is semi-colon if not specified.
function delimitedToList(value, delimiter) {
  return (value || '').split(delimiter || ';').map(e => e.trim()).filter(e => e);
}

// true IFF both lists are non-empty and has common elements, except when emptyEmptyOk is
// true in which case two lists are considered overlap if both are empty (or null/undefined)
function listsOverlap(list1, list2, emptyEmptyOk=false) {
  if(! (list1 && list1.length) && ! (list2 && list2.length) && emptyEmptyOk) {
    return true;
  }
  if(! (list1 && list1.length) || ! (list2 && list2.length)) {
    return false;
  }
  return list1.some(e => list2.includes(e));
}

// The first list has zero length or it overlaps with the second list (have common elements)
function zeroLenOrOverlapWith(list1, list2) {
  return list1.length === 0 || listsOverlap(list1, list2);
}


// emptyEqNull: boolean, optional default true
function arrNoOrdShallowEq(a1, a2, emptyEqNull) {
  emptyEqNull = emptyEqNull === undefined? true: !!emptyEqNull;

  let isArray = (a) => a === null || a === undefined || Array.isArray(a); // allow null/undefined

  if(!isArray(a1) || !isArray(a2)) {
    throw new Error("arrNoOrdShallowEq: one or both operand isn't an array");
  }
  if(a1 === a2) {
    return true;
  }
  if(emptyEqNull && (!a1 || a1.length === 0) && (!a2 || a2.length === 0)) {
    return true;
  }
  if(!a1 || !a2) {
    return false;
  }
  return a1.length === a2.length && a1.every((e) => a2.includes(e));
}

// TODO: NON_QN (manual judgmemt), WACKO_*
function isExcludedStatus(status) {
  return status === 'NON_QN' || status.startsWith('WACKO');
}


// Create a field name mapping for the given list of field names, where a name could
// optionally have a mapped-to part, e.g., nameA:nameB will map nameA to nameB, otherwise
// a field is mapped to itself.
function fieldListMapping(fieldList, mappingDelim) {
  mappingDelim = mappingDelim || ':';
  return fieldList.reduce((acc, field) => {
    let mapping = field.split(mappingDelim);
    acc[mapping[0]] = mapping[1] || mapping[0];
    return acc;
  }, {});
}

// when no value function is not specified will use identify function.
// value functions is recommended for edge cases, e.g., when comparing numbers where one or both could be undefined or null
// usage: spec*, that is, 0 or more sort specs, where each sort spec is an array of 1 or 2 elements:
//     - an optional function that is used to get the value from an element (in the array to be sorted)
//     - an optional boolean that specifies whether to reverse the natural order.
//     # IF both of the function and reverse flag are specified, the function MUST COME FIRST
//     # IF more than one spec are specified, all specs MUST HAVE THE VALUE FUNCTION
function getSort(...specs) {
  specs = specs.length? specs: [[]];
  if(specs.length > 1 && specs.some(spec => typeof spec[0] !== 'function')) {
    throw new Error('Getting multi-level-sort function without value function');
  }
  return function(x, y) {
    let result = 0;
    for(let i = 0; i < specs.length && result === 0; ++i) {
      let valueFunc = (typeof specs[i][0] === 'function')? specs[i][0]: null;
      let reverse = valueFunc? specs[i][1]: specs[i][0];
      let vx = valueFunc? valueFunc(x): x;
      let vy = valueFunc? valueFunc(y): y;

      result = vx < vy? -1: vx > vy? 1: 0;
      result = reverse? -result: result;
    }
    return result;
  }
}

function getDateString() {
  let d = new Date();
  return util.format('%s-%s-%s', d.getFullYear(), (d.getMonth()+101+'').substr(1), (d.getDate()+100+'').substr(1));
}


/**
 * Create a new file name (could be full path depends on the parameters) from the
 * given file path and the options.
 * The new file name (without directory) will be constructed from the given file name (based on options) as:
 *    name[-<suffix>]-yyyy-mm-dd<ext>
 * Supported options:
 * - suffix, optional, if provided, will be added to the file name as shown above
 * - ext, optional, if provided (should include the dot), suffix will be added before the extension
 * - dirname: optional, if provided, will use this directory name otherwise use the same directory as the input file.
 * @param filePath
 * @param opts options, see above.
 */
function newFileNameFrom(filePath, opts) {
  opts = opts || {};
  let suffix = opts.suffix? '-' + opts.suffix: '';
  let fileName = path.basename(filePath, opts.ext||undefined) + suffix + '-' + getDateString() + (opts.ext||'');
  return path.join(opts.dirname || path.dirname(filePath), fileName);
}


/**
 * Copying the given fields from source object to destination object, allowing field name transformation.
 * @param src the source object. If a field does not exist, empty string will be used in the target.
 * @param dst the destination/target object. if null, a new object will be created, copied, and returned.
 * @param fields a list of fields to copy. Allow field name transformation - see opts for more details.
 * @opts optional instructions on field name transformation, which may have these optional fields:
 *       - delim: regex or a character used to separate "from" and "to" field names, e.g., "name:names"
 *       - prefix: prefix to be added to the target field name
 *       - suffix: suffix to be added to the target field name
 */
function copyFields(src, dst, fields, opts) {
  let {delim, prefix='', suffix=''} = opts || {};
  dst = dst || {};

  fields.forEach(f => {
    let [from, to] = delim? f.split(delim): [f];
    to = prefix + (to || from) + suffix;
    dst[to] = isNEU(src[from])? '': src[from];
  });

  return dst;
}

/**
 * Compute the intersection of the given sets - they must be of type Set
 * @param sets
 * @return {Set<any>}
 */
function setAND(...sets) {
  if(sets.length === 0) return new Set();
  if(sets.length === 1) return sets[0];

  sets.sort((s1, s2) => s1.size - s2.size); // ensure shorter ones come first for efficiency, sort is ok for small list
  let intersection = new Set();

  for(let elem of sets[0]) {
    if(sets.slice(1).every(s => s.has(elem))) {
      intersection.add(elem);
    }
  }
  return intersection
}

/**
 * Compute the union of the given sets - they must be of type Set
 * @param sets
 * @return {Set<any>}
 */
function setOR(...sets) {
  if(sets.length === 0) return new Set();
  if(sets.length === 1) return sets[0];

  sets.sort((s1, s2) => s2.size - s1.size); // ensure larger ones come first for efficiency, sort is ok for small list
  let union = new Set(sets[0]);

  for(let ss of sets.slice(1)) {
    for(let elem of ss) {
      union.add(elem);
    }
  }

  return union;
}

/**
 * Show the distribution of values for the given fields. Absent fields will assume empty string value.
 * @param rows
 * @return a map that has an entry for each given field, where each entry is a map from a field value to the count.
 */
function getFieldValueDistribution(rows, ...fields) {
  let stats = fields.reduce((acc, f) => {acc[f] = {}; return acc;}, {});
  for(let f of fields) {
    rows.forEach(row => {
      let v = isNEU(row[f])? '': '' + row[f];
      stats[f][v] = (stats[f][v] || 0) + 1;
    });
  }
  return stats;
}

/**
 * Use getFieldValueDistribution to compute the distribution then log to stdout or a file.
 * Field values will be sorted
 * @param fileName use null/empty for stdout.
 * @param labelLine
 * @param rows
 * @param fields
 */
function logFieldValueDistribution(fileName, labelLine, rows, ...fields) {
  let stats = getFieldValueDistribution(rows, ...fields);
  Object.keys(stats).forEach(f => {
    let vstats = {};
    Object.keys(stats[f]).sort().forEach(v => vstats[v] = stats[f][v]);
    stats[f] = vstats;
  });
  if(fileName) {
    fs.writeFileSync(fileName, labelLine + '\n' + JSON.stringify(stats, null, 4));
  }
  else {
    console.log('%s\n%s', labelLine, JSON.stringify(stats, null, 4));
  }
}

module.exports = {
  isExcludedStatus,
  arrNoOrdShallowEq,
  writeCSV,
  fixUnit,
  isNEU,
  fixHoursInInut,
  xlsxColNamesForSheet,
  listsOverlap,
  zeroLenOrOverlapWith,
  getXlsxSheetJson,
  getXlsxWorksheetAndJson,
  addToValueList,
  delimitedToList,
  arrayToMap: (array) => array.reduce((acc, value) => {acc[value] = value; return acc}, {}),
  fieldListMapping,
  getSort,
  getDateString,
  newFileNameFrom,
  copyFields,
  setAND,
  setOR,
  getFieldValueDistribution,
  logFieldValueDistribution
}

