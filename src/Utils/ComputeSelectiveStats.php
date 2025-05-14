<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\PageConfig;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Html2Wt\DiffUtils;
use Wikimedia\Parsoid\Html2Wt\DOMDiff;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\TemplateInfo;

/**
 * This file contains code to classify opportunities for selective
 * update and collect statistics.
 */
class ComputeSelectiveStats {

	/** @return array<string,string> */
	public static function classify(
		Env $env,
		?PageConfig $oldPage, ?PageBundle $oldPb,
		PageConfig $newPage, PageBundle $newPb
	): array {
		// Default labels (ensure keys are consistent & in consistent order).
		// Each label key should be a valid label name accepted by StatsLib,
		// i.e. an alphanumeric string that does not include dashes (T394053).
		$labels = [
			'type' => 'missing-prev',
			'same_wt' => 'unknown',
			'rev_diff' => 'unknown',
			'changed_sections' => 'unknown',
			'changed_template_sites' => 'unknown',
			'changed_template_names' => 'unknown',
		];
		if ( $oldPage === null || $oldPb === null ) {
			return $labels;
		}
		$oldWt = self::pc2wt( $oldPage );
		$newWt = self::pc2wt( $newPage );

		// Compare wikitext in both revisions
		$labels['same_wt'] = self::bool2str( $oldWt == $newWt );

		// Compare revision IDs
		$oldRev = $oldPage->getRevisionId();
		$newRev = $newPage->getRevisionId();
		if ( $oldRev === $newRev ) {
			// same revision (template update, most likely)
			$labels['rev_diff'] = '0';
		} elseif ( $oldRev === $newPage->getParentRevisionId() ) {
			// "normal edit": new revision is the one after old revision
			$labels['rev_diff'] = '1';
		} elseif ( $newRev === $oldPage->getParentRevisionId() ) {
			// new revision is the one *before* old revision
			// This is probably a render triggered from RevisionOutputCache
			// of the previous revision where the "oldRev" is coming from
			// the parser cache and is thus the latest.  This may happen
			// during races, vandalism patrol, HTML diffing, etc.
			$labels['rev_diff'] = 'minus1';
		}

		// Parse to DOM and diff
		$oldDoc = DomPageBundle::fromPageBundle( $oldPb )->toDom();
		$newDoc = DomPageBundle::fromPageBundle( $newPb )->toDom();
		$dd = new DOMDiff( $env );
		// Don't skip over template content!
		$dd->skipEncapsulatedContent = false;
		// Ignore differences in data-parsoid 'dsr' and 'tmp'
		$cleanDP = static function ( DataParsoid $dp ): DataParsoid {
			$dp = clone $dp;
			foreach ( [ 'tmp', 'tsr', 'dsr', 'extTagOffsets', 'extLinkContentOffsets' ] as $prop ) {
				unset( $dp->$prop );
			}
			return $dp;
		};
		$dd->specializedAttribHandlers['data-parsoid'] = static function ( $nA, $vA, $nB, $vB ) use ( $cleanDP ) {
			// This is deliberately a not-strict equality comparisong between
			// two DataParsoid objects.
			// @phan-suppress-next-line PhanPluginComparisonObjectEqualityNotStrict
			return $cleanDP( $vA ) == $cleanDP( $vB );
		};
		// Ignore differences in 'id' attributes, since these are a side-effect
		// of data-parsoid/page bundle encapsulation.
		$dd->specializedAttribHandlers['id'] = static function ( $nA, $vA, $nB, $vB ) {
			// XXX we can't really tell synthethic ID attributes created by
			// DOMDataUtils::storeInPageBundle() from "real" ID attributes
			// in user wikitext.  Hackishly ignore differences in any ID
			// attributes that begin with 'mw' even though technically you
			// could have a <span id="mw-something'> in wikitext, and change
			// that to <span id='mw-different-thing'> and with this attribute
			// handler DOM diff wouldn't flag the change.  In theory we should
			// be using shadow attributes to record when an id was synthetic.
			if ( str_starts_with( $vA, 'mw' ) && str_starts_with( $vB, 'mw' ) ) {
				return true; // equal enough
			}
			return $vA === $vB;
		};
		[ 'isEmpty' => $emptyDiff ] = $dd->diff(
			DOMCompat::getBody( $oldDoc ),
			DOMCompat::getBody( $newDoc )
		);
		if ( $oldWt === $newWt ) {
			// old and new wikitext identical. is html also identical?
			$labels['type'] = $emptyDiff ? 'no-op' : 'template-update';
		} else {
			$labels['type'] = 'page-update';
		}

		// Use a DOMTraverser to count how many sections and templates were
		// modified. (Skip attribute embedded HTML for now.)
		$dt = new DOMTraverser( true );
		$sectionsModified = 0;
		$dt->addHandler( 'section', static function ( Element $el ) use ( &$sectionsModified ) {
			if ( WTUtils::isParsoidSectionTag( $el ) && !DiffUtils::subtreeUnchanged( $el ) ) {
				$sectionsModified++;
			}
			return true;
		} );
		$templatesModified = 0;
		$namedTemplates = [];
		$dt->addHandler( null, static function ( $el, $state ) use ( &$templatesModified, &$namedTemplates ) {
			if ( !( $el instanceof Element ) ) {
				return true;
			}
			if (
				$el === ( $state->tplInfo->first ?? null ) &&
				DOMUtils::hasTypeOf( $el, 'mw:Transclusion' )
			) {
				$changed = false;
				$about = DOMCompat::getAttribute( $el, 'about' );
				foreach ( WTUtils::getAboutSiblings( $el, $about ) as $sib ) {
					// Note that we might miss a change here in a sibling
					// which is fosterable IEW, since that's !Element.
					if (
						$sib instanceof Element &&
						!DiffUtils::subtreeUnchanged( $sib )
					) {
						$changed = true;
						break;
					}
				}

				// Compute the number of templates modified
				if ( $changed ) {
					$templatesModified++;
					$dataMw = DOMDataUtils::getDataMw( $el );
					$name = null;
					foreach ( $dataMw->parts ?? [] as $part ) {
						if ( $part instanceof TemplateInfo ) {
							$name ??= $part->href;
						}
					}
					$namedTemplates[$name ?? 'unknown'] = true;
				}
				// Don't recurse into templates, just tabulate top-level
				$state->tplInfo->clear = true;
				return $state->tplInfo->last->nextSibling;
			}
			return true;
		} );
		# do the traversal
		$dt->traverse( null, DOMCompat::getBody( $newDoc ), new DTState( $env ) );

		# report changed sections as '0', '1', or '2+'
		$labels['changed_sections'] = self::int2str( $sectionsModified, 2 );
		# report changed templates as '0', '1', or '2+'
		$labels['changed_template_sites'] = self::int2str( $templatesModified, 2 );
		# report the count of the *names* of the templates that were updated.
		$labels['changed_template_names'] = self::int2str( count( $namedTemplates ), 2 );

		// TODO: sum up the time spent on modified (vs unmodified) templates

		return $labels;
	}

	// ----------- Helper functions ---------------

	/** Convert a PageConfig to a wikitext string. */
	private static function pc2wt( PageConfig $pc ): string {
		return $pc->getRevisionContent()->getContent( 'main' );
	}

	// See https://www.mediawiki.org/wiki/Manual:Stats#Cardinality

	/** Restrict the cardinality of user agent labels */
	public static function filterUserAgent( ?string $userAgent ): string {
		static $acceptableAgents = [
			'ChangePropagation_JobQueue_WMF' => true,
			'ChangePropagation_WMF' => true,
			'Mobileapps_WMF' => true,
			'RESTBase_WMF' => true,
			'C_WikiAPI' => true,
			'Java_7_0_for_MediaWikiAPI' => true,
		];
		static $agentPrefixes = [
			'MediaWiki_API',
			'MediaWiki_Bot',
			'Mozilla_4_0',
			'Mozilla_5_0',
			'Mozilla',
			'REST_API_Crawler_Google',
			'IABot',
			'Rust_mediawiki_API',
			'ChangePropagation', // fallback
		];
		if ( $userAgent === null ) {
			return 'unknown';
		}
		// Replace non-alphanumeric characters, the same way that core does
		// See mediawiki-core:includes/libs/Stats/StatsUtils::normalizeString()
		$userAgent = preg_replace( '/\W+/', '_', $userAgent );
		$userAgent = trim( $userAgent, "_" );
		if ( $acceptableAgents[$userAgent] ?? false ) {
			return $userAgent;
		}
		foreach ( $agentPrefixes as $prefix ) {
			if ( str_starts_with( $userAgent, $prefix ) ) {
				return $prefix;
			}
		}
		return 'other';
	}

	/** Convert a boolean to a string for labelling purposes. */
	private static function bool2str( ?bool $val ): string {
		return ( $val === true ) ? 'true' : (
			( $val === false ) ? 'false' : 'unknown'
		);
	}

	/**
	 * Convert an integer to a string for labelling purposes,
	 * restricting its cardinality.
	 */
	private static function int2str( ?int $val, ?int $limit = null ): string {
		if ( $val === null ) {
			return 'unknown';
		}
		if ( $limit !== null && $val >= $limit ) {
			return "{$limit}plus";
		}
		return "$val";
	}
}
