<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\Promise as Promise;
use Parsoid\ContentUtils as ContentUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\SelectiveSerializer as SelectiveSerializer;
use Parsoid\TemplateRequest as TemplateRequest;
use Parsoid\WikitextSerializer as WikitextSerializer;

class FromHTML {
	/**
	 * Fetch prior DOM for selser.  This is factored out of
	 * {@link serializeDOM} so that it can be reused by alternative
	 * content handlers which support selser.
	 *
	 * @param {Object} env The environment.
	 * @param {boolean} useSelser Use the selective serializer, or not.
	 * @return Promise A promise that is resolved after selser information
	 *   has been loaded.
	 */
	public static function fetchSelser( $env, $useSelser ) {
		$hasOldId = (bool)$env->page->meta->revision->revid;
		$needsContent = $useSelser && $hasOldId && ( $env->page->src === null );
		$needsOldDOM = $useSelser && !( $env->page->dom || $env->page->domdiff );

		$p = Promise::resolve();
		if ( $needsContent ) {
			$p = $p->then( function () use ( &$env, &$TemplateRequest ) {
					$target = $env->normalizeAndResolvePageTitle();
					return TemplateRequest::setPageSrcInfo( $env, $target, $env->page->meta->revision->revid )->
					catch( function ( $err ) use ( &$env ) {
							$env->log( 'error', 'Error while fetching page source.', $err );
					}
					);
			}
			);
		}
		if ( $needsOldDOM ) {
			$p = $p->then( function () use ( &$env, &$ContentUtils ) {
					if ( $env->page->src === null ) {
						// The src fetch failed or we never had an oldid.
						// We'll just fallback to non-selser.
						return;
					}
					return $env->getContentHandler()->toHTML( $env )->
					then( function ( $doc ) use ( &$env, &$ContentUtils ) {
							$env->page->dom = $env->createDocument( ContentUtils::toXML( $doc ) )->body;
					}
					)->
					catch( function ( $err ) use ( &$env ) {
							$env->log( 'error', 'Error while parsing original DOM.', $err );
					}
					);
			}
			);
		}

		return $p;
	}

	/**
	 * The main serializer from DOM to *wikitext*.
	 *
	 * If you could be handling non-wikitext content, use
	 * `env.getContentHandler().fromHTML(env, body, useSelser)` instead.
	 * See {@link MWParserEnvironment#getContentHandler}.
	 *
	 * @param {Object} env The environment.
	 * @param {Node} body The document body to serialize.
	 * @param {boolean} useSelser Use the selective serializer, or not.
	 * @param {Function} cb Optional callback.
	 */
	public static function serializeDOM( $env, $body, $useSelser, $cb ) {
		Assert::invariant( DOMUtils::isBody( $body ), 'Expected a body node.' );

		// Preprocess the DOM, if required.
		//
		// Usually, only extensions that have page-level state might
		// provide these processors to provide subtree-editing support
		// and server-side management of this page-level state.
		//
		// NOTE: This means that our extension API exports information
		// to extensions that there is such a thing as subtree editing
		// and other related info. This needs to be in our extension API docs.
		$preprocessDOM = function () use ( &$env, &$body ) {
			$env->conf->wiki->extConfig->domProcessors->forEach( function ( $extProcs ) use ( &$env, &$body ) {
					if ( $extProcs->procs->html2wtPreProcessor ) {
						// This updates the DOM in-place
						$extProcs->procs->html2wtPreProcessor( $env, $body );
					}
			}
			);
		};

		return $this->fetchSelser( $env, $useSelser )->then( function () use ( &$useSelser, &$SelectiveSerializer, &$WikitextSerializer, &$env, &$DOMDataUtils, &$body, &$preprocessDOM ) {
				$Serializer = ( $useSelser ) ? SelectiveSerializer::class : WikitextSerializer::class;
				$serializer = new Serializer( [ 'env' => $env ] );
				// TODO(arlolra): There's probably an opportunity to refactor callers
				// of `serializeDOM` to use `ContentUtils.ppToDOM` but this is a safe bet
				// for now, since it's the main entrypoint to serialization.
				DOMDataUtils::visitAndLoadDataAttribs( $body, [ 'markNew' => true ] );
				if ( $useSelser && $env->page->dom ) {
					DOMDataUtils::visitAndLoadDataAttribs( $env->page->dom, [ 'markNew' => true ] );
				}

				// NOTE:
				// 1. The edited DOM (represented by body) might not be in canonical
				// form because Parsoid might be providing server-side management
				// of global state for extensions (ex: Cite). To address this and
				// bring the DOM back to canonical form, we run extension-provided
				// handlers. The original dom (env.page.dom) isn't subject to this
				// problem.
				// 2. We need to do this after all data attributes have been loaded above.
				// 3. We need to do this before we run dom-diffs to eliminate spurious
				// diffs.
				$preprocessDOM();

				$env->page->editedDoc = $body->ownerDocument;
				return $serializer->serializeDOM( $body );
		}
		)->nodify( $cb );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->FromHTML = $FromHTML;
}
