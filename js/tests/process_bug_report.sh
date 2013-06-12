#!/bin/bash

# ASSUMES that bug reports are in tests/bugs/<expanded-bug-report-dir>
# and that the script will be run from that dir

../../fetch-wt.js `cat oldid` `cat wiki | sed 's/mediawiki/mw/g;s/wiki$//g;'` > wt
../../parse.js --selser --html2wt --oldtextfile wt --oldhtmlfile originalHtml < editedHtml > new.wt
diff wt new.wt > latest.diff
