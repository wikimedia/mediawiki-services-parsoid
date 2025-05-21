<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

abstract class TokenHandler {
	protected Env $env;
	protected TokenHandlerPipeline $manager;
	protected ?int $pipelineId;
	protected array $options;
	/** This is set if the token handler is disabled for the entire pipeline. */
	protected bool $disabled = false;
	/**
	 * This is set/reset by the token handlers at various points in the token stream based on what
	 * is encountered. This only enables/disables the onAny handler.
	 */
	protected bool $atTopLevel = false;

	/**
	 * @param TokenHandlerPipeline $manager The manager for this stage of the parse.
	 * @param array $options Any options for the expander.
	 */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		$this->manager = $manager;
		$this->env = $manager->getEnv();
		$this->options = $options;
	}

	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
	}

	/**
	 * Resets any internal state for this token handler.
	 *
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		$this->atTopLevel = $options['toplevel'] ?? false;
	}

	/**
	 * Is this transformer disabled?
	 * @return bool
	 */
	public function isDisabled(): bool {
		return $this->disabled;
	}

	/**
	 * Push an input array of tokens through the handler
	 * and return a new array of transformed tokens.
	 *
	 * @param array<string|Token> $tokens
	 * @return array<string|Token>
	 */
	abstract public function process( array $tokens ): array;
}
