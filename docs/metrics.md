# Documentation of Metrics

## Timing metrics

### wt2html direction

These metrics cover all wikitext to $FORMAT endpoints (/wikitext/to/lint/, /wikitext/to/html/, /wikitext/to/pagebundle) and don't distinguish between them.

* `wt2html.$TYPE.init`: Tracked in Rest/Handler/ParsoidHandler.php and covers initialization (construction various objects before kicking off transformation). $TYPE can be 'wt' or 'pageWithOldId'. If 'wt', the wikitext is posted along with the request. If `pageWithOldId', the wikitext is fetched.
* `wt2html.$TYPE.parse`: Tracked in Rest/Handler/ParsoidHandler.php and covers transformation time . $TYPE can be 'wt' or 'pageWithOldId'. If 'wt', the wikitext is posted along with the request.
* `wt2html.total`: Tracked in Rest/Handler/ParsoidHandler.php and covers total time to convert wikitext to HTML (pagebundle or otherwise).

### HTML downgrade
* `downgrade.time`: Tracked in Rest/Handler/ParsoidHandler.php and covers time to downgrade HTML from a higher major version to a lower major version. This is usually only triggered after major HTML version bumps and where clients haven't yet adapted to the newer version and are still requesting the older version.

### html2wt direction

* `html2wt.init`: Tracked in Rest/Handler/ParsoidHandler.php and covers time to parse edited HTML and original HTML including handling pagebundles
* `html2wt.setup`: Tracked in Wikitext/ContentHandler.php and covers time to set up selser
* `html2wt.preprocess`: Tracked in Wikitext/ContentHandler.php and covers time to run any extension preprocessors. As of March 2022, there are no such handlers to run
* `html2wt.selser.domDiff`: Tracked in Html2Wt/SelectiveSerializer.php and covers time to compute dom diff between original and edited DOMs
* `html2wt.selser.serialize`: Tracked in Html2Wt/SelectiveSerializer.php and covers total time to convert HTML to wt after selser has been set up. This includes html2wt.selser.domDiff time.
* `html2wt.total`: Tracked in Rest/Handler/ParsoidHandler.php and covers the total request time (within Parsoid) and includes all the above components.

### Linting

* `linting`: Tracked in Wt2Html/PP/Processors/Linter.php and covers total time spent running the linting DOM pass (note that there might linting code outside the linting pass).
* `lint.offsetconversion`: Tracked in Logger/LintLogger.php and covers time spent converting lint offsets from ucs2 to a non-ucs2 format if there is a query parameter requetsing byte or non-ucs2 offsets in the wikitext string. (Not sure why we are tracking this).

### Language converter

* `langconv.init`: Tracked in LanguageConverter.php and covers initialization time
* `langconv.$HTMLVARIANT.init`: Tracked in LanguageConverter.php and covers initialization time (metrics split between variants)
* `langconv.total`: Tracked in LanguageConverter.php and covers time to requested html variant
* `langconv.$HTMLVARIANT.total`: Tracked in LanguageConverter.php and covers time to convert to requested html variant (metrics split between variants)
* `langconv.totalWithInit`: Tracked in LanguageConverter.php and includes both `langconv.init` and `langconv.total`.

## Size metrics

To be done.
