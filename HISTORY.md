0.8.0 / 2017-10-24
==================
  Notable wt -> html changes:
  * T43716: Parse and serialize language converter markup
  * T64270: Support video and audio content
  * T39902, T149794: Markup red links, disambiguation links in Parsoid HTML
  * T122965: Support HTML5 elements in older browsers
  * T173384: Improve handling of tokens in parser function targets
  * T153885: Handle templated template names
  * T151277: Handle [[Media:Foo.jpg]] syntax correctly
  * Generalize removal of useless p-wrappers
  * More permissive attribute name parsing
    + match PHP parser's attribute sanitizer
  * Remove dependence on native parser functions
  * Stop using usePHPPreProcessor as a proxy for an existing mw api to parse extensions
  * Several bug fixes

  Notable html -> wt changes:
  * T135667, T138492: Use improved format specifier for TemplateData enabling templates
    to control formatting of transclusions after VE edits
  * T153107: Fix unhandled detection of modified link content
  * T136653: Handle interwiki shortcuts
  * T177784: Update reverse interwiki map to prefer language prefixes over others
  * Cleanup in separator handling in the wikitext serializer
  * Several bug fixes

  API:
  * Remove support for pb2html in the http api

  Extensions:
  * Cite:
    - T159894: Add support for Cite's `responsive` parameter
  * Gallery:
    - Remove inline styling for vertical alignment in traditional galleries
    - All media should scale in gallery

  Dependencies:
  * Upgrade service-runner, mediawiki-title
  * Use uuid instead of node-uuid
  * Upgrade several dependencies to deal with security advisories
  * Limit core-js shimming to what we need

  Infrastructure:
  * Migrate from jshint to eslint

  Notable wikitext linting changes:
  * Move linter config properties to the linter config object
  * Only lint pages that have wikitext contentmodel
  * Lint multiple colon escaped links (incorrect usage)
  * Add an API endpoint to get lint errors for wikitext
  * Turn off ignored-table-attr output
  * Add detection for several wikitext patterns that render differently
    in Tidy compared to a HTML5 based parser (Parsoid, RemexHTML).
    This is only relevant if you want to fix pages before replacing
    Tidy or if you want to use Parsoid HTML for non-edit purposes.

  Other:
  * Add code of conduct file to the repo

0.7.1 / 2017-04-05
==================
  No changes.  New release to update nodejs dependency in the deb package.

0.7.0 / 2017-04-04
==================

  wt -> html changes:
  * T102209: Assign ids to H[1-6] tags that match PHP parser's assignment
  * T150112: Munge link fragments and element ids as in the php parser
  * T59603: T133267: Escape extlink content when containing ] anywhere
  * T156296: Update cached wiki configs for several wikimedia wikis
  * T50900: Improved error output for extensions, missing images
  * T109897: Remove implicit_table_data_tag rule
  * T98960: Accept entities in extlink href and url links
  * T113044: Complete templatearg representation in spec
  * T104523: Prevent infinite recursion in template expansion
  * T104662: Allow nested ref tags only in templates
  * Support extension tags which shadows "block level" HTML elements
  * A bunch of cleanup and edge case fixes in the PEG tokenizer
  * Don't accept pipe unconditionally in extlink
  * Percent-encode modules link in the HEAD section
  * Update CSS modules in HEAD section
  * Remove special-case non-void semantics for SOURCE
  * Fixup redirect-detecting regular expressions in multiple places
  * Edge case bug fixes to title handling code
  * Edge case bug fixes in aynsc token transformation pipeline
  * Several fixes to the linting code to support the PHP Linter extension

  html -> wt changes:
  * T149209: Handle newlines in TD and TH cells
  * T160207: Fix serializing multi-line indent-pre w/ sol wt syntax
  * T133267: Escape extlink content when containing ] anywhere
  * T152633: Fix crasher from ConstrainedText
  * T112043: Handle anchors without hrefs
  * Fix and cleanup domdiff annotations which fixes some edge case bugs

  Extensions:
  * T110910: Implement gallery extension natively inside Parsoid
  * T58381, T108216: Treat NOWIKI and html PRE as extension tags
  * Cite: T102134: Fix hrefs to render properly
  * Cite: Escape cite ids with Sanitizer.escapeId
  * Move section handling to the LST extension
  * Extension API improvements for the ProofreadPage extension
  * Normalize all extension options

  Infrastructure changes:
  * Update parser tests syncing scripts to let us sync PHP extension tests
    from to/from Parsoid.
  * Several fixes to parserTests scripts to improve output and processing of
    test options, among other things.
  * Bump domino, service-runner, minor versions of some deps,
    and some dev deps.
  * Switch to npm@3

  API changes:
  * In dev-api mode, add ?follow_redirects=true support to wt2html
    API end points to get Parsoid to return a HTTP 302 response for
    redirect pages. This lets 302-following clients to render the
    target page.

  Other fixes:
  * T153797: ApiRequest: Clone the request options before modifying them
  * T150213: Suppress logs for known unknown contentmodels
  * Code cleanup and refactoring for upcoming audio/video support.
  * Code cleanup and refactoring in template handling for upcoming support
    for templated template names. This also fixes some edge case bugs.

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
