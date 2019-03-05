<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 *
 * @module
 */

namespace Parsoid;



use Parsoid\Promise as Promise;
use Parsoid\XMLSerializer as XMLSerializer;
use Parsoid\Batcher as Batcher;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;

class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	public static function toXML( $node, $options ) {
		return XMLSerializer::serialize( $node, $options )->html;
	}

	/**
	 * .dataobject aware XML serializer, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {Node} node
	 * @param {Object} [options]
	 * @return {string}
	 */
	public static function ppToXML( $node, $options ) {
		// We really only want to pass along `options.keepTmp`
		DOMDataUtils::visitAndStoreDataAttribs( $node, $options );
		return $this->toXML( $node, $options );
	}

	/**
	 * .dataobject aware HTML parser, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} html
	 * @param {Object} [options]
	 * @return {Node}
	 */
	public static function ppToDOM( $env, $html, $options ) {
		$options = $options || [];
		$node = $options->node;
		if ( $node === null ) {
			$node = $env->createDocument( $html )->body;
		} else {
			$node->innerHTML = $html;
		}
		DOMDataUtils::visitAndLoadDataAttribs( $node, $options->markNew );
		return $node;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	public static function extractDpAndSerialize( $node, $options ) {
		if ( !$options ) { $options = [];  }
		$options->captureOffsets = true;
		$pb = DOMDataUtils::extractPageBundle( ( DOMUtils::isBody( $node ) ) ? $node->ownerDocument : $node );
		$out = XMLSerializer::serialize( $node, $options );
		// Add the wt offsets.
		Object::keys( $out->offsets )->forEach( function ( $key ) use ( &$pb, &$Util, &$out ) {
				$dp = $pb->parsoid->ids[ $key ];
				Assert::invariant( $dp );
				if ( Util::isValidDSR( $dp->dsr ) ) {
					$out->offsets[ $key ]->wt = array_slice( $dp->dsr, 0, 2/*CHECK THIS*/ );
				}
			}
		);
		$pb->parsoid->sectionOffsets = $out->offsets;
		Object::assign( $out, [ 'pb' => $pb, 'offsets' => null ] );
		return $out;
	}

	public static function stripSectionTagsAndFallbackIds( $node ) {
		$n = $node->firstChild;
		while ( $n ) {
			$next = $n->nextSibling;
			if ( DOMUtils::isElt( $n ) ) {
				// Recurse into subtree before stripping this
				$this->stripSectionTagsAndFallbackIds( $n );

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

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param {Node} rootNode
	 * @param {string} title
	 * @param {Object} [options]
	 */
	public static function dumpDOM( $rootNode, $title, $options ) {
		$DiffUtils = null;
		$options = $options || [];
		if ( $options->storeDiffMark || $options->dumpFragmentMap ) { Assert::invariant( $options->env );  }

		function cloneData( $node, $clone ) use ( &$DOMUtils, &$DOMDataUtils, &$Util, &$options, &$DiffUtils ) {
			if ( !DOMUtils::isElt( $node ) ) { return;  }
			$d = DOMDataUtils::getNodeData( $node );
			DOMDataUtils::setNodeData( $clone, Util::clone( $d ) );
			if ( $options->storeDiffMark ) {
				if ( !$DiffUtils ) {
					$DiffUtils = require( '../html2wt/DiffUtils.js' )::DiffUtils;
				}
				DiffUtils::storeDiffMark( $clone, $options->env );
			}
			$node = $node->firstChild;
			$clone = $clone->firstChild;
			while ( $node ) {
				cloneData( $node, $clone );
				$node = $node->nextSibling;
				$clone = $clone->nextSibling;
			}
		}

		function emit( $buf, $opts ) {
			if ( isset( $opts[ 'outBuffer' ] ) ) {
				$opts->outBuffer += implode( "\n", $buf );
			} elseif ( $opts->outStream ) {
				$opts->outStream->write( implode( "\n", $buf ) . "\n" );
			} else {
				$console->warn( implode( "\n", $buf ) );
			}
		}

		// cloneNode doesn't clone data => walk DOM to clone it
		$clonedRoot = $rootNode->cloneNode( true );
		cloneData( $rootNode, $clonedRoot );

		$buf = [];
		if ( !$options->quiet ) {
			$buf[] = '----- ' . $title . ' -----';
		}

		$buf[] = ContentUtils::ppToXML( $clonedRoot, $options );
		emit( $buf, $options );

		// Dump cached fragments
		if ( $options->dumpFragmentMap ) {
			Array::from( $options->env->fragmentMap->keys() )->forEach( function ( $k ) use ( &$options ) {
					$buf = [];
					$buf[] = '='->repeat( 15 );
					$buf[] = 'FRAGMENT ' . $k;
					$buf[] = '';
					emit( $buf, $options );

					$newOpts = Object::assign( [], $options, [ 'dumpFragmentMap' => false, 'quiet' => true ] );
					$fragment = $options->env->fragmentMap->get( $k );
					ContentUtils::dumpDOM( ( is_array( $fragment ) ) ? $fragment[ 0 ] : $fragment, '', $newOpts );
				}
			);
		}

		if ( !$options->quiet ) {
			emit( [ '-'->repeat( count( $title ) + 12 ) ], $options );
		}
	}

	/**
	 * Add red links to a document.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Document} doc
	 */
	public static function addRedLinksG( $env, $doc ) {
		/** @private */
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
				$title = $a->getAttribute( 'title' );
				// Magic links, at least, don't have titles
				// Magic links, at least, don't have titles
				if ( $title !== null ) { $s->add( $title );  }
				return $s;
			}, new Set()
		)




		;

		$titles = Array::from( $titleSet->values() );
		if ( count( $titles ) === 0 ) { return;  }

		$titleMap = new Map();
		( /* await */ Batcher::getPageProps( $env, $titles ) )->forEach( function ( $r ) use ( &$titleMap, &$processPage ) {
				Object::keys( $r->batchResponse )->forEach( function ( $t ) use ( &$r, &$titleMap, &$processPage ) {
						$o = $r->batchResponse[ $t ];
						$titleMap->set( $o->title, $processPage( $o ) );
					}
				);
			}
		);
		$wikiLinks->forEach( function ( $a ) use ( &$titleMap, &$undefined, &$env ) {
				$k = $a->getAttribute( 'title' );
				if ( $k === null ) { return;  }
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
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
ContentUtils::addRedLinks = /* async */ContentUtils::addRedLinksG;

if ( gettype( $module ) === 'object' ) {
	$module->exports->ContentUtils = $ContentUtils;
}
