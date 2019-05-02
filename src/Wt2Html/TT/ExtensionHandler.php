<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\TokenHandler as TokenHandler;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\PipelineUtils as PipelineUtils;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ExtensionHandler extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		// Extension content expansion
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onExtension( $token, $cb );
   },
			'ExtensionHandler:onExtension', self::rank(),
			'tag', 'extension'
		);
	}

	public static function rank() {
 return 1.11;
 }

	/**
	 * Parse the extension HTML content and wrap it in a DOMFragment
	 * to be expanded back into the top-level DOM later.
	 */
	public function parseExtensionHTML( $extToken, $cb, $err, $doc ) {
		$errType = '';
		$errObj = [];
		if ( $err ) {
			$doc = $this->env->createDocument( '<span></span>' );
			$doc->body->firstChild->appendChild( $doc->createTextNode( $extToken->getAttribute( 'source' ) ) );
			$errType = 'mw:Error ';
			// Provide some info in data-mw in case some client can do something with it.
			$errObj = [
				'errors' => [
					[
						'key' => 'mw-api-extparse-error',
						'message' => 'Could not parse extension source.'
					]
				]
			];
			$this->env->log(
				'error/extension', 'Error', $err, ' parsing extension token: ',
				json_encode( $extToken )
			);
		}

		$psd = $this->manager->env->conf->parsoid;
		if ( $psd->dumpFlags && $psd->dumpFlags->has( 'extoutput' ) ) {
			$console->warn( '='->repeat( 80 ) );
			$console->warn( 'EXTENSION INPUT: ' . $extToken->getAttribute( 'source' ) );
			$console->warn( '='->repeat( 80 ) );
			$console->warn( "EXTENSION OUTPUT:\n" );
			$console->warn( $doc->body->outerHTML );
			$console->warn( '-'->repeat( 80 ) );
		}

		// document -> html -> body -> children
		$state = [
			'token' => $extToken,
			'wrapperName' => $extToken->getAttribute( 'name' ),
			// We are always wrapping extensions with the DOMFragment mechanism.
			'wrappedObjectId' => $this->env->newObjectId(),
			'wrapperType' => $errType . 'mw:Extension/' . $extToken->getAttribute( 'name' ),
			'wrapperDataMw' => $errObj,
			'isHtmlExt' => ( $extToken->getAttribute( 'name' ) === 'html' )
		];

		// DOMFragment-based encapsulation.
		$this->_onDocument( $state, $cb, $doc );
	}

	/**
	 * Fetch the preprocessed wikitext for an extension.
	 */
	public function fetchExpandedExtension( $text, $parentCB, $cb ) {
		$env = $this->env;
		// We are about to start an async request for an extension
		$env->log( 'debug', 'Note: trying to expand ', $text );
		$parentCB( [ 'async' => true ] );
		// Pass the page title to the API.
		$title = $env->page->name || '';
		$env->batcher->parse( $title, $text )->nodify( $cb );
	}

	public static function normalizeExtOptions( $options ) {
		// Mimics Sanitizer::decodeTagAttributes from the PHP parser
		//
		// Extension options should always be interpreted as plain text. The
		// tokenizer parses them to tokens in case they are for an HTML tag,
		// but here we use the text source instead.
		$n = count( $options );
		for ( $i = 0;  $i < $n;  $i++ ) {
			$o = $options[ $i ];
			if ( !$o->v && !$o->vsrc ) {
				continue;
			}

			// Use the source if present. If not use the value, but ensure it's a
			// string, as it can be a token stream if the parser has recognized it
			// as a directive.
			$v = $o->vsrc
|| ( ( $o->v->constructor === $String ) ? $o->v :
				TokenUtils::tokensToString( $o->v, false, [ 'includeEntities' => true ] ) );
			// Normalize whitespace in extension attribute values
			// FIXME: If the option is parsed as wikitext, this normalization
			// can mess with src offsets.
			$o->v = trim( preg_replace( '/[\t\r\n ]+/', ' ', $v ) );
			// Decode character references
			$o->v = Util::decodeWtEntities( $o->v );
		}
		return $options;
	}

	public function onExtension( $token, $cb ) {
		$env = $this->env;
		$extensionName = $token->getAttribute( 'name' );
		$nativeExt = $env->conf->wiki->extConfig->tags->get( $extensionName );
		// TODO: use something order/quoting etc independent instead of src
		$cachedExpansion = $env->extensionCache[ $token->dataAttribs->src ];

		$options = $token->getAttribute( 'options' );
		$token->setAttribute( 'options', self::normalizeExtOptions( $options ) );

		if ( $nativeExt && $nativeExt->toDOM ) {
			$extContent = Util::extractExtBody( $token );
			$extArgs = $token->getAttribute( 'options' );
			$state = [
				'extToken' => $token,
				// FIXME: This is only used by extapi.js
				// but leaks to extensions right now
				'frame' => $this->manager->frame,
				'env' => $this->manager->env,
				// FIXME: extTag, extTagOpts, inTemplate are used
				// by extensions. Should we directly export those
				// instead?
				'parseContext' => $this->options
			];
			$p = $nativeExt->toDOM( $state, $extContent, $extArgs );
			if ( $p ) {
				// Pass an async signal since the ext-content won't be processed synchronously
				$cb( [ 'async' => true ] );
				$p->nodify( function ( $err, $doc ) use ( &$token, &$cb ) {return $this->parseExtensionHTML( $token, $cb, $err, $doc );
	   } );
			} else {
				// The extension dropped this instance completely (!!)
				// Should be a rarity and presumably the extension
				// knows what it is doing. Ex: nested refs are dropped
				// in some scenarios.
				$cb( [ 'tokens' => [], 'async' => false ] );
			}
		} elseif ( $cachedExpansion ) {
			// cache hit. Reuse extension expansion.
			$toks = PipelineUtils::encapsulateExpansionHTML( $env, $token, $cachedExpansion, [
					'fromCache' => true
				]
			);
			$cb( [ 'tokens' => $toks ] );
		} elseif ( $env->conf->parsoid->expandExtensions ) {
			// Use MediaWiki's action=parse
			$this->fetchExpandedExtension(
				$token->getAttribute( 'source' ),
				$cb,
				function ( $err, $html ) use ( &$token, &$cb, &$env ) {
					// FIXME: This is a hack to account for the php parser's
					// gratuitous trailing newlines after parse requests.
					// Trimming keeps the top-level nodes length down to just
					// the <style> tag, so it can keep that dom fragment
					// representation as it's tunnelled through to the dom.
					if ( !$err && $token->getAttribute( 'name' ) === 'templatestyles' ) { $html = trim( $html );
		   }
					$this->parseExtensionHTML( $token, $cb, $err, ( $err ) ? null : $env->createDocument( $html ) );
				}
			);
		} else {
			$err = new Error( '`expandExtensions` is disabled.' );
			$this->parseExtensionHTML( $token, $cb, $err, null );
		}
	}

	public function _onDocument( $state, $cb, $doc ) {
		$env = $this->manager->env;

		$argDict = Util::getExtArgInfo( $state->token )->dict;
		if ( $state->token->dataAttribs->extTagOffsets[ 2 ] === $state->token->dataAttribs->extTagOffsets[ 3 ] ) {
			$argDict->body = null; // Serialize to self-closing.
		}
		// Give native extensions a chance to manipulate the argDict
		$nativeExt = $env->conf->wiki->extConfig->tags->get( $state->wrapperName );
		if ( $nativeExt && $nativeExt->modifyArgDict ) {
			$nativeExt->modifyArgDict( $env, $argDict );
		}

		$opts = Object::assign( [
				'setDSR' => true, // FIXME: This is the only place that sets this ...
				'wrapperName' => $state->wrapperName
			],

			 // Check if the tag wants its DOM fragment not to be unwrapped.
			// The default setting is to unwrap the content DOM fragment automatically.
			$nativeExt && $nativeExt->fragmentOptions
		);

		$body = $doc->body;

		// This special case is only because, from the beginning, Parsoid has
		// treated <nowiki>s as core functionality with lean markup (no about,
		// no data-mw, custom typeof).
		//
		// We'll keep this hardcoded to avoid exposing the functionality to
		// other native extensions until it's needed.
		if ( $state->wrapperName !== 'nowiki' ) {
			if ( !$body->hasChildNodes() ) {
				// RT extensions expanding to nothing.
				$body->appendChild( $body->ownerDocument->createElement( 'link' ) );
			}

			// Wrap the top-level nodes so that we have a firstNode element
			// to annotate with the typeof and to apply about ids.
			PipelineUtils::addSpanWrappers( $body->childNodes );

			// Now get the firstNode
			$firstNode = $body->firstChild;

			// Adds the wrapper attributes to the first element
			$firstNode->setAttribute( 'typeof', $state->wrapperType );

			// Add about to all wrapper tokens.
			$about = $env->newAboutId();
			$n = $firstNode;
			while ( $n ) {
				$n->setAttribute( 'about', $about );
				$n = $n->nextSibling;
			}

			// Set data-mw
			DOMDataUtils::setDataMw(
				$firstNode,
				Object::assign( $state->wrapperDataMw || [], $argDict )
			);

			// Update data-parsoid
			$dp = DOMDataUtils::getDataParsoid( $firstNode );
			$dp->tsr = Util::clone( $state->token->dataAttribs->tsr );
			$dp->src = $state->token->dataAttribs->src;
			DOMDataUtils::setDataParsoid( $firstNode, $dp );
		}

		$toks = PipelineUtils::buildDOMFragmentTokens( $env, $state->token, $body, $opts );

		if ( $state->isHtmlExt ) {
			$toks[ 0 ]->dataAttribs->tmp = $toks[ 0 ]->dataAttribs->tmp || [];
			$toks[ 0 ]->dataAttribs->tmp->isHtmlExt = true;
		}

		$cb( [ 'tokens' => $toks ] );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->ExtensionHandler = $ExtensionHandler;
}
