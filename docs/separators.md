# Separator handling in the HTML -> WT direction

## Basic approach

Some wikitext constructs need syntactic newlines before and/or after them
to separate them from other constructs. For example,
* headings and list items always start on a new line
* 2 or more newlines typically trigger paragraph wrapping
* new lists need an empty newline before them
* comment-only lines are completely ignored during parsing
* etc.

### Newline constraint handlers

So, any transformation of HTML to wikitext needs to be cognizant of these
various constraints to ensure that the generated wikitext is semantically
equivalent to the HTML that generated it. Towards this end, Parsoid's
serializer allows DOM nodes to specify newline constraints via DOM handlers on
the nodes. These handlers specify newline constraints before a node, after a
node, between a parent and first child, and between a last child and its parent
and are named "before", "after", "firstChild" and "lastChild".  A DOM node can
register zero to all handlers.

Every handler can specify none, one, or both of
* "min"imum newlines required
* "max"imum newlines allowed

For example, the LI node can define the "firstChild" handler and specify the
constraint [ "max" => 0 ] which indicates that in wikitext, list items are
single-line constructs and there should be no newlines emitted.

As another example, the A node doesn't define any newline handlers because
wikilinks, extlinks have no requirements around newlines.

### Implementation details

In practice, newline constraint handlers are usually more complicated than
simple static specifications. They also depend on the context within which a
node is present. For example, a before handler might need to figure out whether
it is being used for a previous sibling or for a parent. Similarly, an after
handler might need to figure out whether it is being used for a next sibling or
for a parent.

Conceivably, one could introduce two other specialized handlers:
"firstChildParent", and "lastChildParent" to mirror the "firstChild" and
"lastChild" handlers. We would then strip out this logic from the currently
overloaded "before" and "after" handlers that handle constraints for siblings
as well as parents.

### Handling conflicting requirements

Given two sibling nodes A and B, it is conceivable that A's after handler might
specify newline constraints that differ from the newline constraints specified
by B's before handler.

The first level of conflict resolution is simple and is as follows:
* min-nls(A,B) = max(min-nls(A), min-nls(B))
* max-nls(A,B) = min(max-nls(A), max-nls(B))

For example, a TABLE's after handler might require 1 newline but a P's before
handler might require 2 newlines. In this specific example, while the conflict
resolution logic will settle on 2 newlines, given the pair of nodes, 1 newline
is adequate. This indicates that the conflict resolution trades precision for
correctness. Ideally, the P tag's before handler would examine its sibling node
to figure out what a more precise constraint would be, but since adding 2
newlines is not wrong and might even be preferable for wikitext readability
reasons, more complex newline constraint logic yields questionable benefits
while increasing complexity.

It is conceivable that we now end up in a situation where min-nls(A,B) is
bigger than max-nls(A,B) (Ex: A says: [ min=>1, max=>1 ] and B says: [ min=>2,
max=>2 ] ).  For now, we resolve this conflict by resetting max-nls(A,B) to
match min-nls(A,B).  There is some rationale for this strategy that comes down
to conflicting design requirements on the HTML to WT algorithm and we'll
examine this further down in this document.

While it seems like it shouldn't be possible for this to happen, given that we
haven't done a good and thorough job of analyzing all our handlers and proving
that such incompatibilities shouldn't exist, for now, we simply log them as
warnings and occasionally go in and refine the newline constraints (in reality,
we haven't done this for many years now) or fix bugs to eliminate such
conflicts.

### Constraint carryover across nodes

Not all DOM nodes emit content. Some DOM nodes simply update the separator
content. For example, comment nodes and whitespace-only text nodes do this.
BR nodes do this - they update a buffer of accumulated newlines. In general,
when we encounter DOM nodes that serialize to zero-length wikitext opening
and closing tags, we carry over the accumulated separator constraints to the
next encountered DOM node. That node's newline constraints are merged with
the accumulated newline constraints.

This is handled by the mergeSeparatorConstraints logic in Separators.php

## Design requirements

There are two partially conflicting requiements on the HTML -> WT code:
1. Ensuring correctness of generated wikitext, i.e. that the wikitext parses to
	semantically equivalent HTML as the input HTML.
2. Minimizing dirty diffs relative to source wikitext in scenarios where we are
	dealing with HTML edited from Parsoid-generated HTML.

### Ensuring correctness

Given an HTML document with all kinds of newlines in between tags (which
for the most part are semantically insignficant - we'll ignore certain
CSS properties that can make these newlines significant), the HTML -> WT
code has to ensure that the output has the right number of newline separators.
So, this requires that the DOM newline constraints (and the separator
handling code that processes them) add / remove newlines wherever required.

One good strategy to test whether the DOM newlines constraints and the
associated separator handling code are correct is by preprocessing the
input HTML in different ways and verifying that the generated wikitext
is still correct.
1. Strip all newlines between HTML nodes and ensure that the "min" newline
	constraints sufficiently capture all wikitext requirements
2. Introduce multiple (say 2 or 3) nelines between HTML nodes and ensure that
	the "max" newline constraints sufficiently capture all wikitext requirements
3. Chaos mode: Arbitrarily add / remove newlines between HTML nodes and verify
	that the output wikitext is still correct

### Minimizing dirty diffs

At this time, Parsoid has a selective serialization mode that does a fairly
good job of restricting dirty diffs to modified nodes. It even tries to reuse
inter-node separator content from the HTML wherever possible. This further
reduces newline and whitespace diffs even around modified nodes.

But, this selective serialization algorithm will only work effectively in a
scenario where we start with Parsoid HTML *and* where Parsoid HTML preserves
all original newlines found in the original wikitext. In the early days of
Parsoid, this newline and whitespace preservation from wikitext to HTML was
pretty critical to minimizing dirty diffs (even where this whitespace is
semantically insignificant).

Given this it is quite possible that newline constraint handlers as well as our
separator handling code might have implicit dependencies on the availability of
newlines from the original wikitext which then hides bugs in our separator
handling code because these preserved newlines implicitly satisfy the newline
constraints for those wikitext constructs.

### Potentially conflicting requirements

The above two requirements need not be in conflict, but without further
analysis and thinking, it is conceivable that very tightly specified newline
constraints that can handle arbitrary input HTML might start normalizing
separators between nodes. In the best case, this may reflect that the newline
separator handling code has incomplete logic to have full insight into how the
wikitext -> HTML transformation might handle too many / too few newlines
between a pair of nodes and hence incorrectly normalizes them introducing dirty
diffs. But, this effort may not be fully worth it since it is a case of
diminishing returns. Increasingly complex logic gets harder to grok and debug
and maintain.

.. mostly done but to be reviewed and completed ..
