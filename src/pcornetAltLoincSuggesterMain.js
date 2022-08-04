
// This is the "main" that was refactored out of altLoincSuggesterGen6.js and is used to
// test treating altLoincSuggesterGen6 as a library (to be used for ARUP or other dataset, for example.)

/*
TODO:
- 0. A full list of external files needed, where they should go.
     -- combined-mapping-files.xlsx (included) - #### rule-based unit mapping/correction is still in code ####.
     -- input-file.xlsx (sample included)
     -- output-dir (not really input file)
     -- Loinc.csv: required to download, put in the data/ directory or provide at commandline???? TODO
- 1. so that one can specify LOINC directory/file and input data file/combined-mapping file to run their file
- 2. clean out any PCORNET(?) LHC specific stuff
- 3. possibly makes more tables but leaving in code probably better in supporting regex
- 4. more documentation, of course, specify the dependency (LOINC, LOINC license/account/acknonwledgement)
- 5. what about the LOINC parts, should this be computed dynamically as opposed to using existing fields?
 */
// notes on the need to download LOINC, or even using this software require acknowledge of LOINC license
// future version may work on input/output CSV. performance limits with xlsx
// notes on mamual_judgement, ROW_NUM, RAW_* does not necessarily need to be raw
// specimen_source
// manual_judgement, cm_judgement, inc)category ok if not exists in input file
// audo include LOINC parts is necessary
// non qn exclusion: we mainly deal with Qn, you could manually exclude by setting "non qn"
const util = require('util');
const { getXlsxSheetJson, delimitedToList, newFileNameFrom } = require('./lib/common');
const { initAsyncGlobals, validateAndSuggest, updateResultsFile } = require('./altLoincSuggesterGen6');

function err_exit(...args) {
  console.error('\n%s', util.format(...args));
  process.exit(1);
}

let argv = process.argv.slice(2);
if(argv.length < 3) {
  err_exit('Usage: <output-dir> <combined-mapping-files-xlsx> <loinc-csv-file> <input-data-file-xlsx>');
}

let [outputDir, combinedMappingRuleXlsx, loincFileCSV, pcornetFileName] = argv;

(async () => {
  let pcnRows = getXlsxSheetJson(pcornetFileName);
  sanityCheck(pcnRows);

  await initAsyncGlobals(outputDir, combinedMappingRuleXlsx, loincFileCSV);
  pcnRows = validateAndSuggest(pcnRows);

  let outFile = newFileNameFrom(pcornetFileName, {dirname: outputDir, suffix: "results", ext: '.xlsx'});
  await updateResultsFile(pcnRows, pcornetFileName, outFile);
})();

function sanityCheck(pcnRows) {
  let requiredInFields = ['LAB_LOINC', 'RAW_LAB_NAME', 'RAW_UNIT'];
  let optionalInFields = ['SPECIMEN_SOURCE', 'ROW_NUM', 'NUM_RECORDS', 'Inclusion category'];
  let outFields = ['ALGO_JUDGEMENT', 'SGG_LOINC', 'SGG_LONG_COMMON_NAME', 'SGG_OTHER', 'TARGET_TERM',
    'RULE_RELAXED_BY', 'parsed_parts', 'inferred_parts', 'ALGO_MAPPING_ISSUES'];

  if(!pcnRows.length) {
    err_exit('NO data rows in the given input file.');
  }
  if(! requiredInFields.every(f => pcnRows[0].hasOwnProperty(f))) {
    err_exit('#### ERROR: some of the fields %s are missing, they are all required.', requiredInFields);
  }

  let missingOptInFields = optionalInFields.filter(f => !pcnRows[0].hasOwnProperty(f));
  if(missingOptInFields.length) {
    console.log('FYI: The following optional input columns are missing from input file (ok):\n', missingOptInFields);
  }
  let missingOutFields = outFields.filter(f => !pcnRows[0].hasOwnProperty(f));
  if(missingOutFields.length) {
    console.warn('WARN: Missing output columns from input file, so you will not see them in the result file:\n', missingOutFields);
  }
}