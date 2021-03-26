<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use DOMDocumentFragment;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Ext\ExtensionError;
use Wikimedia\Parsoid\Ext\ExtensionTag;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

class ExtensionHandler extends TokenHandler {
	/**
	 * @param TokenTransformManager $manager
	 * @param array $options
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	/**
	 * @param array $options
	 * @return array
	 */
	private static function normalizeExtOptions( array $options ): array {
		// Mimics Sanitizer::decodeTagAttributes from the PHP parser
		//
		// Extension options should always be interpreted as plain text. The
		// tokenizer parses them to tokens in case they are for an HTML tag,
		// but here we use the text source instead.
		$n = count( $options );
		for ( $i = 0; $i < $n; $i++ ) {
			$o = $options[$i];
			// Use the source if present. If not use the value, but ensure it's a
			// string, as it can be a token stream if the parser has recognized it
			// as a directive.
			$v = $o->vsrc ?? TokenUtils::tokensToString( $o->v, false, [ 'includeEntities' => true ] );
			// Normalize whitespace in extension attribute values
			// FIXME: If the option is parsed as wikitext, this normalization
			// can mess with src offsets.
			$o->v = trim( preg_replace( '/[\t\r\n ]+/', ' ', $v ) );
			// Decode character references
			$o->v = Utils::decodeWtEntities( $o->v );
		}
		return $options;
	}

	/**
	 * Process extension metadata and record it somewhere (Env state or the DOM)
	 *
	 * @param DOMDocumentFragment $domFragment
	 * @param array $modules
	 * @param array $modulestyles
	 * @param array $jsConfigVars
	 * @param ?array $categories
	 */
	private function processExtMetadata(
		DOMDocumentFragment $domFragment, array $modules, array $modulestyles, array $jsConfigVars,
		?array $categories
	): void {
		// Add the modules to the page data
		$this->env->addOutputProperty( 'modules', $modules );
		$this->env->addOutputProperty( 'modulestyles', $modulestyles );
		$this->env->addOutputProperty( 'jsconfigvars', $jsConfigVars );

		/*  - categories: (array) [ Category name => sortkey ] */
		// Add the categories which were added by extensions directly into the
		// page and not as in-text links
		foreach ( ( $categories ?? [] ) as $name => $sortkey ) {
			$link = $domFragment->ownerDocument->createElement( "link" );
			$link->setAttribute( "rel", "mw:PageProp/Category" );
			$href = $this->env->getSiteConfig()->relativeLinkPrefix() .
				"Category:" . PHPUtils::encodeURIComponent( (string)$name );
			if ( $sortkey ) {
				$href .= "#" . PHPUtils::encodeURIComponent( $sortkey );
			}
			$link->setAttribute( "href", $href );

			$domFragment->appendChild(
				$domFragment->ownerDocument->createTextNode( "\n" )
			);
			$domFragment->appendChild( $link );
		}
	}

	/**
	 * @param Token $token
	 * @return array
	 */
	private function onExtension( Token $token ): array {
		$env = $this->env;
		$extensionName = $token->getAttribute( 'name' );
		$nativeExt = $env->getSiteConfig()->getExtTagImpl( $extensionName );
		$cachedExpansion = $env->extensionCache[$token->dataAttribs->src] ?? null;

		$options = $token->getAttribute( 'options' );
		$token->setAttribute( 'options', self::normalizeExtOptions( $options ) );

		if ( $nativeExt !== null ) {
			$extContent = Utils::extractExtBody( $token );
			$extArgs = $token->getAttribute( 'options' );
			$extApi = new ParsoidExtensionAPI( $env, [
				'wt2html' => [
					'frame' => $this->manager->getFrame(),
					'parseOpts' => $this->options,
					'extTag' => new ExtensionTag( $token ),
				],
			] );
			try {
				$domFragment = $nativeExt->sourceToDom(
					$extApi, $extContent, $extArgs
				);
				$errors = $extApi->getErrors();
			} catch ( ExtensionError $e ) {
				$domFragment = WTUtils::createLocalizationFragment(
					$env->topLevelDoc, $e->err
				);
				$errors = [ $e->err ];
				// FIXME: Should we include any errors collected
				// from $extApi->getErrors() here?
			}
			if ( $domFragment !== false ) {
				if ( $domFragment !== null ) {
					$toks = $this->onDocumentFragment(
						$nativeExt, $token, $domFragment, $errors
					);
					return( [ 'tokens' => $toks ] );
				} else {
					// The extension dropped this instance completely (!!)
					// Should be a rarity and presumably the extension
					// knows what it is doing. Ex: nested refs are dropped
					// in some scenarios.
					return [ 'tokens' => [] ];
				}
			}
			// Fall through: this extension is electing not to use
			// a custom sourceToDom method (by returning false from
			// sourceToDom).
		}

		if ( $cachedExpansion ) {
			// WARNING: THIS HAS BEEN UNUSED SINCE 2015, SEE T98995.
			// THIS CODE WAS WRITTEN BUT APPARENTLY NEVER TESTED.
			// NO WARRANTY.  MAY HALT AND CATCH ON FIRE.
			PHPUtils::unreachable( 'Should not be here!' );
			$toks = PipelineUtils::encapsulateExpansionHTML(
				$env, $token, $cachedExpansion, [ 'fromCache' => true ]
			);
		} elseif ( $env->noDataAccess() ) {
			$err = [ 'key' => 'mw-extparse-error' ];
			$domFragment = WTUtils::createLocalizationFragment(
				$env->topLevelDoc, $err
			);
			$toks = $this->onDocumentFragment(
				$nativeExt, $token, $domFragment, [ $err ]
			);
		} else {
			$pageConfig = $env->getPageConfig();
			$start = PHPUtils::getStartHRTime();
			$ret = $env->getDataAccess()->parseWikitext(
				$pageConfig, $token->getAttribute( 'source' )
			);
			if ( $env->profiling() ) {
				$profile = $env->getCurrentProfile();
				$profile->bumpMWTime( "Extension", PHPUtils::getHRTimeDifferential( $start ), "api" );
				$profile->bumpCount( "Extension" );
			}

			$domFragment = DOMUtils::parseHTMLToFragment(
				$this->env->topLevelDoc,
				// Strip a paragraph wrapper, if any, before parsing HTML to DOM
				preg_replace( '#(^<p>)|(\n</p>$)#D', '', $ret['html'] )
			);

			$this->processExtMetadata(
				$domFragment, $ret['modules'], $ret['modulestyles'], $ret['jsconfigvars'] ?? [],
				$ret['categories']
			);

			$toks = $this->onDocumentFragment(
				$nativeExt, $token, $domFragment, []
			);
		}
		return( [ 'tokens' => $toks ] );
	}

	/**
	 * DOMFragment-based encapsulation
	 *
	 * @param ?ExtensionTagHandler $nativeExt
	 * @param Token $extToken
	 * @param DOMDocumentFragment $domFragment
	 * @param array $errors
	 * @return array
	 */
	private function onDocumentFragment(
		?ExtensionTagHandler $nativeExt, Token $extToken,
		DOMDocumentFragment $domFragment, array $errors
	): array {
		$env = $this->env;
		$extensionName = $extToken->getAttribute( 'name' );

		if ( $env->hasDumpFlag( 'extoutput' ) ) {
			$logger = $env->getSiteConfig()->getLogger();
			$logger->warning( str_repeat( '=', 80 ) );
			$logger->warning(
				'EXTENSION INPUT: ' . $extToken->getAttribute( 'source' )
			);
			$logger->warning( str_repeat( '=', 80 ) );
			$logger->warning( "EXTENSION OUTPUT:\n" );
			$logger->warning(
				DOMUtils::getFragmentInnerHTML( $domFragment )
			);
			$logger->warning( str_repeat( '-', 80 ) );
		}

		$argDict = Utils::getExtArgInfo( $extToken )->dict;
		$extTagOffsets = $extToken->dataAttribs->extTagOffsets;
		if ( $extTagOffsets->closeWidth === 0 ) {
			unset( $argDict->body ); // Serialize to self-closing.
		}

		// Give native extensions a chance to manipulate the argDict
		if ( $nativeExt ) {
			$extApi = new ParsoidExtensionAPI( $env );
			$nativeExt->modifyArgDict( $extApi, $argDict );
		}

		$opts = [
			'setDSR' => true, // FIXME: This is the only place that sets this ...
			'wrapperName' => $extensionName,
		];

		// Check if the tag wants its DOM fragment not to be unpacked.
		// The default setting is to unpack the content DOM fragment automatically.
		$extConfig = $env->getSiteConfig()->getExtTagConfig( $extensionName );
		if ( isset( $extConfig['options']['wt2html'] ) ) {
			$opts += $extConfig['options']['wt2html'];
		}

		// This special case is only because, from the beginning, Parsoid has
		// treated <nowiki>s as core functionality with lean markup (no about,
		// no data-mw, custom typeof).
		//
		// We'll keep this hardcoded to avoid exposing the functionality to
		// other native extensions until it's needed.
		if ( $extensionName !== 'nowiki' ) {
			if ( !$domFragment->hasChildNodes() ) {
				// RT extensions expanding to nothing.
				$domFragment->appendChild(
					$domFragment->ownerDocument->createElement( 'link' )
				);
			}

			// Wrap the top-level nodes so that we have a firstNode element
			// to annotate with the typeof and to apply about ids.
			PipelineUtils::addSpanWrappers( $domFragment->childNodes );

			// Now get the firstNode
			$firstNode = $domFragment->firstChild;

			DOMUtils::assertElt( $firstNode );

			// Adds the wrapper attributes to the first element
			DOMUtils::addTypeOf( $firstNode, "mw:Extension/{$extensionName}" );

			// FIXME: What happens if $firstNode is template generated, since
			// they have higher precedence?  These questions and more in T214241
			Assert::invariant(
				!DOMUtils::hasTypeOf( $firstNode, 'mw:Transclusion' ),
				'First node of extension content is transcluded.'
			);

			if ( count( $errors ) > 0 ) {
				DOMUtils::addTypeOf( $firstNode, 'mw:Error' );
				$argDict->errors = $errors;
			}

			// Add about to all wrapper tokens.
			$about = $env->newAboutId();
			$n = $firstNode;
			while ( $n ) {
				$n->setAttribute( 'about', $about );
				$n = $n->nextSibling;
			}

			// Set data-mw
			// FIXME: Similar to T214241, we're clobbering $firstNode
			DOMDataUtils::setDataMw( $firstNode, $argDict );

			// Update data-parsoid
			$dp = DOMDataUtils::getDataParsoid( $firstNode );
			$dp->tsr = Utils::clone( $extToken->dataAttribs->tsr );
			$dp->src = $extToken->dataAttribs->src;
			DOMDataUtils::setDataParsoid( $firstNode, $dp );
		}

		return PipelineUtils::tunnelDOMThroughTokens(
			$env, $extToken, $domFragment, $opts
		);
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( Token $token ) {
		return $token->getName() === 'extension' ? $this->onExtension( $token ) : $token;
	}
}
