
const Excel = require('exceljs');

if (require.main === module) {
  getWorksheet(...process.argv.slice(2)).then(([workbook, worksheet]) => {
    testWorkSheet(workbook, worksheet);
  });
}

function testWorkSheet(workbook, sheet) {
  console.log('==== row-count=%d, actual-row-count=%d, column-count=%d, actual-column-count=%d',
    sheet.rowCount, sheet.actualRowCount, sheet.columnCount, sheet.actualColumnCount);
  let headerTOLetter = getColName2HeaderMap(sheet);
  console.log(JSON.stringify(headerTOLetter, null, 4));
}


/**
 * Get the workbook and worksheet for the given excel file and worksheet name.
 * @param xlsFileName the excel file name
 * @param worksheetName the worksheet name. Optional, defaults to the first worksheet
 * @return a promise that resolves to an array [workbook, worksheet]
 */
function getWorksheet(xlsFileName, worksheetName) {
  let workbook = new Excel.Workbook();
  return new Promise((resolve, reject) => {
    workbook.xlsx.readFile(xlsFileName).then(() => {
      let sheet = worksheetName? workbook.getWorksheet(worksheetName): workbook.worksheets[0];
      resolve([workbook, sheet]);
    }).catch(() => {
      reject('Error loading ' + xlsFileName);
    })
  });
}


/**
 * Get the excel native column header, e.g., A, B, AA, AB, etc., for the given 0-based column number.
 * This only works for single or double letter columns, i.e., from column A to ZZ.
 * @param the 0-based column number.
 * @return the excel native column header
 */
function indexToColLetter(index) {
  let letter1 = ''; // The first letter, e.g., 'A' in 'AB', only if it's a two-letter column
  if(index > 25) {
    letter1 = String.fromCharCode(65 + Math.floor(index / 26 - 1));
    index = index % 26;
  }
  return letter1 + String.fromCharCode(65 + index);
}


/**
 * Get the header name (first row value) to xlsx column letter header (A, AC, etc.) mapping.
 * @param worksheet the worksheet
 * @return a mapping from the user defined column header name to the excel column letter.
 */
function getColName2HeaderMap(worksheet, strictHeader = true) {
  let dupHeaders = {};
  let emptyHeaders = []; // native letter header for columns with empty or blank header name
  let col2Letter = {};
  for(let c = 0; c < worksheet.columnCount; ++c) {
    let letter = indexToColLetter(c);
    let header = worksheet.getCell(letter  + '1').value;
    if(header && typeof header !== 'string') {
      console.error('ERROR: non string header, converting to string:', header);
      header = header + '';
    }
    if(!header || !header.trim()) {
      emptyHeaders.push(letter);
    }
    else {
      if(col2Letter[header]) {
        dupHeaders[header] = true;
      }
      col2Letter[header] = letter;
    }
  }
  dupHeaders = Object.keys(dupHeaders);
  let msg = dupHeaders.length? 'Duplicate headers: ' + dupHeaders.join(', '): null;
  if(emptyHeaders.length) {
    msg = msg? msg + '; ': '';
    msg += 'Empty header columns: ' + emptyHeaders.join(', ');
  }
  if(msg) {
    console.error('WARN: worksheet %s has duplicate or empty header names: %s', worksheet.name, msg);
    if(strictHeader) {
      throw new Error(msg);
    }
  }

  return col2Letter;
}


/**
 * Get the worksheet cell manager object that has the following two functions:
 * - getValue(colName, rowNum): get the cell value for the given column name and 1-based row number
 * - setValue(colName, rowNum, value): set the given cell value
 * Where the colName is the header row (row#1) value, that is, the user defined header
 * @strictHeader when true, will throw error if any of columns have duplicate or empty header names.
 */
function getCellMgr(worksheet, strictHeader = true) {
  let colName2Letter = getColName2HeaderMap(worksheet, strictHeader);
  let getCell = (colName, rowNum) => worksheet.getCell(colName2Letter[colName] + rowNum);
  function getValue (colName, rowNum) {
    let value = getCell(colName, rowNum).value;
    value = (value === null || value === undefined)? '': value;
    if(Array.isArray(value.richText)) {
      value = value.richText.map(t => t.text).filter(t=>t).join('');
    }
    return value;
  }
  let cellMgr = {
    getCell,
    getColNames: () => Object.keys(colName2Letter),
    getColMapping: () => Object.assign({}, colName2Letter),
    getValue: getValue,
    strValue: (colName, rowNum) => {
      let value = getValue(colName, rowNum);
      return (value===null || value==='' || value===undefined)?'': value + '';
    },
    setValue: (colName, rowNum, value) => {
      getCell(colName, rowNum).value = (value === null || value === undefined)? '': value;
    }
  }
  return cellMgr;
}


/**
 * Get the column values for the given row as a hash.
 * @param cellMgr the cell manager for the sheet
 * @param rowNum the row# in excel terms, that is, first row is row #1
 * @param columns the columns for which to get values, if empty or not specified, return all columns
 * @return {{}} the result hash
 */
function getColValues(cellMgr, rowNum, ...columns) {
  columns = columns.length? columns: cellMgr.getColNames();
  return columns.reduce((acc, f) => {
    let v = cellMgr.getValue(f, rowNum);
    acc[f] = (v === null || v === '' || v === undefined)? '': v + '';
    return acc;
  }, {});
}


module.exports = {
  getWorksheet,
  getCellMgr,
  getColValues
}
