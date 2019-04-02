<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\Promise as Promise;

use Parsoid\Batcher as Batcher;

class AddRedLinks {
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
				// Magic links, at least, don't have titles
				if ( $a->hasAttribute( 'title' ) ) { $s->add( $a->getAttribute( 'title' ) );  }
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
	}

	public function run( $rootNode, $env, $options ) {
		return AddRedLinks::addRedLinks( $env, $rootNode->ownerDocument );
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
AddRedLinks::addRedLinks = /* async */AddRedLinks::addRedLinksG;

$module->exports->AddRedLinks = $AddRedLinks;
