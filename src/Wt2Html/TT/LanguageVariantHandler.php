<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\NodeData\DataMwVariant;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\VariantFilter;
use Wikimedia\Parsoid\NodeData\VariantOneWay;
use Wikimedia\Parsoid\NodeData\VariantTwoWay;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\VariantOption;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wikitext\Consts;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Handler for language conversion markup, which looks like `-{ ... }-`.
 */
class LanguageVariantHandler extends XMLTagBasedHandler {
	/** @inheritDoc */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	/**
	 * convert one variant text to dom.
	 *
	 * @param TokenHandlerPipeline $manager
	 * @param array $options
	 * @param string $t
	 * @param array $attribs
	 *
	 * @return array{frag: DocumentFragment, isBlock: bool}
	 */
	private function convertOne( TokenHandlerPipeline $manager, array $options, string $t,
		array $attribs ): array {
		// we're going to fetch the actual token list from attribs
		// (this ensures that it has gone through the earlier stages
		// of the pipeline already to be expanded)
		$t = PHPUtils::stripPrefix( $t, 'mw:lv' );
		$srcOffsets = $attribs[$t]->srcOffsets;
		$domFragment = PipelineUtils::processContentInPipeline(
			$this->env, $manager->getFrame(), array_merge( $attribs[$t]->v, [ new EOFTk() ] ),
			[
				'pipelineType' => 'expanded-tokens-to-fragment',
				'pipelineOpts' => [
					'inlineContext' => true,
					'expandTemplates' => $options['expandTemplates'],
					'inTemplate' => $options['inTemplate']
				],
				'srcOffsets' => $srcOffsets->value ?? null,
				'sol' => true
			]
		);
		return [
			'frag' => $domFragment,
			'isBlock' => DOMUtils::hasBlockElementDescendant( $domFragment ),
		];
	}

	private function emptyFrag(): DocumentFragment {
		$doc = $this->env->getTopLevelDoc();
		return $doc->createDocumentFragment();
	}

	/**
	 * Compress a whitespace sequence.
	 * @see \Wikimedia\Parsoid\Html2Wt\LanguageVariantHandler::expandSpArrary
	 * @param ?list<string> $a
	 * @return ?list<int|string>
	 */
	private function compressSpArray( ?array $a ): ?array {
		$result = [];
		$ctr = 0;
		if ( $a === null ) {
			return $a;
		}
		foreach ( $a as $sp ) {
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
		if ( $ctr > 0 ) {
			$result[] = $ctr;
		}
		return $result;
	}

	/**
	 * Main handler.
	 * See {@link TokenHandlerPipeline#addTransform}'s transformation parameter
	 * @param Token $token
	 * @return ?array<string|Token>
	 */
	private function onLanguageVariant( Token $token ): ?array {
		$manager = $this->manager;
		$options = $this->options;
		$attribs = $token->attribs;
		$dataParsoid = $token->dataParsoid;
		$tsr = $dataParsoid->tsr;
		$variantInfo = $dataParsoid->getTemp()->variantInfo;
		$flags = $variantInfo->flags;
		$flagSp = $variantInfo->flagSp;
		$variantTexts = $variantInfo->texts;
		$sawFlagA = false;

		// remove trailing semicolon marker, if present
		$trailingSemi = false;
		if ( count( $variantTexts ) &&
			( $variantTexts[count( $variantTexts ) - 1]->semi )
		) {
			$trailingSemi = array_pop( $variantTexts )->sp[0];
		}
		// convert all variant texts to DOM
		$isBlock = false;
		$texts = array_map( function ( VariantOption $t ) use ( $manager, $options, $attribs, &$isBlock ) {
			if ( $t->twoway ) {
				$text = $this->convertOne( $manager, $options, $t->text, $attribs );
				$isBlock = $isBlock || !empty( $text['isBlock'] );
				return [ 'lang' => $t->lang, 'text' => $text['frag'], 'twoway' => true, 'sp' => $t->sp ];
			} elseif ( $t->lang !== null ) {
				$from = $this->convertOne( $manager, $options, $t->from, $attribs );
				$to = $this->convertOne( $manager, $options, $t->to, $attribs );
				$isBlock = $isBlock || !empty( $from['isBlock'] ) || !empty( $to['isBlock'] );
				return [ 'lang' => $t->lang, 'from' => $from['frag'], 'to' => $to['frag'],
					'sp' => $t->sp ];
			} else {
				$text = $this->convertOne( $manager, $options, $t->text, $attribs );
				$isBlock = $isBlock || !empty( $text['isBlock'] );
				return [ 'text' => $text['frag'], 'sp' => [] ];
			}
		}, $variantTexts );
		// collect two-way/one-way conversion rules
		$oneway = [];
		$twoway = [];
		$sawTwoway = false;
		$sawOneway = false;
		$textSp = null;
		$twowaySp = [];
		$onewaySp = [];
		foreach ( $texts as $t ) {
			if ( isset( $t['twoway'] ) ) {
				$twoway[] = new VariantTwoWay( $t['lang'], $t['text'] );
				array_push( $twowaySp, $t['sp'][0], $t['sp'][1], $t['sp'][2] );
				$sawTwoway = true;
			} elseif ( isset( $t['lang'] ) ) {
				$oneway[] = new VariantOneWay( $t['lang'], $t['from'], $t['to'] );
				array_push( $onewaySp, $t['sp'][0], $t['sp'][1], $t['sp'][2], $t['sp'][3] );
				$sawOneway = true;
			}
		}

		$dataMWV = new DataMwVariant;
		$sawDisabled = false;
		$sawName = false;
		if ( count( $flags ) === 0 && count( $variantInfo->variants ) > 0 ) {
			// "Restrict possible variants to a limited set"
			$dataMWV->filter = new VariantFilter( $variantInfo->variants, $texts[0]['text'] );
			$dataMWV->show = true;
		} else {
			foreach ( $flags as $f ) {
				$flagName = Consts::$LCFlagMap[$f] ?? null;
				if ( $flagName === null ) {
					$dataMWV->error = true;
				} elseif ( $flagName === 'disabled' ) {
					$sawDisabled = true;
				} elseif ( $flagName === 'name' ) {
					$sawName = true;
				} elseif ( $flagName ) {
					$dataMWV->$flagName = true;
					if ( $f === 'A' ) {
						$sawFlagA = true;
					}
				}
			}
			// (this test is done at the top of ConverterRule::getRuleConvertedStr)
			// (also partially in ConverterRule::parse)
			if ( count( $texts ) === 1 &&
				!isset( $texts[0]['lang'] ) && !$sawName
			) {
				if ( $dataMWV->add || $dataMWV->remove ) {
					$variants = [ '*' ];
					$twoway = array_map( static function ( string $code ) use ( $texts, &$sawTwoway ) {
						$sawTwoway = true;
						return new VariantTwoWay( $code, $texts[0]['text'] );
					}, $variants );
				} else {
					$sawDisabled = true;
					$dataMWV->describe = false;
				}
			}
			if ( $dataMWV->describe ) {
				if ( !$sawFlagA ) {
					$dataMWV->show = true;
				}
			}
			if ( $sawDisabled || $sawName ) {
				if ( $sawDisabled ) {
					$dataMWV->disabled = $texts[0]['text'] ?? $this->emptyFrag();
				} else {
					$dataMWV->name = $texts[0]['text'] ?? $this->emptyFrag();
				}
				if ( $dataMWV->title || $dataMWV->add ) {
					$dataMWV->show = false;
				} else {
					$dataMWV->show = true;
				}
			} elseif ( $sawTwoway ) {
				$dataMWV->twoway = $twoway;
				$textSp = $twowaySp;
				if ( $sawOneway ) {
					$dataMWV->error = true;
				}
			} else {
				$dataMWV->oneway = $oneway;
				$textSp = $onewaySp;
				if ( !$sawOneway ) {
					$dataMWV->error = true;
				}
			}
		}
		// Use meta/not meta instead of explicit 'show' flag.
		$isMeta = !$dataMWV->show;
		$dataMWV->show = false;
		// Trim some data from data-parsoid if it matches the defaults
		if ( count( $flagSp ) === 2 * count( $variantInfo->original ) ) {
			$result = true;
			foreach ( $flagSp as $s ) {
				if ( $s !== '' ) {
					$result = false;
					break;
				}
			}
			if ( $result ) {
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

		$das = new DataParsoid;
		$das->fl = $variantInfo->original; // original "fl"ags
		$flSp = $this->compressSpArray( $flagSp ); // spaces around flags
		if ( $flSp !== null ) {
			$das->flSp = $flSp;
		}
		$das->src = $dataParsoid->src;
		$tSp = $this->compressSpArray( $textSp ); // spaces around texts
		if ( $tSp !== null ) {
			$das->tSp = $tSp;
		}
		$das->tsr = new SourceRange( $tsr->start, $isMeta ? $tsr->end : ( $tsr->end - 2 ), $tsr->source );
		// Tunnel DataMwVariant through the token inside the DataParsoid
		$das->getTemp()->variantData = $dataMWV;

		$tokens = [
			new TagTk( $isMeta ? 'meta' : ( $isBlock ? 'div' : 'span' ), [
					new KV( 'typeof', 'mw:LanguageVariant' ),
			], $das
			)
		];
		if ( !$isMeta ) {
			$metaDP = new DataParsoid;
			$metaDP->tsr = new SourceRange( $tsr->end - 2, $tsr->end, $tsr->source );
			$tokens[] = new EndTagTk( $isBlock ? 'div' : 'span', [], $metaDP );
		}

		return $tokens;
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return $token->getName() === 'language-variant' ? $this->onLanguageVariant( $token ) : null;
	}
}
