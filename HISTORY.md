
n.n.n / XXXX-XX-XX
==================

  * T100681: Remove deprecated v1/v2 HTTP APIs
  * T130638: Add data-mw as a separate JSON blob in the pagebundle
  * T135596: Return client error for missing data attributes
  * T134389: Serialize content in HTML tables using HTML tags
  * T125419: Fix selser issues serializing first table row
  * T114413: Provide HTML2HTML endpoint in Parsoid
  * T137406: Emit |- between thead/tbody/tfoot
  * T96195 : Remove node 0.8 support
  * T139388: Ensure that edits to content nested in elements
             with templated attributes is not lost by the
             selective serializer.
  * T90668 : Replace custom server.js with service-runner
  * T113322: Use the mediawiki-title library instead of
             Parsoid-homegrown title normalization code.
  * T71207 : Always make wiki and interwiki links when possible.
             Warning: this means that [https://en.wikipedia.org/wiki/Foo Foo]
             will round-trip to [[Foo]] unless selective serialization
             is enabled. See T102556 for a discussion.

0.5.1 / 2015-05-02
==================

  * Thar be dragons
