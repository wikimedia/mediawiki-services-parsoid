<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\CompoundTk;
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
	 * Process the compound token in a handler-specific way.
	 * - Some handlers might ignore it and pass it through
	 * - Some handlers might process its nested tokens and update it
	 * - Some handlers might process its nested tokens and flatten it
	 *
	 * To ensure that handlers that encounter compound tokens always
	 * have explicit handling for them, the default implementation
	 * here will throw an exception!
	 *
	 * NOTE: The only reason we are processing a handler here is because
	 * of needing to support profiling. For the profiling use case,
	 * we will be processing a TraceProxy instead of the handler itself.
	 *
	 * @return ?array<string|Token>
	 */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		throw new UnreachableException(
			get_class( $this ) . ": Unsupported compound token."
		);
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
