// A util script that loads CSV file into an array, for use with small csv files only.
var fs = require('fs');
var csv = require('csv');
var iconv = require('iconv-lite');


/**
 * Load CSV file into a list of records. This function decodes the Microsoft excel encoding (iso88591)
 * before piping to csv parsing
 * A record may be an array (of column values) or json, depending on the column settings parameter.
 * This is meant to use with smaller files only where you can afford to load the whole thing in memory.
 * @param csvFile
 * @param csvOptions options/hash directly passed to csv.parse(), so see csv.parse() for more details.
 * @returns {Promise} resolves to the record list loaded.
 */
function readCsvWithEncoding(csvFile, csvOptions, csvFileEncoding) {
  let recList = [];
  let parser = csv.parse(csvOptions);

  parser.on('readable', function() {
    let record;
    while (record = parser.read()) {
      recList.push(record);
    }
  });

  return new Promise(function(resolve, reject) {
    parser.on('finish', () => {
      resolve(recList);
    });
    parser.on('error', (err) => {
      if(reject) {
        console.error('ERROR happened in readCSV: ', err);
        reject(err);
      }
      else {
        throw err;
      }
    });
    if(csvFileEncoding) {
      fs.createReadStream(csvFile).pipe(iconv.decodeStream(csvFileEncoding)).pipe(parser);
    }
    else {
      fs.createReadStream(csvFile).pipe(parser);
    }
  });
}

/**
 * Load CSV file into a list of records. A record may be an array (of column values) or json, depending
 * on the column settings parameter.
 * This function assumes UTF-8 encoding
 * This is meant to use with smaller files only where you can afford to load the whole thing in memory.
 * @param csvFile
 * @param csvOptions options/hash directly passed to csv.parse(), so see csv.parse() for more details.
 * @returns {Promise} resolves to the record list loaded.
 */
function readCSV(csvFile, csvOptions) {
  return readCsvWithEncoding(csvFile, csvOptions);
}


function readExcelCSV(csvFile, csvOptions) {
  return readCsvWithEncoding(csvFile, csvOptions, 'iso88591');
}


module.exports = {
  read: readCSV,
  readExcelCSV
};

if(require.main === module) {
  readExcelCSV(process.argv[2], {columns: true}).then((rows) => {
    console.log(JSON.stringify(rows, null, 3));
  });
}