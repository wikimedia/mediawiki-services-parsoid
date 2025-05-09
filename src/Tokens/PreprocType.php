<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use InvalidArgumentException;

/**
 * Types of preprocessor pieces.
 */
enum PreprocType {
	/** Square brackets, for wikilinks and external links: `[ ]`. */
	case BRACKET;
	/** Angle brackets, for extension tags: `< >`. */
	case ANGLE;
	/** Curly braces, for templates, parser functions, and template arguments: `{ }`. */
	case BRACE;
	/** Dash-brace, for language converter markup: `-{ }-`. */
	case DASH_BRACE;
	/** Comment, for HTML-style comments: `<!-- -->`. */
	case COMMENT;
	/** Ignored content, for <noinclude>/<includeonly>/etc. */
	case IGNORE;
	/** Potential headings: `== Foo ==`. */
	case HEADING;
	/** Parsoid fragment tokens (strip markers) */
	case PFRAGMENT;

	public function open(): string {
		return match ( $this ) {
			self::BRACKET => '[',
			self::ANGLE => '<',
			self::BRACE => '{',
			self::DASH_BRACE => '-{',
			self::COMMENT => '<!--',
			self::HEADING => '=',
			self::IGNORE, self::PFRAGMENT => '',
		};
	}

	public function close(): string {
		return match ( $this ) {
			self::BRACKET => ']',
			self::ANGLE => '>',
			self::BRACE => '}',
			self::DASH_BRACE => '}-',
			self::COMMENT => '-->',
			self::HEADING => '=',
			self::IGNORE, self::PFRAGMENT => '',
		};
	}

	public function minCount(): int {
		return match ( $this ) {
			self::BRACE => 2,
			default => 1,
			self::IGNORE, self::PFRAGMENT => 0,
		};
	}

	public function maxCount(): int {
		return match ( $this ) {
			self::BRACKET => 2,
			self::BRACE => 3,
			self::HEADING => 6,
			default => 1,
			self::IGNORE, self::PFRAGMENT => 0,
		};
	}

	public static function fromOpen( string $s ): self {
		return match ( $s ) {
			'[' => self::BRACKET,
			'<' => self::ANGLE,
			'{' => self::BRACE,
			'-{' => self::DASH_BRACE,
			'<!--' => self::COMMENT,
			'=' => self::HEADING,
			default => throw new InvalidArgumentException( $s ),
		};
	}

	/**
	 * If $sr represents a source range including $count copies of the
	 * delimiters, return a source range covering just the contents.
	 */
	public function shrinkRange( SourceRange $sr, int $count = 1 ): SourceRange {
		return new SourceRange(
			$sr->start + $count * strlen( $this->open() ),
			$sr->end - $count * strlen( $this->close() ),
			$sr->source
		);
	}

	/**
	 * If $sr represents a source range for the contents, return a
	 * source range including $count copies of the delimiters.
	 */
	public function growRange( SourceRange $sr, int $count = 1 ): SourceRange {
		return $this->shrinkRange( $sr, -$count );
	}
}
