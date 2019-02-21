<?php
declare( strict_types = 1 );

namespace Parsoid\Utils\DOMCompat;

use DomainException;
use InvalidArgumentException;
use Wikimedia\CSS\Grammar\Match;
use Wikimedia\CSS\Grammar\MatcherFactory;
use Wikimedia\CSS\Objects\Token;
use Wikimedia\CSS\Parser\Parser;

/**
 * Helper class to convert a CSS selector to an XPath expression understood by the PHP DOM.
 * Only handles certain types of selectors that are actually used by Parsoid.
 * TODO replace this with zest, probably.
 */
class SelectorToXPath {

	/**
	 * Takes a CSS selector string (more precisely, what the CSS spec calls a selector group)
	 * and returns an equivalent XPath 1.0 string.
	 * @param string $selector
	 * @return string
	 * @throws InvalidArgumentException If the selector is incorrect.
	 * @throws DomainException If the selector is unsupported.
	 */
	public static function convert( string $selector ): string {
		$parser = Parser::newFromString( $selector );
		$selectorCVL = $parser->parseComponentValueList();
		$cssSelectorListMatcher = MatcherFactory::singleton()->cssSelectorList();
		$selectorGroupMatch = $cssSelectorListMatcher->match( $selectorCVL );
		if ( !$selectorGroupMatch ) {
			throw new InvalidArgumentException( "Invalid selector: $selector" );
		}
		return self::selectorGroupToXPathExpression( $selectorGroupMatch );
	}

	/**
	 * Turns a selector group (comma-separated list of selectors) to an equivalent xpath expression.
	 * @param Match $selectorGroupMatch
	 * @return string
	 */
	private static function selectorGroupToXPathExpression( Match $selectorGroupMatch ): string {
		$xpathSegments = [];
		foreach ( $selectorGroupMatch->getCapturedMatches() as $selectorMatch ) {
			$xpathSegment = self::selectorToXPathExpression( $selectorMatch );
			$xpathSegments[] = "($xpathSegment)";
		}
		return implode( '|', $xpathSegments );
	}

	/**
	 * Turns a CSS selector (as defined in the spec, i.e. no commas) into an XPath expression.
	 * @param Match $selectorMatch A match that came from MatcherFactory::cssSelector()
	 * @return string
	 */
	private static function selectorToXPathExpression( Match $selectorMatch ): string {
		$xpathExpression = './/';
		foreach ( $selectorMatch->getCapturedMatches() as $sssOrCombinatorMatch ) {
			if ( $sssOrCombinatorMatch->getName() === 'simple' ) {
				// simple selector sequence
				$element = null;
				$simpleSelectorXPathExpression = '';
				foreach ( $sssOrCombinatorMatch->getCapturedMatches() as $simpleSelectorMatch ) {
					$simpleSelectorXPathExpression
						.= self::simpleSelectorToXPathExpression( $simpleSelectorMatch, $element );
					$element = $element ?? '*';
				}
				$xpathExpression .= $element . $simpleSelectorXPathExpression;

			} elseif ( $sssOrCombinatorMatch->getName() === 'combinator' ) {
				$combinator = trim( (string)$sssOrCombinatorMatch ) ?: ' ';
				switch ( $combinator ) {
					case ' ':
						$xpathExpression .= '//';
						break;
					case '>':
						$xpathExpression .= '/';
						break;
					default:
						throw new DomainException( "Unsupported combinator: $combinator" );
				}
			}
		}
		return $xpathExpression;
	}

	/**
	 * Convert a simple CSS selector (e.g. .foo or [foo="bar"]) to an XPath segment.
	 * @param Match $simpleSelectorMatch A match that came from MatcherFactory::cssSimpleSelectorSeq()
	 * @param string|null $element XPath axis from previous simple selectors in this sequence.
	 *   Can be null (meaning this is the first simple selector in the sequence), '*' or a tag name.
	 *   Will be updated if this is an element selector.
	 * @return string
	 */
	private static function simpleSelectorToXPathExpression(
		Match $simpleSelectorMatch, ?string &$element
	): string {
		$type = $simpleSelectorMatch->getName();
		switch ( $type ) {
			case 'element':
				if ( $element !== null ) {
					// This is not the first simple selector in the sequence so it shouldn't be an
					// element selector. (Sanity check; the Matcher should prevent this.)
					throw new InvalidArgumentException( 'Too many element selectors' );
				}
				$element = (string)$simpleSelectorMatch;
				if ( $element !== '*' ) {
					// Namespaced star/element is not a use case we care about.)
					self::assertQuotableXPathLiteral( $element );
				}
				// Return nothing; this is handled by the caller since when there's no element
				// a star must be filled in.
				return '';
			case 'id':
				$id = substr( (string)$simpleSelectorMatch, 1 );
				self::assertQuotableXPathLiteral( $id );
				return "[@id='$id']";
			case 'class':
				$class = substr( (string)$simpleSelectorMatch, 1 );
				self::assertQuotableXPathLiteral( $class );
				return "[contains(concat(' ', normalize-space(@class), ' '), ' $class ')]";
			case 'attrib':
				$parts = $simpleSelectorMatch->getCapturedMatches();
				$attribute = (string)$parts[0];
				// sanity check, XPath has no escaping
				if ( !preg_match( '/^[\w\d_-]+$/', $attribute ) ) {
					throw new InvalidArgumentException( "Invalid attribute name $attribute" );
				}
				if ( isset( $parts[1] ) ) {
					$test = (string)$parts[1];
					// the value is a single string or ident token
					// FIXME css-sanitizer does not support case-insensitive tests
					/** @var Token $valueToken */
					$valueToken = $parts[2]->getValues()[0];
					$value = $valueToken->value();
					self::assertQuotableXPathLiteral( $value );
					switch ( $test ) {
						case '=':
							return "[@$attribute='$value']";
						case '~=':
							return "[contains(concat(' ', normalize-space(@$attribute), ' '), ' $value ')]";
						default:
							throw new DomainException( "Unsupported attribute test $test" );
					}
				} else {
					return "[@$attribute]";
				}
			case 'pseudo':
				if ( (string)$simpleSelectorMatch === ':empty' ) {
					return '[not(*) and not(normalize-space(text()))]';
				}
				break;
		}
		throw new DomainException( "Unsupported simple selector: $simpleSelectorMatch" );
	}

	/**
	 * Make sure that an XPath literal is quotable (i.e. does not include any quotes).
	 * XPath does not have any escaping, and the literals are not user-generated so we
	 * don't need any, just make sure we fail hard if something weird is going on.
	 * @param $str
	 */
	private static function assertQuotableXPathLiteral( $str ): void {
		if ( strpos( $str, '"' ) !== false || strpos( $str, "'" ) !== false ) {
			throw new DomainException( "Unquotable XPath literal: $str" );
		}
	}

}
