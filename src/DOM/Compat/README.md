This directory contains a thin wrapper around the built-in DOMDocument
class (and friends).  We need a wrapper because PHP's `class_alias` only
works on user-defined classes, not built-ins.  So we create a thin
user-defined wrapper, which then lets us use `class_alias` to choose
a particular DOM implementation.
