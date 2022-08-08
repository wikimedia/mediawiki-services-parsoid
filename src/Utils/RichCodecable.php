<?php
declare( strict_types=1 );

/**
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 * http://www.gnu.org/copyleft/gpl.html
 *
 * @file
 */
namespace Wikimedia\Parsoid\Utils;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;

/**
 * This is an extension of JsonCodecable which adds some properties useful
 * for rich attributes:
 * * a `::flatten()` method which provides a plain string form of the data
 *   which is used for compatibility with HTML semantics, and
 * * a `::hint()` method which is used to provide additional class hint
 *   information for object.  The default class hint is the name of the
 *   class, but if you want to add modifiers, or perhaps use a superclass
 *   as a hint, this method will allow that sort of customization.
 */
interface RichCodecable extends JsonCodecable {

	/**
	 * Provide a constructor for a default value for objects of this type.
	 * @return ?self
	 */
	public static function defaultValue(): ?self;

	/**
	 * Provide a JsonCodec `Hint` for serializing objects of this type.
	 * @return class-string|Hint|null
	 */
	public static function hint();

	/**
	 * Provide a flattened "plain string" form of this data for use
	 * as the value of a compatibility attribute to implement HTML
	 * semantics.
	 *
	 * @return ?string a plain string, or null to omit the compatibility
	 *  attribute
	 */
	public function flatten(): ?string;
}
