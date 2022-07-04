<?php

/**
 * See https://wiki.php.net/rfc/internal_method_return_types and
 * https://php.watch/versions/8.1/ReturnTypeWillChange
 *
 * From the php.watch page: "#[\ReturnTypeWillChange] is a new attribute introduced in PHP 8.1,
 * which signals that a mismatching tentative return type should not emit a deprecation notice."
 *
 * This is the solution suggested in https://phabricator.wikimedia.org/T311928#8047219 by
 * @Umherirrender.
 */

#[\Attribute]
class ReturnTypeWillChange {
}
