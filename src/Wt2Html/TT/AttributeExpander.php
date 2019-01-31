<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Generic attribute expansion handler.
 * @module
 */

namespace Parsoid;

use Parsoid\AttributeTransformManager as AttributeTransformManager;
use Parsoid\PegTokenizer as PegTokenizer;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\NlTk as NlTk;
use Parsoid\TagTk as TagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;

/**
 * Generic attribute expansion handler.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class AttributeExpander extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->tokenizer = new PegTokenizer( $this->env );

		if ( !$this->options->standalone ) {
			// XXX: only register for tag tokens?
			$this->manager->addTransform(
				function ( $token, $cb ) {return $this->onToken( $token, $cb );
	   },
				'AttributeExpander:onToken',
				self::rank(),
				'any'
			);
		}
	}
	public $tokenizer;

	public static function rank() {
 return 1.12;
 }
	public static function skipRank() {
 return 1.13; /* should be higher than all other ranks above */
 }

	/**
	 * Token handler.
	 *
	 * Expands target and arguments (both keys and values) and either directly
	 * calls or sets up the callback to _expandTemplate, which then fetches and
	 * processes the template.
	 *
	 * @private
	 * @param {Token} token Token whose attrs being expanded.
	 * @param {Function} cb Results passed back via this callback.
	 */
	public function onToken( $token, $cb ) {
		$attribs = $token->attribs;
		// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
		if ( ( $token->constructor === TagTk::class || $token->constructor === SelfclosingTagTk::class )
&& // Do not process dom-fragment tokens: a separate handler deals with them.
				$attribs && count( $attribs )
&& $token->name !== 'mw:dom-fragment-token'
&&
				$token->name !== 'meta'
|| !preg_match( '/mw:(TSRMarker|Placeholder|Transclusion|Param|Includes)/', $token->getAttribute( 'typeof' ) )
		) {

			$atm = new AttributeTransformManager(
				$this->manager,
				[ 'expandTemplates' => $this->options->expandTemplates, 'inTemplate' => $this->options->inTemplate ]
			);
			$ret = $atm->process( $attribs );
			if ( $ret->async ) {
				$cb( [ 'async' => true ] );
				$ret->promises->then(
					function () use ( &$token, &$atm, &$attribs ) {return $this->buildExpandedAttrs( $token, $atm->getNewKVs( $attribs ) );
		   }
				)->then(
					function ( $ret ) use ( &$ret, &$cb ) {return $cb( $ret );
		   }
				)->done();
			} else {
				$cb( [ 'tokens' => [ $token ] ] );
			}
		} else {
			$cb( [ 'tokens' => [ $token ] ] );
		}
	}

	public static function nlTkIndex( $nlTkOkay, $tokens, $atTopLevel ) {
		// Moving this check here since it makes the
		// callsite cleaner and simpler.
		if ( $nlTkOkay ) {
			return -1;
		}

		// Check if we have a newline token in the attribute key/value token stream.
		// However, newlines are acceptable inside a <*include*>..</*include*> directive
		// since they are stripped out.
		//
		// let includeRE = !atTopLevel ? /(?:^|\s)mw:Includes\/NoInclude(\/.*)?(?:\s|$)/ : /(?:^|\s)mw:Includes\/(?:Only)?Include(?:Only)?(\/.*)?(?:\s|$)/;
		//
		// SSS FIXME: We cannot support this usage for <*include*> directives currently
		// since they don't go through template encapsulation and don't have a data-mw
		// format with "wt" and "transclusion" parts that we can use to just track bits
		// of wikitext that don't have a DOM representation.
		//
		// So, for now, we just suppress all newlines contained within these directives.
		//
		$includeRE = /* RegExp */ '/(?:^|\s)mw:Includes\/(?:No|Only)?Include(?:Only)?(\/.*)?(?:\s|$)/';
		$inInclude = false;
		for ( $i = 0,  $n = count( $tokens );  $i < $n;  $i++ ) {
			$t = $tokens[ $i ];
			if ( $t->constructor === SelfclosingTagTk::class ) {
				$type = $t->getAttribute( 'typeof' );
				$typeMatch = ( $type ) ? preg_match( $includeRE, $type ) : null;
				if ( $typeMatch ) {
					$inInclude = !$typeMatch[ 1 ] || !preg_match( '/\/End$/', $typeMatch[ 1 ] );
				}
			} elseif ( !$inInclude && $t->constructor === NlTk::class ) {
				// newline token outside <*include*>
				return $i;
			}
		}

		return -1;
	}

	public static function metaTypeMatcher() {
		return /* RegExp */ '/(mw:(LanguageVariant|Transclusion|Param|Includes\/)(.*)?$)/';
	}

	public static function splitTokens( $env, $token, $nlTkPos, $tokens, $wrapTemplates ) {
		$buf = [];
		$postNLBuf = null;
$startMeta = null;
$metaTokens = null;

		// Split the token array around the first newline token.
		for ( $i = 0,  $l = count( $tokens );  $i < $l;  $i++ ) {
			$t = $tokens[ $i ];
			if ( $i === $nlTkPos ) {
				// split here!
				$postNLBuf = array_slice( $tokens, $i );
				break;
			} else {
				if ( $wrapTemplates && $t->constructor === SelfclosingTagTk::class ) {
					$type = $t->getAttribute( 'typeof' );
					$typeMatch = $type && preg_match( $this->metaTypeMatcher(), $type );
					// Don't trip on transclusion end tags
					if ( $typeMatch && !preg_match( '/\/End$/', $typeMatch[ 1 ] ) ) {
						$startMeta = $t;
					}
				}

				$buf[] = $t;
			}
		}

		if ( $wrapTemplates && $startMeta ) {
			// Support template wrapping with the following steps:
			// - Hoist the transclusion start-meta from the first line
			// to before the token.
			// - Update the start-meta tsr to that of the token.
			// - Record the wikitext between the token and the transclusion
			// as an unwrappedWT data-parsoid attribute of the start-meta.
			$dp = $startMeta->dataAttribs;
			$dp->unwrappedWT = $env->page->src->substring( $token->dataAttribs->tsr[ 0 ], $dp->tsr[ 0 ] );

			// unwrappedWT will be added to the data-mw.parts array which makes
			// this a multi-template-content-block.
			// Record the first wikitext node of this block (required by html->wt serialization)
			$dp->firstWikitextNode = ( $token->dataAttribs->stx ) ? $token->name . '_' . $token->dataAttribs->stx : $token->name;

			// Update tsr[0] only. Unless the end-meta token is moved as well,
			// updating tsr[1] can introduce bugs in cases like:
			//
			// {|
			// |{{singlechart|Australia|93|artist=Madonna|album=Girls Gone Wild}}|x
			// |}
			//
			// which can then cause dirty diffs (the "|" before the x gets dropped).
			$dp->tsr[ 0 ] = $token->dataAttribs->tsr[ 0 ];
			$metaTokens = [ $startMeta ];

			return [ 'metaTokens' => $metaTokens, 'preNLBuf' => $buf, 'postNLBuf' => $postNLBuf ];
		} else {
			return [ 'metaTokens' => [], 'preNLBuf' => $tokens, 'postNLBuf' => [] ];
		}
	}

	/* ----------------------------------------------------------
	* This helper method strips all meta tags introduced by
	* transclusions, etc. and returns the content.
	* ---------------------------------------------------------- */
	public static function stripMetaTags( $env, $tokens, $wrapTemplates ) {
		$buf = [];
		$hasGeneratedContent = false;

		for ( $i = 0,  $l = count( $tokens );  $i < $l;  $i++ ) {
			$t = $tokens[ $i ];
			if ( array_search( $t->constructor, [ $TagTk, $SelfclosingTagTk ] ) !== -1 ) {
				// Take advantage of this iteration of `tokens` to seek out
				// document fragments.  They're an indication that an attribute
				// value wasn't present as literal text in the input and the
				// token should be annotated with "mw:ExpandedAttrs".
				if ( TokenUtils::isDOMFragmentType( $t->getAttribute( 'typeof' ) ) ) {
					$hasGeneratedContent = true;
				}

				if ( $wrapTemplates ) {
					// Strip all meta tags.
					$type = $t->getAttribute( 'typeof' );
					$typeMatch = $type && preg_match( $this->metaTypeMatcher(), $type );
					if ( $typeMatch ) {
						if ( !preg_match( '/\/End$/', $typeMatch[ 1 ] ) ) {
							$hasGeneratedContent = true;
						}
					} else {
						$buf[] = $t;
						continue;
					}
				}

				if ( $t->name !== 'meta' ) {
					// Dont strip token if it is not a meta-tag
					$buf[] = $t;
				}
			} else {
				$buf[] = $t;
			}
		}

		return [ 'hasGeneratedContent' => $hasGeneratedContent, 'value' => $buf ];
	}

	/**
	 * Callback for attribute expansion in AttributeTransformManager
	 * @private
	 */
	public function buildExpandedAttrsG( $token, $expandedAttrs ) {
		// If we're not in a template, we'll be doing template wrapping in dom
		// post-processing (same conditional there), so take care of meta markers
		// found while processing tokens.
		$wrapTemplates = !$this->options->inTemplate;
		$env = $this->manager->env;
		$metaTokens = [];
		$postNLToks = [];
		$tmpDataMW = null;
		$oldAttrs = $token->attribs;
		// Build newAttrs lazily (on-demand) to avoid creating
		// objects in the common case where nothing of significance
		// happens in this code.
		$newAttrs = null;
		$nlTkPos = -1;
		$i = null;
$l = null;
		$nlTkOkay = TokenUtils::isHTMLTag( $token ) || !TokenUtils::isTableTag( $token );

		// Identify attributes that were generated in full or in part using templates
		for ( $i = 0, $l = count( $oldAttrs );  $i < $l;  $i++ ) {
			$oldA = $oldAttrs[ $i ];
			$expandedA = $expandedAttrs[ $i ];

			// Preserve the key and value source, if available.
			// But, if 'oldA' wasn't cloned, expandedA will be the same as 'oldA'.
			if ( $oldA !== $expandedA ) {
				$expandedA->ksrc = $oldA->ksrc;
				$expandedA->vsrc = $oldA->vsrc;
				$expandedA->srcOffsets = $oldA->srcOffsets;
			}

			// Deal with two template-expansion scenarios for the attribute key (not value)
			//
			// 1. We have a template that generates multiple attributes of this token
			// as well as content after the token.
			// Ex: infobox templates from aircraft, ship, and other pages
			// See enwiki:Boeing_757
			//
			// - Split the expanded tokens into multiple lines.
			// - Expanded attributes associated with the token are retained in the
			// first line before a NlTk.
			// - Content tokens after the NlTk are moved to subsequent lines.
			// - The meta tags are hoisted before the original token to make sure
			// that the entire token and following content is encapsulated as a unit.
			//
			// 2. We have a template that only generates multiple attributes of this
			// token. In that case, we strip all template meta tags from the expanded
			// tokens and assign it a mw:ExpandedAttrs type with orig/expanded
			// values in data-mw.
			//
			// Reparse-KV-string scenario with templated attributes:
			// -----------------------------------------------------
			// In either scenario above, we need additional special handling if the
			// template generates one or more k=v style strings:
			// <div {{echo|1=style='color:red''}}></div>
			// <div {{echo|1=style='color:red' title='boo'}}></div>
			//
			// Real use case: Template {{ligne grise}} on frwp.
			//
			// To support this, we utilize the following hack. If we got a string of the
			// form "k=v" and our orig-v was "", we convert the token array to a string
			// and retokenize it to extract one or more attributes.
			//
			// But, we won't support scenarios like this:
			// {| title={{echo|1='name' style='color:red;'\n|-\n|foo}}\n|}
			// Here, part of one attribute and additional complete attribute strings
			// need reparsing, and that isn't a use case that is worth more complexity here.
			//
			// FIXME:
			// ------
			// 1. It is not possible for multiple instances of scenario 1 to be triggered
			// for the same token. So, I am not bothering trying to test and deal with it.
			//
			// 2. We trigger the Reparse-KV-string scenario only for attribute keys,
			// since it isn't possible for attribute values to require this reparsing.
			// However, it is possible to come up with scenarios where a template
			// returns the value for one attribute and additional k=v strings for newer
			// attributes. We don't support that scenario, but don't even test for it.
			//
			// Reparse-KV-string scenario with non-string attributes:
			// ------------------------------------------------------
			// This is only going to be the case with table wikitext that has special syntax
			// for attribute strings.
			//
			// {| <div>a</div> style='border:1px solid black;'
			// |- <div>b</div> style='border:1px dotted blue;'
			// | <div>c</div> style='color:red;'
			// |}
			//
			// In wikitext like the above, the PEG tokenizer doesn't recognize these as
			// valid attributes (the templated attribute scenario is a special case) and
			// orig-v will be "". So, the same strategy as above is applied here as well.

			$origK = $expandedA->k;
			$origV = $expandedA->v;
			$updatedK = null;
			$updatedV = null;
			$expandedK = $expandedA->k;
			$reparsedKV = false;

			if ( $expandedK ) {
				// FIXME: We should get rid of these array/string/non-string checks
				// and probably use appropriately-named flags to convey type information.
				if ( is_array( $oldA->k ) ) {
					if ( !( $expandedK->constructor === $String && preg_match( '/(^|\s)mw:maybeContent(\s|$)/', $expandedK ) ) ) {
						$nlTkPos = self::nlTkIndex( $nlTkOkay, $expandedK, $wrapTemplates );
						if ( $nlTkPos !== -1 ) {
							// Scenario 1 from the documentation comment above.
							$updatedK = self::splitTokens( $env, $token, $nlTkPos, $expandedK, $wrapTemplates );
							$expandedK = $updatedK->preNLBuf;
							$postNLToks = $updatedK->postNLBuf;
							$metaTokens = $updatedK->metaTokens;
						} else {
							// Scenario 2 from the documentation comment above.
							$updatedK = self::stripMetaTags( $env, $expandedK, $wrapTemplates );
							$expandedK = $updatedK->value;
						}

						$expandedA->k = $expandedK;

						// Check if we need to deal with the Reparse-KV-string scenario.
						// (See documentation comment above)
						// So far, "standalone" mode is only for expanding template
						// targets, which by definition do not have values, so this
						// scenario doesn't apply.  It was wrongly being triggered
						// by the "#ifexpr" parser function, which can expect the
						// "=" equality operator.
						if ( $expandedA->v === '' && !$this->options->standalone ) {
							// Extract a parsable string from the token array.
							// Trim whitespace to ensure tokenizer isn't tripped up
							// by the presence of unnecessary whitespace.
							$kStr = trim( TokenUtils::tokensToString( $expandedK, false, [
										'unpackDOMFragments' => true,
										'env' => $env
									]
								)
							);
							$rule = ( $nlTkOkay ) ? 'generic_newline_attributes' : 'table_attributes';
							$kvs = ( preg_match( '/=/', $kStr ) ) ? $this->tokenizer->tokenizeAs( $kStr, $rule, /* sol */true ) : new Error( 'null' );
							if ( !( $kvs instanceof $Error ) ) {
								// At this point, templates should have been
								// expanded.  Returning a template token here
								// probably means that when we just converted to
								// string and reparsed, we put back together a
								// failed expansion.  This can be particularly bad
								// when we make iterative calls to expand template
								// names.
								$convertTemplates = function ( $p ) {
									return array_map( $p, function ( $t ) {
											if ( !TokenUtils::isTemplateToken( $t ) ) { return $t;
								   }
											return $t->dataAttribs->src;
									}
									);
								};
								$kvs->forEach( function ( $kv ) use ( &$convertTemplates, &$expandedA ) {
										if ( is_array( $kv->k ) ) {
											$kv->k = $convertTemplates( $kv->k );
										}
										if ( is_array( $kv->v ) ) {
											$kv->v = $convertTemplates( $kv->v );
										}
										// These `kv`s come from tokenizing the string
										// we produced above, and will therefore have
										// offset starting at zero.  Shift them by the
										// old amount if available.
										if ( is_array( $expandedA->srcOffsets ) ) {
											$offset = $expandedA->srcOffsets[ 0 ];
											if ( is_array( $kv->srcOffsets ) ) {
												$kv->srcOffsets = array_map( $kv->srcOffsets, function ( $n ) {
														$n += $offset;
														return $n;
												}
												);
											}
										}
								}
								);
								// SSS FIXME: Collect all keys here, not just the first key
								// i.e. in a string like {{echo|1=id='v1' title='foo' style='..'}}
								// that string is setting attributes for [id, title, style], not just id.
								//
								// That requires the ability for the data-mw.attribs[i].txt to be an array.
								// However, the spec at [[mw:Parsoid/MediaWiki_DOM_spec]] says:
								// "This spec also assumes that a template can only
								// generate one attribute rather than multiple attributes."
								//
								// So, revision of the spec is another FIXME at which point this code can
								// be updated to reflect the revised spec.
								$expandedK = $kvs[ 0 ]->k;
								$reparsedKV = true;
								if ( !$newAttrs ) {
									$newAttrs = ( $i === 0 ) ? [] : array_slice( $expandedAttrs, 0, $i/*CHECK THIS*/ );
								}
								$newAttrs = $newAttrs->concat( $kvs );
							}
						}
					}
				}

				// We have a potentially expanded value.
				// Check if the value came from a template/extension expansion.
				$attrValTokens = $origV;
				if ( $expandedK->constructor === $String && is_array( $oldA->v ) ) {
					if ( !preg_match( '/^mw:/', $expandedK ) ) {
						$nlTkPos = self::nlTkIndex( $nlTkOkay, $attrValTokens, $wrapTemplates );
						if ( $nlTkPos !== -1 ) {
							// Scenario 1 from the documentation comment above.
							$updatedV = self::splitTokens( $env, $token, $nlTkPos, $attrValTokens, $wrapTemplates );
							$attrValTokens = $updatedV->preNLBuf;
							$postNLToks = $updatedV->postNLBuf;
							$metaTokens = $updatedV->metaTokens;
						} else {
							// Scenario 2 from the documentation comment above.
							$updatedV = self::stripMetaTags( $env, $attrValTokens, $wrapTemplates );
							$attrValTokens = $updatedV->value;
						}
						$expandedA->v = $attrValTokens;
					}
				}

				// Update data-mw to account for templated attributes.
				// For editability, set HTML property.
				//
				// If we encountered a reparse-KV-string scenario,
				// we set the value's HTML to [] since we can edit
				// the transclusion either via the key's HTML or the
				// value's HTML, but not both.
				if ( ( $reparsedKV && ( $updatedK->hasGeneratedContent || count( $metaTokens ) > 0 ) )
|| ( $updatedK && $updatedK->hasGeneratedContent )
|| ( $updatedV && $updatedV->hasGeneratedContent )
				) {
					$key = ( $expandedK->constructor === $String ) ? $expandedK : TokenUtils::tokensToString( $expandedK );
					if ( !$tmpDataMW ) {
						$tmpDataMW = new Map();
					}
					$tmpDataMW->set( $key, [
							'k' => [
								'txt' => $key,
								'html' => ( $reparsedKV || ( $updatedK && $updatedK->hasGeneratedContent ) ) ? $origK : null
							],
							'v' => [
								'html' => ( $reparsedKV ) ? [] : $origV
							]
						]
					);
				}
			}

			// Update newAttrs
			if ( $newAttrs && !$reparsedKV ) {
				$newAttrs[] = $expandedA;
			}
		}

		$token->attribs = $newAttrs || $expandedAttrs;

		// If the token already has an about, it already has transclusion/extension
		// wrapping. No need to record information about templated attributes in addition.
		//
		// FIXME: If there is a real use case for extension attributes getting
		// templated, this check can be relaxed to allow that.
		// https://gerrit.wikimedia.org/r/#/c/65575 has some reference code that
		// can be used then.

		if ( !$token->getAttribute( 'about' ) && $tmpDataMW && $tmpDataMW->size > 0 ) {

			// Flatten k-v pairs.
			$vals = [];
			$tmpDataMW->forEach( function ( $obj ) use ( &$vals ) {
					array_push( $vals, $obj->k, $obj->v );
			}
			);

			// Async-expand all token arrays to DOM.
			$eVals = /* await */ PipelineUtils::expandValuesToDOM(
				$this->manager->env, $this->manager->frame, $vals,
				$this->options->expandTemplates,
				$this->options->inTemplate
			);

			// Rebuild flattened k-v pairs.
			$expAttrs = [];
			for ( $j = 0;  $j < count( $eVals );  $j += 2 ) {
				$expAttrs[] = [ $eVals[ $j ], $eVals[ $j + 1 ] ];
			}

			if ( $token->name === 'template' ) {
				// Don't add Parsoid about, typeof, data-mw attributes here since
				// we won't be able to distinguish between Parsoid-added attributes
				// and actual template attributes in cases like:
				// {{some-tpl|about=#mwt1|typeof=mw:Transclusion}}
				// In both cases, we will encounter a template token that looks like:
				// { ... "attribs":[{"k":"about","v":"#mwt1"},{"k":"typeof","v":"mw:Transclusion"}] .. }
				// So, record these in the tmp attribute for the template hander
				// to retrieve and process.
				if ( !$token->dataAttribs->tmp ) {
					$token->dataAttribs->tmp = [];
				}
				$token->dataAttribs->tmp->templatedAttribs = $expAttrs;
			} else {
				// Mark token as having expanded attrs.
				$token->addAttribute( 'about', $this->manager->env->newAboutId() );
				$token->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );
				$token->addAttribute( 'data-mw', json_encode( [
							'attribs' => $expAttrs
						]
					)

				);
			}
		}

		$newTokens = $metaTokens->concat( [ $token ], $postNLToks );
		if ( count( $metaTokens ) === 0 ) {
			// No more attribute expansion required for token after this
			$newTokens->rank = self::skipRank();
		}

		return [ 'tokens' => $newTokens ];
	}
}
// This is clunky, but we don't have async/await until Node >= 7 (T206035)
AttributeExpander::prototype::buildExpandedAttrs =
/* async */AttributeExpander::prototype::buildExpandedAttrsG;

if ( gettype( $module ) === 'object' ) {
	$module->exports->AttributeExpander = $AttributeExpander;
}
