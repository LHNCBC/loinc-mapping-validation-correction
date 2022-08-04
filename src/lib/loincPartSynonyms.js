
// Each part type may have a list of synonym groups where each group is a list of terms that are synonyms
// The term "synonym" is used loosely here, referring to interchangable part names in the context of
// LOINC mapping correct.
let partSynonyms = {
  SYSTEM: [
    ['Ser', 'Plas', 'Ser/Plas'],
    ['Bld', 'Ser/Plas/Bld'],
    ['xxxx-1', 'xxxxx-2'] // just to illustrate the syntax
  ]
}

// part-type to a map where the keys are part names and values are synonyms for that part name, e.g.,:
// { SYSTEM: { // the synonyms point to the same synonym group list, not duplicates
//     'Ser': ['Ser', 'Plas', 'Ser/Plas'],
//     'Plas': ['Ser', 'Plas', 'Ser/Plas'],
//     'Ser/Plas': ['Ser', 'Plas', 'Ser/Plas'],
//      'xxxx-1': ['xxxx-1', 'xxxxx-2'],
//      'xxxxx-2': ['xxxx-1', 'xxxxx-2']
//   }
// }
let partSynonymsMap = {};
Object.entries(partSynonyms).forEach(([partType, groups]) => {
  partSynonymsMap[partType] = partSynonymsMap[partType] || {};
  groups.forEach(group => {
    group.forEach(partName => {
      partSynonymsMap[partType][partName] = group;
    });
  });
});


/**
 * If any of the given part names have synonyms, their synonyms will be "added" to the list
 * @param partType
 * @param partNames
 */
function addPartSynonyms(partType, partNames) {
  if(!partNames || ! partSynonymsMap[partType]) {
    return partNames;
  }
  for(let i=0, len=partNames.length; i < len; ++i) {
    let synonyms = partSynonymsMap[partType][partNames[i]] || [];
    for(let syno of synonyms) {
      if(!partNames.includes(syno)) {
        partNames.push(syno);
      }
    }
  }
  return partNames;
}

/**
 * Get the synonyms for the give part type and part name.
 * @param partType
 * @param partName
 * @return a list of synonyms or empty list or null
 */
function getPartSynonyms(partType, partName) {
  return partSynonymsMap[partType] && partSynonymsMap[partType][partName] || null;
}

module.exports = {
  addPartSynonyms,
  getPartSynonyms
}

if(require.main === module) {
  let testData = {
    SYSTEM: ['Ser', 'whatever', 'Ser/Plas'],
    PROPERTY: ['ACnc', 'Ser', 'Ser/Plas']
  }
  Object.entries(testData).forEach(([partType, partNames]) => {
    let newPartNames = addPartSynonyms(partType, partNames.slice());
    console.log('%s: %s ==> %s', partType, partNames, newPartNames);
  });
}
