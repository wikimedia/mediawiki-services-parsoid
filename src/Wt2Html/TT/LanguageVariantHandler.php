<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$Consts = require '../../config/WikitextConstants.js'::WikitextConstants;
$temp0 = require '../../utils/ContentUtils.js';
$ContentUtils = $temp0::ContentUtils;
$temp1 = require '../../utils/DOMUtils.js';
$DOMUtils = $temp1::DOMUtils;
$temp2 = require '../../utils/jsutils.js';
$JSUtils = $temp2::JSUtils;
$temp3 = require '../../utils/PipelineUtils.js';
$PipelineUtils = $temp3::PipelineUtils;
$Promise = require '../../utils/promise.js';
$TokenHandler = require './TokenHandler.js';
$temp4 = require '../../tokens/TokenTypes.js';
$KV = $temp4::KV;
$EOFTk = $temp4::EOFTk;
$TagTk = $temp4::TagTk;
$EndTagTk = $temp4::EndTagTk;

/**
 * Handler for language conversion markup, which looks like `-{ ... }-`.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class LanguageVariantHandler extends TokenHandler {
	/**
	 * @param {Object} manager
	 * @param {Object} options
	 */
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->manager->addTransformP(
			$this, $this->onLanguageVariant,
			'LanguageVariantHandler:onLanguageVariant',
			self::rank(), 'tag', 'language-variant'
		);
	}

	// Indicates where in the pipeline this handler should be run.
	public static function rank() {
 return 1.16;
 }

	/**
	 * Main handler.
	 * See {@link TokenTransformManager#addTransform}'s transformation parameter
	 */
	public function onLanguageVariantG( $token ) {
		$manager = $this->manager;
		$options = $this->options;
		$attribs = $token->attribs;
		$dataAttribs = $token->dataAttribs;
		$tsr = $dataAttribs->tsr;
		$flags = $dataAttribs->flags || [];
		$flagSp = $dataAttribs->flagSp;
		$isMeta = false;
		$sawFlagA = false;

		// convert one variant text to dom.
		$convertOne = /* async */function ( $t ) use ( &$attribs, &$PipelineUtils, &$manager, &$EOFTk, &$options, &$ContentUtils, &$DOMUtils ) {
			// we're going to fetch the actual token list from attribs
			// (this ensures that it has gone through the earlier stages
			// of the pipeline already to be expanded)
			$t = +( preg_replace( '/^mw:lv/', '', $t, 1 ) );
			$srcOffsets = $attribs[ $t ]->srcOffsets;
			$doc = /* await */ PipelineUtils::promiseToProcessContent(
				$manager->env, $manager->frame, $attribs[ $t ]->v->concat( [ new EOFTk() ] ),
				[
					'pipelineType' => 'tokens/x-mediawiki/expanded',
					'pipelineOpts' => [
						'inlineContext' => true,
						'expandTemplates' => $options->expandTemplates,
						'inTemplate' => $options->inTemplate
					],
					'srcOffsets' => ( $srcOffsets ) ? array_slice( $srcOffsets, 2, 4/*CHECK THIS*/ ) : null,
					'sol' => true
				]
			);
			return [
				'xmlstr' => ContentUtils::ppToXML( $doc->body, [ 'innerXML' => true ] ),
				'isBlock' => DOMUtils::hasBlockElementDescendant( $doc->body )
			];
		};
		// compress a whitespace sequence
		$compressSpArray = function ( $a ) {
			$result = [];
			$ctr = 0;
			if ( $a === null ) {
				return $a;
			}
			$a->forEach( function ( $sp ) use ( &$ctr, &$result ) {
					if ( $sp === '' ) {
						$ctr++;
					} else {
						if ( $ctr > 0 ) {
							$result[] = $ctr;
							$ctr = 0;
						}
						$result[] = $sp;
					}
			}
			);
			if ( $ctr > 0 ) { $result[] = $ctr;
   }
			return $result;
		};
		// remove trailing semicolon marker, if present
		$trailingSemi = false;
		if (
			count( $dataAttribs->texts )
&& $dataAttribs->texts[ count( $dataAttribs->texts ) - 1 ]->semi
		) {
			$trailingSemi = array_pop( $dataAttribs->texts )->sp;
		}
		// convert all variant texts to DOM
		$isBlock = false;
		$texts = /* await */ Promise::map( $dataAttribs->texts, /* async */function ( $t ) use ( &$convertOne ) {
				$text = null;
$from = null;
$to = null;
				if ( $t->twoway ) {
					$text = /* await */ $convertOne( $t->text );
					$isBlock = $isBlock || $text->isBlock;
					return [ 'lang' => $t->lang, 'text' => $text->xmlstr, 'twoway' => true, 'sp' => $t->sp ];
				} elseif ( $t->lang ) {
					$from = /* await */ $convertOne( $t->from );
					$to = /* await */ $convertOne( $t->to );
					$isBlock = $isBlock || $from->isBlock || $to->isBlock;
					return [ 'lang' => $t->lang, 'from' => $from->xmlstr, 'to' => $to->xmlstr, 'sp' => $t->sp ];
				} else {
					$text = /* await */ $convertOne( $t->text );
					$isBlock = $isBlock || $text->isBlock;
					return [ 'text' => $text->xmlstr, 'sp' => [] ];
				}
		}

		);
		// collect two-way/one-way conversion rules
		$oneway = [];
		$twoway = [];
		$sawTwoway = false;
		$sawOneway = false;
		$textSp = null;
		$twowaySp = [];
		$onewaySp = [];
		$texts->forEach( function ( $t ) use ( &$twoway, &$twowaySp, &$oneway, &$onewaySp ) {
				if ( $t->twoway ) {
					$twoway[] = [ 'l' => $t->lang, 't' => $t->text ];
					array_push( $twowaySp, $t->sp[ 0 ], $t->sp[ 1 ], $t->sp[ 2 ] );
					$sawTwoway = true;
				} elseif ( $t->lang ) {
					$oneway[] = [ 'l' => $t->lang, 'f' => $t->from, 't' => $t->to ];
					array_push( $onewaySp, $t->sp[ 0 ], $t->sp[ 1 ], $t->sp[ 2 ], $t->sp[ 3 ] );
					$sawOneway = true;
				}
		}
		);

		// To avoid too much data-mw bloat, only the top level keys in
		// data-mw-variant are "human readable".  Nested keys are single-letter:
		// `l` for `language`, `t` for `text` or `to`, `f` for `from`.
		$dataMWV = null;
		if ( count( $flags ) === 0 && count( $dataAttribs->variants ) > 0 ) {
			// "Restrict possible variants to a limited set"
			$dataMWV = [
				'filter' => [ 'l' => $dataAttribs->variants, 't' => $texts[ 0 ]->text ],
				'show' => true
			];
		} else {
			$dataMWV = array_reduce( $flags, function ( $dmwv, $f ) {
					if ( Consts\LCFlagMap::has( $f ) ) {
						if ( Consts\LCFlagMap::get( $f ) ) {
							$dmwv[ Consts\LCFlagMap::get( $f ) ] = true;
							if ( $f === 'A' ) {
								$sawFlagA = true;
							}
						}
					} else {
						$dmwv->error = true;
					}
					return $dmwv;
			}, []
			);
			// (this test is done at the top of ConverterRule::getRuleConvertedStr)
			// (also partially in ConverterRule::parse)
			if ( count( $texts ) === 1 && !$texts[ 0 ]->lang && !$dataMWV->name ) {
				if ( $dataMWV->add || $dataMWV->remove ) {
					$variants = [ '*' ];
					$twoway = array_map( $variants, function ( $code ) {
							return [ 'l' => $code, 't' => $texts[ 0 ]->text ];
					}
					);
					$sawTwoway = true;
				} else {
					$dataMWV->disabled = true;
					$dataMWV->describe = null;
				}
			}
			if ( $dataMWV->describe ) {
				if ( !$sawFlagA ) { $dataMWV->show = true;
	   }
			}
			if ( $dataMWV->disabled || $dataMWV->name ) {
				if ( $dataMWV->disabled ) {
					$dataMWV->disabled = [ 't' => $texts[ 0 ]->text ];
				} else {
					$dataMWV->name = [ 't' => $texts[ 0 ]->text ];
				}
				$dataMWV->show =
				( $dataMWV->title || $dataMWV->add ) ? null : true;
			} elseif ( $sawTwoway ) {
				$dataMWV->twoway = $twoway;
				$textSp = $twowaySp;
				if ( $sawOneway ) { $dataMWV->error = true;
	   }
			} else {
				$dataMWV->oneway = $oneway;
				$textSp = $onewaySp;
				if ( !$sawOneway ) { $dataMWV->error = true;
	   }
			}
		}
		// Use meta/not meta instead of explicit 'show' flag.
		$isMeta = !$dataMWV->show;
		$dataMWV->show = null;
		// Trim some data from data-parsoid if it matches the defaults
		if ( count( $flagSp ) === 2 * count( $dataAttribs->original ) ) {
			if ( $flagSp->every( function ( $s ) { return $s === '';
   } ) ) {
				$flagSp = null;
			}
		}
		if ( $trailingSemi !== false && $textSp ) {
			$textSp[] = $trailingSemi;
		}

		// Our markup is always the same, except for the contents of
		// the data-mw-variant attribute and whether it's a span, div, or a
		// meta, depending on (respectively) whether conversion output
		// contains only inline content, could contain block content,
		// or never contains any content.
		$tokens = [
			new TagTk( ( $isMeta ) ? 'meta' : ( $isBlock ) ? 'div' : 'span', [
					new KV( 'typeof', 'mw:LanguageVariant' ),
					new KV(
						'data-mw-variant',
						json_encode( JSUtils::sortObject( $dataMWV ) )
					)
				], [
					'fl' => $dataAttribs->original, // original "fl"ags
					'flSp' => $compressSpArray( $flagSp ), // spaces around flags
					'src' => $dataAttribs->src,
					'tSp' => $compressSpArray( $textSp ), // spaces around texts
					'tsr' => [ $tsr[ 0 ], ( $isMeta ) ? $tsr[ 1 ] : ( $tsr[ 1 ] - 2 ) ]
				]
			)
		];
		if ( !$isMeta ) {
			$tokens[] = new EndTagTk( ( $isBlock ) ? 'div' : 'span', [], [
					'tsr' => [ $tsr[ 1 ] - 2, $tsr[ 1 ] ]
				]
			);
		}

		return [ 'tokens' => $tokens ];
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
LanguageVariantHandler::prototype::onLanguageVariant =
/* async */LanguageVariantHandler::prototype::onLanguageVariantG;

if ( gettype( $module ) === 'object' ) {
	$module->exports->LanguageVariantHandler = $LanguageVariantHandler;
}
