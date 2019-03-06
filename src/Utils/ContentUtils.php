<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use DOMDocument;
use DOMNode;
use DOMElement;

use Parsoid\Config\Env;
use Parsoid\Wt2Html\XMLSerializer;

/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 */
class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param DOMNode $node
	 * @param array $options XMLSerializer options.
	 * @return string
	 */
	public static function toXML( DOMNode $node, array $options = [] ): string {
		return XMLSerializer::serialize( $node, $options )['html'];
	}

	/**
	 * dataobject aware XML serializer, to be used in the DOM post-processing phase.
	 *
	 * @param DOMNode $node
	 * @param array $options
	 * @return string
	 */
	public static function ppToXML( DOMNode $node, array $options = [] ): string {
		// We really only want to pass along `$options['keepTmp']`
		DOMDataUtils::visitAndStoreDataAttribs( $node, $options );
		return self::toXML( $node, $options );
	}

	/**
	 * .dataobject aware HTML parser, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param Env $env
	 * @param string $html
	 * @param array $options
	 * @return DOMNode
	 */
	public static function ppToDOM( Env $env, string $html, array $options = [] ): DOMNode {
		$options = $options ?? [];
		$node = $options['node'];
		if ( $node === null ) {
			$node = $env->createDocument( $html )->body;
		} else {
			// PORT-FIXME: Needs updating after DOMCompat patch lands
			$node->innerHTML = $html;
		}
		DOMDataUtils::visitAndLoadDataAttribs( $node, $options['markNew'] );
		return $node;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param DOMNode $node
	 * @param array $options XMLSerializer options.
	 * @return array
	 */
	public static function extractDpAndSerialize( DOMNode $node, array $options = [] ): array {
		$options = $options ?? [];
		$options['captureOffsets'] = true;

		$doc = DOMUtils::isBody( $node ) ? $node->ownerDocument : $node;
		$pb = DOMDataUtils::extractPageBundle( $doc );
		$out = XMLSerializer::serialize( $node, $options );

		// Add the wt offsets.
		foreach ( $out['offsets'] as $key => &$value ) {
			$dp = $pb->parsoid->ids[ $key ];
			if ( Util::isValidDSR( $dp->dsr ) ) {
				$value['wt'] = array_slice( $dp->dsr, 0, 2 );
			}
		}

		$pb->parsoid->sectionOffsets = &$out['offsets'];
		$out['pb'] = $pb;
		unset( $out['offsets'] );

		return $out;
	}

	/**
	 * Strip Parsoid-inserted section wrappers and fallback id spans with
	 * HTML4 ids for headings from the DOM.
	 *
	 * @param DOMElement $node
	 */
	public static function stripSectionTagsAndFallbackIds( DOMElement $node ): void {
		$n = $node->firstChild;
		while ( $n ) {
			$next = $n->nextSibling;
			if ( DOMUtils::isElt( $n ) ) {
				// Recurse into subtree before stripping this
				self::stripSectionTagsAndFallbackIds( $n );

				// Strip <section> tags
				if ( WTUtils::isParsoidSectionTag( $n ) ) {
					DOMUtils::migrateChildren( $n, $n->parentNode, $n );
					$n->parentNode->removeChild( $n );
				}

				// Strip <span typeof='mw:FallbackId' ...></span>
				if ( WTUtils::isFallbackIdSpan( $n ) ) {
					$n->parentNode->removeChild( $n );
				}
			}
			$n = $next;
		}
	}

	private static function cloneData( DOMNode $node, DOMNode $clone, array $options ): void {
		if ( !DOMUtils::isElt( $node ) ) {
			return;
		}

		$d = DOMDataUtils::getNodeData( $node );
		DOMDataUtils::setNodeData( $clone,  clone $d );
		if ( !empty( $options['storeDiffMark'] ) ) {
			DiffUtils::storeDiffMark( $clone, $options['env'] );
		}
		$node = $node->firstChild;
		$clone = $clone->firstChild;
		while ( $node ) {
			self::cloneData( $node, $clone, $options );
			$node = $node->nextSibling;
			$clone = $clone->nextSibling;
		}
	}

	private static function emit( array $buf, array &$opts ): void {
		$str = implode( "\n", $buf );
		if ( isset( $opts['outBuffer'] ) ) {
			$opts['outBuffer'] .= $str;
		} elseif ( isset( $opts['outStream'] ) ) {
			$opts['outStream']->write( $str . "\n" );
		} else {
			print $str;
		}
	}

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param DOMElement $rootNode
	 * @param string $title
	 * @param array &$options
	 */
	public static function dumpDOM(
		DOMElement $rootNode, string $title, array &$options = []
	): void {
		$options = $options ?? [];
		if ( !empty( $options['storeDiffMark'] ) || !empty( $options['dumpFragmentMap'] ) ) {
			Assert::invariant( isset( $options['env'] ) );
		}

		// cloneNode doesn't clone data => walk DOM to clone it
		$clonedRoot = $rootNode->cloneNode( true );
		self::cloneData( $rootNode, $clonedRoot, $options );

		$buf = [];
		if ( empty( $options['quiet'] ) ) {
			$buf[] = '----- ' . $title . ' -----';
		}

		$buf[] = self::ppToXML( $clonedRoot, $options );
		self::emit( $buf, $options );

		// Dump cached fragments
		if ( !empty( $options['dumpFragmentMap'] ) ) {
			foreach ( $options['env']->getFragmentMap() as $k => $fragment ) {
				$buf = [];
				$buf[] = str_repeat( '=', 15 );
				$buf[] = 'FRAGMENT ' . $k;
				$buf[] = '';
				self::emit( $buf, $options );

				$newOpts = $options;
				$newOpts['dumpFragmentMap'] = false;
				$newOpts['quiet'] = true;
				self::dumpDOM( is_array( $fragment ) ? $fragment[ 0 ] : $fragment, '', $newOpts );
			}
		}

		if ( empty( $options['quiet'] ) ) {
			self::emit( [ str_repeat( '-', count( $title ) + 12 ) ], $options );
		}
	}

	/**
	 * PORT-FIXME: NOT YET PORTED
	 *
	 * Add red links to a document.
	 *
	 * @param object $env
	 * @param DOMDocument $doc
	 */
	public static function addRedLinks( $env, $doc ) {
		throw new \BadMethodCallException( 'NOT YET PORTED' );

		/* -----------------------------------------------------------------------
		$processPage = function ( $page ) use ( &$undefined ) {
			return [
				'missing' => $page->missing !== null,
				'known' => $page->known !== null,
				'redirect' => $page->redirect !== null,
				'disambiguation' => $page->pageprops
&&					$page->pageprops->disambiguation !== null
			];
		};

		$wikiLinks = Array::from( $doc->body->querySelectorAll( 'a[rel~="mw:WikiLink"]' ) );

		$titleSet = array_reduce( $wikiLinks, function ( $s, $a ) {
				// Magic links, at least, don't have titles
				if ( $a->hasAttribute( 'title' ) ) { $s->add( $a->getAttribute( 'title' ) );  }
				return $s;
			}, new Set()
		);

		$titles = Array::from( $titleSet->values() );
		if ( count( $titles ) === 0 ) { return;  }

		$titleMap = new Map();
		(  Batcher::getPageProps( $env, $titles ) )->forEach( function ( $r )
			use ( &$titleMap, &$processPage ) {
				Object::keys( $r->batchResponse )->forEach( function ( $t )
					use ( &$r, &$titleMap, &$processPage) {
						$o = $r->batchResponse[ $t ];
						$titleMap->set( $o->title, $processPage( $o ) );
					}
				);
			}
		);
		$wikiLinks->forEach( function ( $a ) use ( &$titleMap, &$undefined, &$env ) {
				if ( !$a->hasAttribute( 'title' ) ) { return;  }
				$k = $a->getAttribute( 'title' );
				$data = $titleMap->get( $k );
				if ( $data === null ) {
					$err = true;
					// Unfortunately, normalization depends on db state for user
					// namespace aliases, depending on gender choices.  Workaround
					// it by trying them all.
					$title = $env->makeTitleFromURLDecodedStr( $k, null, true );
					if ( $title !== null ) {
						$ns = $title->getNamespace();
						if ( $ns->isUser() || $ns->isUserTalk() ) {
							$key = ':' . preg_replace( '/_/', ' ', $title->_key );
							$err = !( $env->conf->wiki->siteInfo->namespacealiases || [] )->
							some( function ( $a ) use ( &$a, &$ns, &$titleMap, &$key ) {
									if ( $a->id === $ns->_id && $titleMap->has( $a[ '*' ] + $key ) ) {
										$data = $titleMap->get( $a[ '*' ] + $key );
										return true;
									}
									return false;
								}
							);
						}
					}
					if ( $err ) {
						$env->log( 'warn', 'We should have data for the title: ' . $k );
						return;
					}
				}
				$a->removeAttribute( 'class' ); // Clear all
				if ( $data->missing && !$data->known ) {
					$a->classList->add( 'new' );
				}
				if ( $data->redirect ) {
					$a->classList->add( 'mw-redirect' );
				}
				// Jforrester suggests that, "ideally this'd be a registry so that
				// extensions could, er, extend this functionality – this is an
				// API response/CSS class that is provided by the Disambigutation
				// extension."
				if ( $data->disambiguation ) {
					$a->classList->add( 'mw-disambig' );
				}
			}
		);
		----------------------------------------------------------------------- */
	}
}
