0.6.1 / 2016-11-14
==================

  * Fix broken 0.6.0 debian package

0.6.0 / 2016-11-07
==================

  wt -> html changes:
  * T147742: Trim template target after stripping comments
  * T142617: Handle invalid titles in transclusions
  * Handle caption-like text outside tables
  * migrateTrailingNLs DOM pass: Code simplifications and
    some subtle edge case bug fixes
  * Handle HTML tags in attribute text properly
  * A bunch of cleanup and fixes in the PEG tokenizer

  html -> wt changes:
  * T134389: Serialize content in HTML tables using HTML tags
  * T125419: Fix selser issues serializing first table row
  * T137406: Emit |- between thead/tbody/tfoot
  * T139388: Ensure that edits to content nested in elements
             with templated attributes is not lost by the
             selective serializer.
  * T142998: Fix crasher in DOM normalization code
  * Normalize all lists to not mix wikitext and HTML list syntax
  * Always emit canonical wikitext for url links
  * Emit url-links where appropriate no matter what rel attribute says

  Infrastructure changes:
  * T96195 : Remove node 0.8 support
  * T113322: Use the mediawiki-title library instead of
             Parsoid-homegrown title normalization code.
  * Remove html5 treebuilder in favour of domino's
  * service-runner:
    * T90668 : Replace custom server.js with service-runner
    * T141370: Use service-runner's logger as a backend to
               Parsoid's logger
    * Use service-runner's metrics reporter in the http api
  * Extensions:
    * T48580, T133320: Allow extensions to handle specific contentmodels
    * Let native extensions add stylesheets
  * Lots of wikitext linter fixes / features.

  API changes:
  * T130638: Add data-mw as a separate JSON blob in the pagebundle
  * T135596: Return client error for missing data attributes
  * T114413: Provide HTML2HTML endpoint in Parsoid
  * T100681: Remove deprecated v1/v2 HTTP APIs
  * T143356: Separate data-mw API semantics
  * Add a page/wikitext/:title route to GET wikitext for a page
  * Updates in preparation for supporting version 2.x content
    in the future -- should be no-op for version 1.x content
  * Don't expose dev routes in production
  * Cleanup http redirects
  * Send error responses in the requested format

  Performance fixes:
  * Template wrapping: Eliminate pathological tpl-range nesting scenario
  * computeDSR: Fix source of pathological O(n^2) behavior

  Other fixes:
  * Make the http connect timeout configurable
  * Prevent JSON.stringify circular refs in template wrapping
    trace/error logs
  * Fix processing listeners in node v7.x


0.5.3 / 2016-11-01
==================

  * T149504: SECURITY: Fix reflected XSS

0.5.2 / 2016-07-05
==================

  * Fix npm package

0.5.1 / 2015-05-02
==================

  * Fix debian package

0.5.0 / 2015-05-02
==================

  * Thar be dragons
