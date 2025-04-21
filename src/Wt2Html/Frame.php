<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TokenUtils;

/**
 * A frame represents a template expansion scope including parameters passed
 * to the template (args). It provides a generic 'expand' method which
 * expands / converts individual parameter values in its scope.  It also
 * provides methods to check if another expansion would lead to loops or
 * exceed the maximum expansion depth.
 */
class Frame {
	/** @var ?Frame */
	private $parentFrame;

	/** @var Env */
	private $env;

	/** @var Title */
	private $title;

	/** @var Params */
	private $args;

	/** @var string */
	private $srcText;

	/** @var int */
	private $depth;

	/**
	 * @param Title $title
	 * @param Env $env
	 * @param KV[] $args
	 * @param string $srcText
	 * @param ?Frame $parentFrame
	 */
	public function __construct(
		Title $title, Env $env, array $args, string $srcText,
		?Frame $parentFrame = null
	) {
		$this->title = $title;
		$this->env = $env;
		$this->args = new Params( $args );
		$this->srcText = $srcText;

		if ( $parentFrame ) {
			$this->parentFrame = $parentFrame;
			$this->depth = $parentFrame->depth + 1;
		} else {
			$this->parentFrame = null;
			$this->depth = 0;
		}
	}

	public function getEnv(): Env {
		return $this->env;
	}

	public function getTitle(): Title {
		return $this->title;
	}

	public function getArgs(): Params {
		return $this->args;
	}

	public function getSrcText(): string {
		return $this->srcText;
	}

	/**
	 * Create a new child frame.
	 * @param Title $title
	 * @param KV[] $args
	 * @param string $srcText
	 * @return Frame
	 */
	public function newChild( Title $title, array $args, string $srcText ): Frame {
		return new Frame( $title, $this->env, $args, $srcText, $this );
	}

	/**
	 * Expand / convert a thunk (a chunk of tokens not yet fully expanded).
	 * @param array<Token|string> $chunk
	 * @param array $options
	 * @return array<Token|string>
	 */
	public function expand( array $chunk, array $options ): array {
		$this->env->log( 'debug', 'Frame.expand', $chunk );

		if ( !$chunk ) {
			return $chunk;
		}

		// Add an EOFTk if it isn't present
		$content = $chunk;
		if ( !( PHPUtils::lastItem( $chunk ) instanceof EOFTk ) ) {
			$content[] = new EOFTk();
		}

		// Downstream template uses should be tracked and wrapped only if:
		// - not in a nested template        Ex: {{Templ:Foo}} and we are processing Foo
		// - not in a template use context   Ex: {{ .. | {{ here }} | .. }}
		// - the attribute use is wrappable  Ex: [[ ... | {{ .. link text }} ]]

		$opts = [
			'pipelineType' => 'peg-tokens-to-expanded-tokens',
			'pipelineOpts' => [
				'expandTemplates' => $options['expandTemplates'],
				'inTemplate' => $options['inTemplate'],
				'attrExpansion' => $options['attrExpansion'] ?? false
			],
			'sol' => true,
			'srcOffsets' => $options['srcOffsets'] ?? null,
			'tplArgs' => [ 'name' => null, 'title' => null, 'attribs' => [] ]
		];

		$tokens = PipelineUtils::processContentInPipeline( $this->env, $this, $content, $opts );
		TokenUtils::stripEOFTkFromTokens( $tokens );
		return $tokens;
	}

	/**
	 * Check if expanding a template would lead to a loop, or would exceed the
	 * maximum expansion depth.
	 *
	 * @param Title $title
	 * @param int $maxDepth
	 * @param bool $ignoreLoop
	 * @return ?string null => no error; non-null => error message
	 */
	public function loopAndDepthCheck( Title $title, int $maxDepth, bool $ignoreLoop ): ?string {
		if ( $this->depth > $maxDepth ) {
			// Too deep
			return "Template recursion depth limit exceeded ($maxDepth): ";
		}

		if ( $ignoreLoop ) {
			return null;
		}

		$frame = $this;
		do {
			if ( $title->equals( $frame->title ) ) {
				// Loop detected
				return 'Template loop detected: ';
			}
			$frame = $frame->parentFrame;
		} while ( $frame );

		// No loop detected.
		return null;
	}

	/**
	 * @param mixed $arg
	 * @param SourceRange $srcOffsets
	 * @return array
	 */
	private function expandArg( $arg, SourceRange $srcOffsets ): array {
		if ( is_string( $arg ) ) {
			return [ $arg ];
		} else {
			return $this->expand( $arg, [
				'expandTemplates' => true,
				'inTemplate' => true,
				'srcOffsets' => $srcOffsets,
			] );
		}
	}

	/**
	 * @param Token $tplArgToken
	 * @return array tokens representing the arg value
	 */
	public function expandTemplateArg( Token $tplArgToken ): array {
		$args = $this->args->named();
		$attribs = $tplArgToken->attribs;

		$expandedKeyToks = $this->expandArg(
			$attribs[0]->k,
			$attribs[0]->srcOffsets->key
		);

		$argName = trim( TokenUtils::tokensToString( $expandedKeyToks ) );
		$res = $args['dict'][$argName] ?? null;

		if ( $res !== null ) {
			$res = isset( $args['namedArgs'][$argName] ) ?
				TokenUtils::tokenTrim( $res ) : $res;
			return is_string( $res ) ? [ $res ] : $res;
		} elseif ( count( $attribs ) > 1 ) {
			return $this->expandArg(
				$attribs[1]->v,
				$attribs[1]->srcOffsets->value
			);
		} else {
			return array_merge( [ '{{{' ], $expandedKeyToks, [ '}}}' ] );
		}
	}
}
