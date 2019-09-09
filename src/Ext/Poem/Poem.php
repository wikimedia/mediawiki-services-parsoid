<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Poem;

use DOMDocument;
use DOMElement;
use Parsoid\Config\Env;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use Parsoid\Config\ParsoidExtensionAPI;

class Poem extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $content, array $args ): DOMDocument {
		if ( strlen( $content ) > 0 ) {
			$content = preg_replace(
				'/^ /m', '&nbsp;', preg_replace(
					'/\n$/D', '', preg_replace(
					'/^\n/', '', $content,
					// Strip leading/trailing newline
					1
				), 1
				)
			// Suppress indent-pre by replacing leading space with &nbsp;
			);

			// Add <br/> for newlines except (a) in nowikis (b) after ----
			// nowiki newlines will be processed on the DOM.
			$splitContent = preg_split( '/(<nowiki>[\s\S]*?<\/nowiki>)/', $content,
				-1, PREG_SPLIT_DELIM_CAPTURE );
			$content = implode( '',
				array_map( function ( $p, $i ) {
					if ( $i % 2 === 1 ) {
						return $p;
					}

					// This is a hack that exploits the fact that </poem>
					// cannot show up in the extension's content.
					return preg_replace( '/^(-+)<\/poem>/m', "\$1\n",
						preg_replace( '/\n/m', "<br/>\n",
						preg_replace( '/(^----+)\n/m', '$1</poem>', $p ) ) );
				}, $splitContent,
				range( 0, count( $splitContent ) - 1 ) )
			);

			// Replace colons with indented spans
			$contentArray = explode( '\n', $content );
			$contentMap = array_map( function ( $line ) use ( $extApi ) {
				$i = 0;
				$lineLength = strlen( $line );
				while ( $line[ $i ] === ':' && $i < $lineLength ) {
					$i++;
				}
				if ( $i > 0 && $i < $lineLength ) {
					$doc = $extApi->getEnv()->createDocument();
					$span = $doc->createElement( 'span' );
					$span->setAttribute( 'class', 'mw-poem-indented' );
					$span->setAttribute( 'style', 'display: inline-block; margin-left: ' . $i . 'em;' );
					$span->appendChild( $doc->createTextNode( ltrim( $line, ':' ) ) );
					return DOMCompat::getOuterHTML( $span );
				} else {
					return $line;
				}
			}, $contentArray );
			$content = implode( '\n', $contentMap ); // use faster? preg_replace
		}

		return $extApi->parseTokenContentsToDOM( $args, '', $content, [
				'wrapperTag' => 'div',
				'pipelineOpts' => [
					'extTag' => 'poem',
				],
			]
		);
	}

	/**
	 * @param DOMElement $node
	 */
	private function processNowikis( DOMElement $node ): void {
		$doc = $node->ownerDocument;
		$c = $node->firstChild;
		while ( $c ) {
			if ( !$c instanceof DOMElement ) {
				$c = $c->nextSibling;
				continue;
			}

			if ( !preg_match( '/\bmw:Nowiki\b/', $c->getAttribute( 'typeof' ) ?? '' ) ) {
				self::processNowikis( $c );
				$c = $c->nextSibling;
				continue;
			}

			// Replace nowiki's text node with a combination
			// of content and <br/>s. Take care to deal with
			// entities that are still entity-wrapped (!!).
			$cc = $c->firstChild;
			while ( $cc ) {
				$next = $cc->nextSibling;
				if ( DOMUtils::isText( $cc ) ) {
					$pieces = preg_split( '/\n/', $cc->nodeValue );
					$n = count( $pieces );
					$nl = '';
					for ( $i = 0;  $i < $n;  $i++ ) {
						$p = $pieces[ $i ];
						$c->insertBefore( $doc->createTextNode( $nl . $p ), $cc );
						if ( $i < $n - 1 ) {
							$c->insertBefore( $doc->createElement( 'br' ), $cc );
							$nl = "\n";
						}
					}
					$c->removeChild( $cc );
				}
				$cc = $next;
			}
			$c = $c->nextSibling;
		}
	}

	private function doPostProcessDOM(
		DOMElement $node, Env $env, array $options, bool $atTopLevel
	): void {
		if ( !$atTopLevel ) {
			return;
		}

		$c = $node->firstChild;
		while ( $c ) {
			if ( $c instanceof DOMElement ) {
				if ( preg_match( '#\bmw:Extension/poem\b#', $c->getAttribute( 'typeof' ) ?? '' ) ) {
					// In nowikis, replace newlines with <br/>.
					// Cannot do it before parsing because <br/> will get escaped!
					self::processNowikis( $c );
				} else {
					$this->doPostProcessDOM( $c, $env, $options, $atTopLevel );
				}
			}
			$c = $c->nextSibling;
		}
	}

	/**
	 * All DOM PostProcessors are expected to implement the run method.
	 * Eventually, we will probably have an interface with a better name for this
	 * entry method. But, for now, run() method it is.
	 *
	 * @param DOMElement $root
	 * @param Env $env
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run( DOMElement $root, Env $env, array $options, bool $atTopLevel ): void {
		$this->doPostProcessDOM( $root, $env, $options, $atTopLevel );
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'poem',
			'domProcessors' => [
				'wt2htmlPostProcessor' => self::class
			],
			'tags' => [
				[
					'name' => 'poem',
					'class' => self::class
				]
			]
		];
	}

}
