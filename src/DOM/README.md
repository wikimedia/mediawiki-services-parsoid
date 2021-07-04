This is a "virtual" namespace, used for the particular DOM implementation
Parsoid is choosing to use.

The actual DOM implementation is actually in
`Wikimedia\Dodo` or `Wikimedia\Parsoid\DOM\Compat`, and is
aliased into this namespace via `DomImpl.php` at the top level
of this project.
