<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use DOMDocument;
use DOMElement;

use Parsoid\Tokens\DomSourceRange;
use Parsoid\Tokens\SourceRange;
use Parsoid\Tokens\Token;
use Parsoid\Wt2Html\Frame;
use Parsoid\Wt2Html\TT\Sanitizer;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PipelineUtils;

/**
 * Extensions should / will eventually only get access to an instance of this config.
 * Instead of giving them direct access to all of Env, maybe we should given access
 * to specific properties (title, wiki config, page config) and methods as necessary.
 *
 * But, that is post-port TODO when we think more seriously about the extension and hooks API.
 *
 * Extensions are expected to use only these interfaces and strongly discouraged from
 * calling Parsoid code directly. Code review is expected to catch these discouraged
 * code patterns. We'll have to finish grappling with the extension and hooks API
 * to go down this path seriously. Till then, we'll have extensions leveraging existing
 * code as in the native extension code in this repository.
 */
class ParsoidExtensionAPI {
	/** @var Env */
	private $env;

	/** @var Frame */
	private $frame;

	/** @var Token */
	private $extToken;

	/**
	 * FIXME: extTag, extTagOpts, inTemplate are used by extensions.
	 * Should we directly export those instead?
	 * @var array TokenHandler options
	 */
	public $parseContext;

	/**
	 * @param Env $env
	 * @param Frame|null $frame
	 * @param Token|null $extToken
	 * @param array|null $parseContext
	 */
	public function __construct(
		Env $env, Frame $frame = null, Token $extToken = null, array $parseContext = null
	) {
		$this->env = $env;
		$this->frame = $frame;
		$this->extToken = $extToken;
		$this->parseContext = $parseContext;
	}

	/**
	 * @return Env
	 */
	public function getEnv(): Env {
		return $this->env;
	}

	/**
	 * @return Frame
	 */
	public function getFrame(): Frame {
		return $this->frame;
	}

	/**
	 * Return the extTagOffsets from the extToken.
	 * @return DomSourceRange|null
	 */
	public function getExtTagOffsets(): ?DomSourceRange {
		return $this->extToken->dataAttribs->extTagOffsets ?? null;
	}

	/**
	 * @return string
	 */
	public function getExtensionName(): string {
		return $this->extToken->getAttribute( 'name' );
	}

	/**
	 * Return the full extension source
	 * @return string|null
	 */
	public function getExtSource(): ?string {
		if ( $this->extToken->hasAttribute( 'source ' ) ) {
			return $this->extToken->getAttribute( 'source' );
		} else {
			return null;
		}
	}

	/**
	 * Is this extension tag self-closed?
	 * @return bool
	 */
	public function isSelfClosedExtTag(): bool {
		return !empty( $this->extToken->dataAttribs->selfClose );
	}

	/**
	 * Create a parsing pipeline to parse wikitext.
	 *
	 * @param string $wikitext
	 * @param array $parseOpts
	 *    - extTag
	 *    - extTagOpts
	 *    - frame
	 *    - inTemplate
	 *    - inlineContext
	 *    - inPHPBlock
	 *    - srcOffsets
	 * @param bool $sol
	 * @return DOMDocument
	 */
	public function parseWikitextToDOM(
		string $wikitext, array $parseOpts, bool $sol
	): DOMDocument {
		$doc = null;
		if ( $wikitext === '' ) {
			$doc = $this->env->createDocument();
		} else {
			// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
			// The DOM will get unwrapped and integrated  when processing the top level document.
			$pipelineOpts = $parseOpts['pipelineOpts'] ?? [];
			$opts = [
				// Full pipeline for processing content
				'pipelineType' => 'text/x-mediawiki/full',
				'pipelineOpts' => [
					'expandTemplates' => true,
					'extTag' => $pipelineOpts['extTag'],
					'extTagOpts' => $pipelineOpts['extTagOpts'] ?? null,
					'inTemplate' => !empty( $pipelineOpts['inTemplate'] ),
					'inlineContext' => !empty( $pipelineOpts['inlineContext'] ),
					// FIXME: Hack for backward compatibility
					// support for extensions that rely on this behavior.
					'inPHPBlock' => !empty( $pipelineOpts['inPHPBlock'] )
				],
				'srcOffsets' => $parseOpts['srcOffsets'] ?? null,
				'sol' => $sol
			];
			$doc = PipelineUtils::processContentInPipeline(
				$this->env,
				$parseOpts['frame'] ?? $this->frame,
				$wikitext,
				$opts
			);
		}
		return $doc;
	}

	/**
	 * @param array $extArgs
	 * @param string $leadingWS
	 * @param string $wikitext
	 * @param array $parseOpts
	 *    - extTag
	 *    - extTagOpts
	 *    - inTemplate
	 *    - inlineContext
	 *    - inPHPBlock
	 * @return DOMDocument
	 */
	public function parseTokenContentsToDOM(
		array $extArgs, string $leadingWS, string $wikitext, array $parseOpts
	): DOMDocument {
		$dataAttribs = $this->extToken->dataAttribs;
		$extTagOffsets = $dataAttribs->extTagOffsets;
		$srcOffsets = new SourceRange(
			$extTagOffsets->innerStart() + strlen( $leadingWS ),
			$extTagOffsets->innerEnd()
		);

		$doc = $this->parseWikitextToDOM(
			$wikitext,
			$parseOpts + [ 'srcOffsets' => $srcOffsets ],
			/* sol */true
		);

		// Create a wrapper and migrate content into the wrapper
		$wrapper = $doc->createElement( $parseOpts['wrapperTag'] );
		$body = DOMCompat::getBody( $doc );
		DOMUtils::migrateChildren( $body, $wrapper );
		$body->appendChild( $wrapper );

		// Sanitize argDict.attrs and set on the wrapper
		Sanitizer::applySanitizedArgs( $this->env, $wrapper, $extArgs );

		// Mark empty content DOMs
		if ( $wikitext === '' ) {
			DOMDataUtils::getDataParsoid( $wrapper )->empty = true;
		}

		if ( !empty( $this->extToken->dataAttribs->selfClose ) ) {
			DOMDataUtils::getDataParsoid( $wrapper )->selfClose = true;
		}

		return $doc;
	}

	/**
	 * @param DOMElement $elt
	 * @param array $extArgs
	 */
	public function sanitizeArgs( DOMElement $elt, array $extArgs ): void {
		Sanitizer::applySanitizedArgs( $this->env, $elt, $extArgs );
	}

	// TODO: Provide support for extensions to register lints
	// from their customized lint handlers.
}
