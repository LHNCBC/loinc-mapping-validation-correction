## Experimental Program for Checking and Correcting LOINC Mappings

This software was developed as part of the research on LOINC mapping at
the Lister Hill National Center for Biomedical Communications (LHNCBC), the National Library
of Medicine (NLM), NIH, led by Dr. Clement McDonald. A paper on this research is forthcoming. It was 
developed based on a subset of the PCORNET data, we hope It should be applicable to other datasets
as well, perhaps with some tweaks to make it work more effectively.

This software was written in JavaScript and requires node.js version 10.15.* or later to run.
It should be platform independent and should run on Windows, Linux, or MacOS based systems.

Please note that this is a research prototype and not a polished software product, therefore, 
the correctness and functionality of this software can not be guaranteed. You are free to use 
or change this software, but use at your own risk. Under no circumstances should the LHNCBC, 
NLM, NIH, or the US government be held liable for any loss or damage resulted from using this software.

### A General Overview
The key ideas behind the algorithms are as follows:
- A LOINC term has a class and six parts: COMPONENT, PROPERTY, SYSTEM, TIME, SCALE, and METHOD,
  among other things. See https://loinc.org for more details. 
- The raw lab name and/or raw unit of a test often suggest or have "hints" on what some of the 
  LOINC part(s) should be, e.g., a lab name "CSF WEST NILE VIRUS IGG" implies that the SYSTEM (specimen) 
  is likley "CSF", and a unit "mg/dL" implies that the PROPERTY should be mass concentration (MCnc).
- Disagreements between the hinted LOINC part(s) and that of the mapped LOINC term usually indicate
  problems in the mapping. When this is detected, the following process is used to find replacement 
  LOINC terms:
- Start from the mapped LOINC parts, replace any of the parts with that "suggested" by the test
  (name or unit) to "construct" a new LOINC term. If such a LOINC term exists it's considered a 
  better mapping.    

There are more to it and there are many subtle issues, but that's the general idea.  

### Using the Software
#### A few notes first:
- A sample input file and output file have been included to show how to prepare the data file and 
  what to expect in the results. Currently both the input and output files are Excel files so as to
  preserve any editing, formatting/styling from the researchers across experiment runs.
- The second tab, "column-description", in the sample-input-file.xlsx (and output file) has
  descriptions on the required and optional columns.
- The input file and output file look almost the same except that the "output" columns are populated
  in the output file.
- The required input columns must exist in the input file in order to use the software.
- The output columns in the input file should exist and will be populated by the software when creating the
  output file. Output columns missing from the input file will not appear in the output file.
- Columns not listed in the sample files will be passed from the input file to the output file, untouched.
- The software depends on a set of "mapping files", e.g., unit to UCUM unit mapping,
  UCUM unit to LOINC property mapping, etc. These files may be edited to achieve the desired results.
- Some of the tweaks are specific to the dataset we used and may or may not be applicable to your
  dataset. You are encouraged to make some tweaks to make it work better for your data.
  See the mapping files section below for more details.

#### Running the software with the provided sample input file
- The software requires node.js, please install first if not already installed.
- This software requires the Loinc.csv file that may be downloaded from https://loinc.org for free.
- To test run against the sample input file:   
    bin/check-sample-file.sh path-to-Loinc.csv output-directory  
  The output file will be written to the output directory provided

#### To run/test your own input file:
- Prepare your input file according to the section "input & output file format" below. The 
  sample-input-file.xlsx is a good place to start.
- Look into check-sample-file.sh to see how to use your own input file and mapping files
- Once you are confortable with the basic runs, you may start to tweak the mappings (more details in the
  sections below) or even tweak the source code to meet your need.

#### The input & output file format
Please check the "column-description" tab in the sample input or output file, they are the same.

#### The mapping files
The software uses a set of mapping entries/lists to guide the process. Some of the mappings/lists are 
in the Excel file that comes with this package:  
&nbsp;&nbsp;&nbsp;&nbsp; combined-mapping-file.xlsx (included under data/)  
Where each sheet/tab represents a mapping file. These mappings may (perhaps should) be edited to better
work with your data. Other mappings/lists are embedded inside the software/code, but it's still straightforward 
to get in there and make some tweaks.

For the mapping sheets, we can not make public the exact mappings we used because they contain unpublished, 
third-party content. The mappings included here may be considered "extended" samples that have been
generated from publicly available sources. They are not too far off, though. The software will still 
function with the included mapping file but the results may not be as good.  
Here is the list of mappings in the Excel file:
- unit-to-ucum: A straight mapping from a non-UCUM unit string to the corresponding UCUM unit string, e.g., 
  the unit string "g/24 H" is mapped to UCUM unit string "g/(24.h)".  
  You are encouraged to edit this file or to incorporate mappings from other sources.
- unit-ucum-properties: this is a 3-way mapping among "raw unit" (potentially non-UCUM), UCUM unit, and the LOINC
  property. Each row is a unique combination of the 3 elements. Again, the exact mapping file we used was based
  on 3rd party content that we couldn't make public. The mappings you are seeing here have been generated from
  the LOINC table, which should provide good coverage but is not the exact mapping we used.  
  As you may have realized, the mapping here also provides a unit string to UCUM unit string mapping, which is
  also taken into account by the software.
 
#### Mappings embedded in the software
These mappings, while embedded in the JavaScript code, are still easily "tweakable".
- Patterns (and conditions) for parsing out specimen (LOINC SYSTEM) from lab test names:
  src/lib/labNameParser.js  
  Look at the list in specimenExtractors
- LOINC COMPONENT modifiers/qualifiers:
  src/lib/labNameParser.js  
  Look at the list in componentModifiers
- Patterns for extracting LOINC TIME part from the lab names or units:
  src/lib/labNameParser.js  
  Look at the list in timeExtractors
- Rule based unit mapping: 
  src/lib/pcornetRuleBasedUnit2UcumMapper.js.  
  The mappings here are specific to the PCORNET data that we processed and may or may
  not be applicable to your datasets.

- LOINC part synonyms - barely anything there yet at this point. Potentially a comprehensive list may be
  extracted from LOINC.  
  src/lib/loincPartSynonyms.js  

#### Contact, developer information
For questions, feedback, or any technical issues, please contact:  
Xiaocheng Luan, Staff Scientist, 
Lister Hill National Center for Biomedical Communications (LHNCBC), National Library of Medicine (NLM), NIH.  
Email: xiaocheng.luan@nih.gov

