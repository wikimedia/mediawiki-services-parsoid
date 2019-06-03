<?php

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PipelineUtils;
use Parsoid\Utils\TokenUtils;

/**
 * A frame represents a template expansion scope including parameters passed
 * to the template (args). It provides a generic 'expand' method which
 * expands / converts individual parameter values in its scope.  It also
 * provides methods to check if another expansion would lead to loops or
 * exceed the maximum expansion depth.
 */
class Frame {
	/** @var Frame */
	private $parentFrame;

	/** @var Env */
	private $env;

	/** @var string */
	private $title;

	/** @var Params */
	private $args;

	/** @var int */
	private $depth;

	/**
	 * @param string|null $title
	 * @param Env $env
	 * @param array $args
	 * @param Frame|null $parentFrame
	 */
	public function __construct(
		?string $title, Env $env, array $args, Frame $parentFrame = null
	) {
		$this->title = $title;
		$this->env = $env;
		$this->args = new Params( $args );

		if ( $parentFrame ) {
			$this->parentFrame = $parentFrame;
			$this->depth = $parentFrame->depth + 1;
		} else {
			$this->parentFrame = null;
			$this->depth = 0;
		}
	}

	/**
	 * Create a new child frame.
	 * @param string $title
	 * @param array $args
	 * @return Frame
	 */
	public function newChild( string $title, array $args ): Frame {
		return new Frame( $title, $this->env, $args, $this );
	}

	/**
	 * Expand / convert a thunk (a chunk of tokens not yet fully expanded).
	 * @param Token[] $chunk
	 * @param array $options
	 * @return Token[]
	 */
	public function expand( array $chunk, array $options ): array {
		$this->env->log( 'debug', 'Frame.expand', $chunk );

		if ( !$chunk ) {
			return $chunk;
		}

		// Add an EOFTk if it isn't present
		$content = $chunk;
		if ( !( end( $chunk ) instanceof EOFTk ) ) {
			$content[] = new EOFTk();
		}

		// Downstream template uses should be tracked and wrapped only if:
		// - not in a nested template        Ex: {{Templ:Foo}} and we are processing Foo
		// - not in a template use context   Ex: {{ .. | {{ here }} | .. }}
		// - the attribute use is wrappable  Ex: [[ ... | {{ .. link text }} ]]

		$opts = [
			'pipelineType' => 'tokens/x-mediawiki',
			'pipelineOpts' => [
				'isInclude' => $this->depth > 0,
				'expandTemplates' => !empty( $options['expandTemplates'] ),
				'inTemplate' => !empty( $options['inTemplate'] )
			],
			'sol' => true,
			'tplArgs' => [ 'name' => null, 'attribs' => [] ]
		];

		$tokens = PipelineUtils::processContentInPipeline( $this->env, $this, $content, $opts );
		TokenUtils::stripEOFTkfromTokens( $tokens );
		return $tokens;
	}

	/**
	 * Check if expanding a template would lead to a loop, or would exceed the
	 * maximum expansion depth.
	 *
	 * @param string $title
	 * @param int $maxDepth
	 * @param bool $ignoreLoop
	 * @return ?string null => no error; non-null => error message
	 */
	public function loopAndDepthCheck( string $title, int $maxDepth, bool $ignoreLoop ): ?string {
		if ( $this->depth > $maxDepth ) {
			return 'Error: Expansion depth limit exceeded'; // Too deep
		}

		if ( $ignoreLoop ) {
			return null;
		}

		$frame = $this;
		do {
			if ( $frame->title === $title ) {
				return 'Error: Expansion loop detected'; // Loop detected
			}
			$frame = $frame->parentFrame;
		} while ( $frame );

		// No loop detected.
		return null;
	}
}
