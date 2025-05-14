<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Ext\ExtensionError;
use Wikimedia\Parsoid\Ext\ExtensionTag;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataMwError;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class ExtensionHandler extends TokenHandler {

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	private static function normalizeExtOptions( array $options, string $normalizeFlag ): array {
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

			// Let extensions decide which format they want their options in; by default they are interpreted as
			// with normalized spaces and trimmed.
			if ( $normalizeFlag === 'keepspaces' ) {
				$o->v = $v;
			} elseif ( $normalizeFlag === 'trim' ) {
				$o->v = trim( $v );
			} else {
				$o->v = trim( preg_replace( '/[\r\n\t ]+/', ' ', $v ) );
			}

			// Decode character references
			$o->v = Utils::decodeWtEntities( $o->v );
		}
		return $options;
	}

	/**
	 * @return array<string|Token>
	 */
	private function onExtension( Token $token ): array {
		$env = $this->env;
		$siteConfig = $env->getSiteConfig();
		$pageConfig = $env->getPageConfig();
		$extensionName = $token->getAttributeV( 'name' );
		$extConfig = $env->getSiteConfig()->getExtTagConfig( $extensionName );

		$metrics = $siteConfig->metrics();
		if ( $metrics ) {
			// Track uses of extensions
			$wiki = $siteConfig->iwp();
			$ns = $env->getContextTitle()->getNamespace();
			if ( $ns === 0 ) {
				// Article space
				$nsName = 'main';
			} elseif ( $siteConfig->namespaceIsTalk( $ns ) ) {
				// Any talk namespace
				$nsName = 'talk';
			} else {
				// Everything else
				$nsName = "ns-$ns";
			}
			$metrics->increment( "extension.{$wiki}.{$nsName}.{$extensionName}" );
			$siteConfig->incrementCounter( "extension_total", [
				"wiki" => $wiki,
				"namespace" => $nsName,
				"name" => $extensionName,
			] );
		}

		$nativeExt = $siteConfig->getExtTagImpl( $extensionName );
		$options = $token->getAttributeV( 'options' );
		$normalizeFlag = $extConfig['options']['wt2html']['attributeWSNormalizationPref'] ?? 'normalize';
		$token->setAttribute( 'options', self::normalizeExtOptions( $options, $normalizeFlag ) );

		// Call after normalizing extension options, since that can affect the result
		$dataMw = Utils::getExtArgInfo( $token );

		if ( $nativeExt !== null ) {
			$extArgs = $token->getAttributeV( 'options' );
			$extApi = new ParsoidExtensionAPI( $env, [
				'wt2html' => [
					'frame' => $this->manager->getFrame(),
					'parseOpts' => $this->options,
					'extTag' => new ExtensionTag( $token ),
				],
			] );
			try {
				$extSrc = $dataMw->body->extsrc ?? '';
				if ( !( $extConfig['options']['hasWikitextInput'] ?? true ) ) {
					$extSrc = $this->stripAnnotations( $extSrc, $env->getSiteConfig() );
				}
				$domFragment = $nativeExt->sourceToDom(
					$extApi, $extSrc, $extArgs
				);
				$errors = $extApi->getErrors();
				if ( $extConfig['options']['wt2html']['customizesDataMw'] ?? false ) {
					$firstNode = $domFragment->firstChild;
					'@phan-var Element $firstNode'; // @var Element $firstNode
					$dataMw = DOMDataUtils::getDataMw( $firstNode );
				}
			} catch ( ExtensionError $e ) {
				$domFragment = WTUtils::createInterfaceI18nFragment(
					$env->getTopLevelDoc(), $e->err->key, $e->err->params ?: null
				);
				$errors = [ $e->err ];
				// FIXME: Should we include any errors collected
				// from $extApi->getErrors() here?  Also, what's the correct $dataMw
				// to apply in this case?
			}
			if ( $domFragment !== false ) {
				if ( $domFragment !== null ) {
					// Turn this document fragment into a token
					$toks = $this->onDocumentFragment(
						$token, $domFragment, $dataMw, $errors
					);
					return $toks;
				} else {
					// The extension dropped this instance completely (!!)
					// Should be a rarity and presumably the extension
					// knows what it is doing. Ex: nested refs are dropped
					// in some scenarios.
					return [];
				}
			}
			// Fall through: this extension is electing not to use
			// a custom sourceToDom method (by returning false from
			// sourceToDom).
		}

		$start = hrtime( true );
		$domFragment = PipelineUtils::parseToHTML( $env, $token->getAttributeV( 'source' ) );
		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			$profile->bumpMWTime( "Extension", hrtime( true ) - $start, "api" );
			$profile->bumpCount( "Extension" );
		}
		if ( !$domFragment ) {
			$domFragment = DOMUtils::parseHTMLToFragment( $env->getTopLevelDoc(), '' );
		}
		return $this->onDocumentFragment( $token, $domFragment, $dataMw, [] );
	}

	/**
	 * DOMFragment-based encapsulation
	 *
	 * @param Token $extToken
	 * @param DocumentFragment $domFragment
	 * @param DataMw $dataMw
	 * @param list<DataMwError> $errors
	 * @return array<string|Token>
	 */
	private function onDocumentFragment(
		Token $extToken, DocumentFragment $domFragment, DataMw $dataMw,
		array $errors
	): array {
		$env = $this->env;
		$extensionName = $extToken->getAttributeV( 'name' );

		if ( $env->hasDumpFlag( 'extoutput' ) ) {
			$logger = $env->getSiteConfig()->getLogger();
			$logger->warning( str_repeat( '=', 80 ) );
			$logger->warning(
				'EXTENSION INPUT: ' . $extToken->getAttributeV( 'source' )
			);
			$logger->warning( str_repeat( '=', 80 ) );
			$logger->warning( "EXTENSION OUTPUT:\n" );
			$logger->warning(
				DOMUtils::getFragmentInnerHTML( $domFragment )
			);
			$logger->warning( str_repeat( '-', 80 ) );
		}

		$opts = [
			'setDSR' => true,
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

			'@phan-var Element $firstNode'; // @var Element $firstNode

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
				$dataMw->errors = is_array( $dataMw->errors ?? null ) ?
					array_merge( $dataMw->errors, $errors ) : $errors;
			}

			// Set data-mw
			// FIXME: Similar to T214241, we're clobbering $firstNode
			DOMDataUtils::setDataMw( $firstNode, $dataMw );

			// Add about to all wrapper tokens.
			$about = $env->newAboutId();
			$n = $firstNode;
			while ( $n ) {
				$n->setAttribute( 'about', $about );
				$n = $n->nextSibling;
			}

			// Update data-parsoid
			$dp = DOMDataUtils::getDataParsoid( $firstNode );
			$dp->tsr = clone $extToken->dataParsoid->tsr;
			$dp->src = $extToken->dataParsoid->src;
			DOMDataUtils::setDataParsoid( $firstNode, $dp );
		}

		return PipelineUtils::tunnelDOMThroughTokens(
			$env, $extToken, $domFragment, $opts
		);
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return $token->getName() === 'extension' ? $this->onExtension( $token ) : null;
	}

	private function stripAnnotations( string $s, SiteConfig $siteConfig ): string {
		$annotationStrippers = $siteConfig->getAnnotationStrippers();

		$res = $s;
		foreach ( $annotationStrippers as $annotationStripper ) {
			$res = $annotationStripper->stripAnnotations( $s );
		}
		return $res;
	}
}
