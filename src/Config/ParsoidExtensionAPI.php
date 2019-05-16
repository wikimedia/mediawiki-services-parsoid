<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use DOMDocument;
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
	private $parseContext;

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
	 * Create a parsing pipeline to parse wikitext.
	 *
	 * @param string $wikitext
	 * @param int[] $srcOffsets
	 * @param array $parseOpts
	 *    - extTag
	 *    - extTagOpts
	 *    - inTemplate
	 *    - inlineContext
	 *    - inPHPBlock
	 * @param bool $sol
	 * @return DOMDocument
	 */
	public function parseWikitextToDOM(
		string $wikitext, array $srcOffsets, array $parseOpts, bool $sol
	): DOMDocument {
		$doc = null;
		if ( !$wikitext ) {
			$doc = $this->env->createDocument();
		} else {
			// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
			// The DOM will get unwrapped and integrated  when processing the top level document.
			$opts = [
				// Full pipeline for processing content
				'pipelineType' => 'text/x-mediawiki/full',
				'pipelineOpts' => [
					'expandTemplates' => true,
					'extTag' => $parseOpts['extTag'],
					'extTagOpts' => $parseOpts['extTagOpts'],
					'inTemplate' => !empty( $parseOpts['inTemplate'] ),
					'inlineContext' => !empty( $parseOpts['inlineContext'] ),
					// FIXME: Hack for backward compatibility
					// support for extensions that rely on this behavior.
					'inPHPBlock' => !empty( $parseOpts['inPHPBlock'] )
				],
				'srcOffsets' => $srcOffsets,
				'sol' => $sol
			];
			$doc = PipelineUtils::processContentInPipeline( $this->env, $this->frame, $wikitext, $opts );
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
	public function parseTokenContentsToDOM( $extArgs, $leadingWS, $wikitext, $parseOpts ) {
		$dataAttribs = $this->extToken->dataAttribs;
		$extTagOffsets = $dataAttribs->extTagOffsets;
		// PORT_FIXME: should be converted to strlen after byte offsets patch lands
		$srcOffsets = [ $extTagOffsets[1] + mb_strlen( $leadingWS ), $extTagOffsets[2] ];

		$doc = $this->parseWikitextToDOM( $wikitext, $srcOffsets, $parseOpts, /* sol */true );

		// Create a wrapper and migrate content into the wrapper
		$wrapper = $doc->createElement( $parseOpts['wrapperTag'] );
		$body = DOMCompat::getBody( $doc );
		DOMUtils::migrateChildren( $body, $wrapper );
		$body->appendChild( $wrapper );

		// Sanitize argDict.attrs and set on the wrapper
		Sanitizer::applySanitizedArgs( $this->env, $wrapper, $extArgs );

		// Mark empty content DOMs
		if ( !$wikitext ) {
			DOMDataUtils::getDataParsoid( $wrapper )->empty = true;
		}

		if ( !empty( $this->extToken->dataAttribs->selfClose ) ) {
			DOMDataUtils::getDataParsoid( $wrapper )->selfClose = true;
		}

		return $doc;
	}
}
