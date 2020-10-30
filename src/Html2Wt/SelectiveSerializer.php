<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Composer\Semver\Semver;
use DOMComment;
use DOMElement;
use DOMText;
use Wikimedia\Assert\Assert;
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
		$env = $options['env'];
		$this->env = $env;
		$this->wts = new WikitextSerializer( $options );
		$this->selserData = $options['selserData'];

		// Debug options
		$this->trace = $env->hasTraceFlag( 'selser' );

		// Performance Timing option
		$this->metrics = $env->getSiteConfig()->metrics();
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
		// FIXME (optimization): This probably only has to wrap the
		// *first/last* children *if* they are Text, not *every* Text
		// child (T266908)
		$inListItem = isset( WikitextConstants::$HTML['ListItemTags'][$nodeName] );
		foreach ( DOMCompat::querySelectorAll( $body, $nodeName ) as $elt ) {
			if ( WTUtils::isLiteralHTMLNode( $elt ) ) {
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
					if ( $text[$len - 1] === "\n" ) {
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
				}
				$c = $next;
			}
		}
	}

	/**
	 * @param Env $env
	 * @param DOMElement $body
	 */
	private function preprocessDOM( Env $env, DOMElement $body ): void {
		if ( Semver::satisfies( $env->getInputContentVersion(), '>=2.1.1' ) ) {
			// Wrap text node children of <li> elements in dummy spans
			$this->wrapTextChildrenOfNode( $body, 'li' );
			$this->wrapTextChildrenOfNode( $body, 'dd' );
		}
	}

	/**
	 * Selectively serialize an HTML DOM document.
	 *
	 * WARNING: You probably want to use FromHTML.serializeDOM instead.
	 * @param DOMElement $body
	 * @return string
	 */
	public function serializeDOM( DOMElement $body ): string {
		Assert::invariant( DOMUtils::isBody( $body ), 'Expected a body node.' );

		$serializeStart = null;
		$domDiffStart = null;
		$r = null;
		$env = $this->env;

		// Preprocess DOMs
		// FIXME: The work done here isn't account for in any timing metrics
		// This is not dom-diffing and seems silly to introduce yet one more timing component.
		// We already have five: init, setup, preprocess, domdiff, serialize
		$this->preprocessDOM( $env, $this->selserData->oldDOM );
		$this->preprocessDOM( $env, $body );

		$timing = Timing::start( $this->metrics );

		// Use provided diff-marked DOM (used during testing)
		// or generate one (used in production)
		if ( $env->getDOMDiff() ) {
			$diff = $env->getDOMDiff();
			$body = $diff->dom;
		} else {
			$domDiffTiming = Timing::start( $this->metrics );
			$diff = ( new DOMDiff( $env ) )->diff( $this->selserData->oldDOM, $body );
			$domDiffTiming->end( 'html2wt.selser.domDiff' );
		}

		if ( $diff['isEmpty'] ) {
			// Nothing was modified, just re-use the original source
			$r = $this->selserData->oldText;
		} else {
			if ( $this->trace || $env->hasDumpFlag( 'dom:post-dom-diff' ) ) {
				$options = [ 'storeDiffMark' => true, 'env' => $env ];
				ContentUtils::dumpDOM( $this->selserData->oldDOM, 'OLD DOM ', $options );
				ContentUtils::dumpDOM( $body, 'DOM after running DOMDiff', $options );
			}

			// Call the WikitextSerializer to do our bidding
			$r = $this->wts->serializeDOM( $body, true );
		}

		$timing->end( 'html2wt.selser.serialize' );

		return $r;
	}
}
