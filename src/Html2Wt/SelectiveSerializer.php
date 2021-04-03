<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Composer\Semver\Semver;
use DOMComment;
use DOMDocument;
use DOMElement;
use DOMText;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\WikitextConstants;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\SelserData;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Timing;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * This is a Serializer class that will compare two versions of a DOM
 * and re-use the original wikitext for unmodified regions of the DOM.
 * Originally this relied on special change markers inserted by the
 * editor, but we now generate these ourselves using DOMDiff.
 */
class SelectiveSerializer {

	/** @var Env */
	private $env;

	private $wts;
	private $trace;
	private $metrics;

	/** @var SelserData */
	private $selserData;

	/**
	 * SelectiveSerializer constructor.
	 * @param array $options
	 */
	public function __construct( $options ) {
		$this->env = $options['env'];
		$this->wts = new WikitextSerializer( $options );
		$this->selserData = $options['selserData'];

		// Debug options
		$this->trace = $this->env->hasTraceFlag( 'selser' );

		// Performance Timing option
		$this->metrics = $this->env->getSiteConfig()->metrics();
	}

	/**
	 * Wrap text node children of nodes with name $nodeName in <span> tags and
	 * compute the DSR values for those span tags.
	 *
	 * This helps DOMDiff mark up diffs of content in these nodes at a more fine-grained level.
	 *
	 * These DSR values rely on availability of information about trimmed leading
	 * and trailing WS in these nodes in the wt->html direction. Given this info,
	 * on the original unedited DOM, the computed DSR values for span tags wrapping
	 * text nodes will be accurate.
	 *
	 * However, for the edited DOM with modified nodes, the computation is necessarily
	 * speculative and as such, the computed DSR values may be bogus. Given this,
	 * we rely on DOMDiff to diff the data-parsoid attribute and mark these nodes as
	 * modified because of the mismatched dsr values. If so, these span tags will never
	 * have selser reuse apply to them and the speculatively computed DSR values will
	 * be discarded.
	 *
	 * @param DOMElement $body
	 * @param string $nodeName
	 */
	private function wrapTextChildrenOfNode( DOMElement $body, string $nodeName ): void {
		// Note that while it might seem that only the first and last child need to be
		// wrapped, when nested list items are added, the previously last child of
		// a list item become an intermediate child in the new DOM. Without the span
		// wrapper, trailing trimmed whitespace gets dropped.
		$inListItem = isset( WikitextConstants::$HTML['ListItemTags'][$nodeName] );
		foreach ( DOMCompat::querySelectorAll( $body, $nodeName ) as $elt ) {
			if ( WTUtils::isLiteralHTMLNode( $elt ) ) {
				continue;
			}

			// Skip items with about id => part of templates / extensions like Cite
			// CAVEAT: In some cases, this might be bailing out a little too early.
			// For example, where certain extensions might actually support nested DSR
			// values inside and where <li> items in them might benefit. But, given that
			// so far, such extensions are more the exception than the norm, we will take
			// the easy way out here and revisit this if dirty diffs for those <li> items
			// merit further action in the future.
			if ( $elt->hasAttribute( 'about' ) ) {
				continue;
			}

			// No point wrapping text nodes if there is no usable DSR
			$eltDSR = DOMDataUtils::getDataParsoid( $elt )->dsr ?? null;
			if ( !Utils::isValidDSR( $eltDSR ) ) {
				continue;
			}

			$doc = $body->ownerDocument;
			$firstChild = $c = $elt->firstChild;
			$start = $eltDSR->innerStart();
			while ( $c ) {
				if ( $eltDSR && $c === $firstChild ) {
					if ( $eltDSR->leadingWS < 0 ) {
						// We don't have accurate information about the length of trimmed WS.
						// So, we cannot wrap this text node with a <span>.
						break;
					} else {
						$start += $eltDSR->leadingWS;
					}
				}
				$next = $c->nextSibling;
				if ( $c instanceof DOMText ) {
					$text = $c->nodeValue;
					$len = strlen( $text );
					if ( $len > 0 && $text[$len - 1] === "\n" ) {
						$nl = "\n";
						$text = rtrim( $text, "\n" );
						$len--;
					} else {
						$nl = null;
					}

					// Detect last child of "original" item and tack on trailingWS width
					// to the contents of this text node. If this is a list item and
					// we added a nested list, that nested list will be the last item.
					if ( $eltDSR && (
						!$next || (
							$inListItem && DOMUtils::isList( $next ) && WTUtils::isNewElt( $next )
						)
					) ) {
						$len += $eltDSR->trailingWS;
					}

					$span = $doc->createElement( 'span' );
					$span->setAttribute( 'data-mw-selser-wrapper', '' );
					$dp = DOMDataUtils::getDataParsoid( $span );
					$dp->dsr = new DomSourceRange( $start, $start + $len, 0, 0 );
					$start += $len;

					if ( $nl ) {
						$elt->insertBefore( $span, $c );
						$span->appendChild( $doc->createTextNode( $text ) );
						$c->nodeValue = $nl;
					} else {
						$elt->replaceChild( $span, $c );
						$span->appendChild( $c );
					}
				} elseif ( $c instanceof DOMComment ) {
					$start += WTUtils::decodedCommentLength( $c );
				} elseif ( $c instanceof DOMElement ) {
					// No point wrapping following text nodes if there won't be any usable DSR
					$cDSR = DOMDataUtils::getDataParsoid( $c )->dsr ?? null;
					if ( !Utils::isValidDSR( $cDSR ) ) {
						break;
					}
					$start = $cDSR->end;
					$next = $c->hasAttribute( 'about' ) ? WTUtils::skipOverEncapsulatedContent( $c ) : $next;
				}
				$c = $next;
			}
		}
	}

	/**
	 * @param DOMElement $body
	 */
	private function preprocessDOM( DOMElement $body ): void {
		if ( Semver::satisfies( $this->env->getInputContentVersion(), '>=2.1.2' ) ) {
			// Wrap text node children of <li> elements in dummy spans
			$this->wrapTextChildrenOfNode( $body, 'li' );
			$this->wrapTextChildrenOfNode( $body, 'dd' );
		}
	}

	/**
	 * Selectively serialize an HTML DOM.
	 *
	 * WARNING: You probably want to use WikitextContentModelHandler::fromDOM instead.
	 *
	 * @param DOMDocument $doc
	 * @return string
	 */
	public function serializeDOM( DOMDocument $doc ): string {
		$serializeStart = null;
		$domDiffStart = null;
		$r = null;

		$timing = Timing::start( $this->metrics );

		$body = DOMCompat::getBody( $doc );
		$oldBody = DOMCompat::getBody( $this->selserData->oldDOM );

		// Preprocess DOMs
		$this->preprocessDOM( $oldBody );
		$this->preprocessDOM( $body );

		// Use provided diff-marked DOM (used during testing)
		// or generate one (used in production)
		if ( $this->env->getDOMDiff() ) {
			$diff = [ 'isEmpty' => false ];
			$body = DOMCompat::getBody( $this->env->getDOMDiff() );
		} else {
			$domDiffTiming = Timing::start( $this->metrics );
			$diff = ( new DOMDiff( $this->env ) )->diff( $oldBody, $body );
			$domDiffTiming->end( 'html2wt.selser.domDiff' );
		}

		if ( $diff['isEmpty'] ) {
			// Nothing was modified, just re-use the original source
			$r = $this->selserData->oldText;
		} else {
			if ( $this->trace || $this->env->hasDumpFlag( 'dom:post-dom-diff' ) ) {
				$options = [ 'storeDiffMark' => true, 'env' => $this->env ];
				ContentUtils::dumpDOM( $oldBody, 'OLD DOM ', $options );
				ContentUtils::dumpDOM( $body, 'DOM after running DOMDiff', $options );
			}

			// Call the WikitextSerializer to do our bidding
			$r = $this->wts->serializeDOM( $doc, true );
		}

		$timing->end( 'html2wt.selser.serialize' );

		return $r;
	}
}
