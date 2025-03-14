<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

use Error;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Ext\ExtensionModule;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * See tests/parser/ParserTestParserHook.php in core.
 */
class ParserHook extends ExtensionTagHandler implements ExtensionModule {

	/** @inheritDoc */
	public function sourceToDom(
		ParsoidExtensionAPI $extApi, string $content, array $args
	): DocumentFragment {
		$extName = $extApi->extTag->getName();
		if ( $extApi->extTag->isSelfClosed() ) {
			$content = null;
		}
		switch ( $extName ) {
			case 'tag':
			case 'tåg':
				return $extApi->htmlToDom(
					"<pre>\n" .
						var_export( $content, true ) . "\n" .
						var_export( $extApi->extArgsToArray( $args ), true ) . "\n" .
					"</pre>"
				);

			case 'statictag':
				// FIXME: Choose a better DOM representation that doesn't mess with
				// newline constraints.
				return $extApi->htmlToDom( '<span />' );

			case 'asidetag':
				// T278565
				return $extApi->htmlToDom( '<aside>Some aside content</aside>' );

			case 'pwraptest':
				return $extApi->htmlToDom( '<!--CMT--><style>p{}</style>' );

			case 'divtag':
			case 'spantag':
				// "Transparent" tag which wraps wikitext in a <span> or <div>;
				// useful in testing various parsoid wrapping scenarios
				// (we used to use <ref> for this)
				//
				// NOTE: When using <spantag>, p-wrapping and indent-pre
				// transforms are disabled.
				$argArray = $extApi->extArgsToArray( $args );
				$isDiv = ( $extName === 'divtag' );
				$isRaw = $argArray['raw'] ?? false;
				$tag = $isDiv ? 'div' : 'span';
				if ( $isRaw ) {
					return $extApi->htmlToDom( "<$tag>$content</$tag>" );
				}
				return $extApi->extTagToDOM( $args, $content, [
					'wrapperTag' => $tag,
					'parseOpts' => [
						'extTag' => $extName,
						'context' => $isDiv ? 'block' : 'inline',
					],
				] );

			case 'embedtag':
				$dataMw = $extApi->extTag->getDefaultDataMw();
				$domFragment = $extApi->extTagToDOM( $args, $content, [
					'parseOpts' => [
						'extTag' => $extName,
						'context' => 'inline',
					],
				] );
				$dataMw->body = (object)[
					'html' => $extApi->domToHtml( $domFragment, true )
				];
				$span = $domFragment->ownerDocument->createElement( 'span' );
				DOMDataUtils::setDataMw( $span, $dataMw );
				DOMCompat::replaceChildren( $domFragment, $span );
				return $domFragment;

			case 'sealtag':
				return $extApi->htmlToDom( '<span />' );

			default:
				throw new Error( "Unexpected tag name: $extName in ParserHook" );
		}
	}

	/** @inheritDoc */
	public function processAttributeEmbeddedDom(
		ParsoidExtensionAPI $extApi, Element $elt, callable $proc
	): void {
		$dataMw = DOMDataUtils::getDataMw( $elt );
		if ( isset( $dataMw->body->html ) ) {
			$dom = $extApi->htmlToDom( $dataMw->body->html );
			$ret = $proc( $dom );
			if ( $ret ) {
				$dataMw->body->html = $extApi->domToHtml( $dom, true, true );
			}
		}
	}

	/** @inheritDoc */
	public function domToWikitext(
		ParsoidExtensionAPI $extApi, Element $node, bool $wrapperUnmodified
	) {
		$dataMw = DOMDataUtils::getDataMw( $node );
		$extName = WTUtils::getExtTagName( $node ) ?? $dataMw->name;
		if ( !in_array( $extName, [ 'spantag', 'divtag', 'embedtag' ], true ) ) {
			return false; // use default serialization
		}
		if ( in_array( $extName, [ 'spantag', 'divtag' ], true ) ) {
			if ( $dataMw->attrs->raw ?? false ) {
				return false; // use default serialization in 'raw' mode
			}
		}
		$html2wtOpts = [
			'extName' => $extName,
			// FIXME: One-off PHP parser state leak. This needs a better solution.
			'inPHPBlock' => true
		];
		$src = '';
		if ( $wrapperUnmodified && isset( $dataMw->body->extsrc ) ) {
			$src = $dataMw->body->extsrc;
		} elseif ( $extName === 'embedtag' ) {
			// First look for the extension's content in data-mw.body.html
			$src = $extApi->htmlToWikitext( $html2wtOpts, $dataMw->body->html );
		} else {
			$src = $extApi->htmlToWikitext( $html2wtOpts, DOMCompat::getInnerHTML( $node ) );
		}
		return "<$extName>" . $src . "</$extName>";
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'ParserHook',
			'tags' => [
				[ 'name' => 'tag', 'handler' => self::class ],
				[ 'name' => 'tåg', 'handler' => self::class ],
				[ 'name' => 'statictag', 'handler' => self::class ],
				[ 'name' => 'asidetag', 'handler' => self::class ],
				[ 'name' => 'pwraptest', 'handler' => self::class ],
				[
					'name' => 'divtag',
					'handler' => self::class,
					'options' => [
						'outputHasCoreMwDomSpecMarkup' => true,
					],
				],
				[
					'name' => 'spantag',
					'handler' => self::class,
					'options' => [
						'outputHasCoreMwDomSpecMarkup' => true,
					],
				],
				[
					'name' => 'embedtag',
					'handler' => self::class,
					'options' => [
						'wt2html' => [
							'embedsDomInAttributes' => true,
							'customizesDataMw' => true,
						],
						'outputHasCoreMwDomSpecMarkup' => true,
					],
				],
				[
					'name' => 'sealtag',
					'handler' => self::class,
					'options' => [
						'wt2html' => [
							'unpackOutput' => false,
						],
					],
				],
			],
			'domProcessors' => [
				ParserHookProcessor::class
			]
		];
	}
}
