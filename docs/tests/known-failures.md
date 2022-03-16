# Known failures

Known failures are originating from core parser tests that eventually parsoid will be able to pass.
It serves as a place to keep track of regressions even though we couldn't have 100% acceptance.

The known failures list has a few uses.

- By capturing the current output of the failing tests, we can see how changes improve or regress the output,
  even if it doesn't make the tests pass.
- A lot of our selser tests are automatically generated and we don't have an oracle to know the expected
  serialization should be so it lets us reduce noise from false positives.

Some notes about known failures:

- If it's a known failure in a `wt2html` test, then most likely this is a test that was never updated for parsoid.
  Sometime these can be fixed by just adding an `!! html/parsoid` but there are lots of them, and for each one you
  should look at the HTML carefully to ensure that the parsoid output really does match the old PHP output, modulo
  "known differences" (extra span tags, etc). Known failures in `wt2html` tests will usually cascade and cause
  failures in all other modes for this test as well.
- A known failure in `html2wt` or `wt2wt` is usually some construct which does not round-trip cleanly.
  We used to consider this a bug in all cases. We thought that data-parsoid should always record sufficient information
  to exactly reconstitute the original wikitext, nonsemantic whitespace and all, but eventually it became clear
  that was a design mistake. Parsoid in selective serialization mode must always round-trip cleanly, but what
  editors actually want out of `html2wt` on new/edited wikitext is "pretty" wikitext. So if the test input is pretty
  then `wt2wt` and `html2wt` should always pass. But there are lots of cases where the input isn't as "pretty" as
  our output. The correct fix for this is to split the test in two: write a `wt2html-only` test which ensures that
  the "ugly" wikitext generates the correct html, and then write a "all modes" test which has the equivalent "pretty"
  wikitext and the exact same HTML as the ugly test. But again, there are lots of these tests to update. We may
  eventually want to make it easier to split these tests by adding a `!! wikitext-pretty` or `!! wikitext-out` section.
- Some of the parser tests are actually tests of other features, some of which we don't support yet.
  The `cat`, `ill` , `showtitle`, `property`, `extension` and `showindicators` options to parser tests are examples here.
  We'll probably support more of these eventually, the others will probably have to be rewritten as some other type of
  test once the legacy parser goes away.
- The selser tests are limited by not having a perfect oracle for how they "should" behave. So some of the generated
  selser tests are bogus. This is handled via the known failures mechanism, and (unlike the other cases) updating
  the test itself is unlikely to help. We do have a "manual selser" mode; it's conceivable you could replace a
  test-with-some-bogus-selser by manually adding enumerating only the "good" selser tests in the options section for
  the test, but we haven't really attempted to do that at all yet -- and there are 1,001 failing selser tests
  in the main parser test file.
- Eventually we probably need to eliminate most of the known failures, as part of replacing the legacy parser.
  Probably the first step is to fix up the ~138 failing `wt2html` tests, which are mostly "unported legacy tests".
