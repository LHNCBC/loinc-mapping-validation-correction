#!/bin/bash

# This is an example script on how to use the program, by validating/correcting the
# sample file that comes with this software.
# **** In order to use this program, you must download the Loinc.csv file (free) from https://loinc.org ****
# and use the file path as the first argument to this script. See usage() for more details.

function usage() {
  cat << EOF

  Usage: $0 <Loinc.csv-file> <output-dir>"
  Where:
      <Loinc.csv-file>: path to the Loinc.csv file downloaded from https://loinc.org
      <output-dir>: a directory (preferably new/non-exist) to write output files.
  Note that the stdout and stderr are redirected to stdout.txt in the given output directory.

EOF
  exit 1;
}

set -e
[[ $# -eq 2 ]] || usage;

loincCSV="$1"
outDir="$2";
[[ -d $outDir ]] || mkdir -p $outDir

mainDir=$(cd $(dirname $0)/..; pwd)
combinedMappingFile="$mainDir/data/combined-mapping-files.xlsx"
inputDataFile="$mainDir/data/sample-input-file.xlsx"

echo "Sending stdout/err to $outDir/stdout.txt ..."
node --max-old-space-size=4000 $mainDir/src/pcornetAltLoincSuggesterMain.js \
  $outDir $combinedMappingFile $loincCSV $inputDataFile > $outDir/stdout.txt 2>&1

echo Done
