<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Template and template argument handling, first cut.
 *
 * AsyncTokenTransformManager objects provide preprocessor-frame-like
 * functionality once template args etc are fully expanded, and isolate
 * individual transforms from concurrency issues. Template expansion is
 * controlled using a tplExpandData structure created independently for each
 * handled template tag.
 * @module
 */

namespace Parsoid;

use Parsoid\AttributeExpander as AttributeExpander;
use Parsoid\ContentUtils as ContentUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\Params as Params;
use Parsoid\ParserFunctions as ParserFunctions;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\Promise as Promise;
use Parsoid\TemplateRequest as TemplateRequest;
use Parsoid\TokenTransformManager as TokenTransformManager;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\NlTk as NlTk;
use Parsoid\EOFTk as EOFTk;
use Parsoid\CommentTk as CommentTk;

$AttributeTransformManager = TokenTransformManager\AttributeTransformManager;
$TokenAccumulator = TokenTransformManager\TokenAccumulator;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class TemplateHandler extends TokenHandler {
	public static function RANK() {
 return 1.1;
 }

	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		// Set this here so that it's available in the TokenStreamPatcher,
		// which continues to inherit from TemplateHandler.
		$this->parserFunctions = new ParserFunctions( $this->env );
		$this->ae = null;
		if ( $options->tsp ) { return; /* don't register handlers */
  }
		// Register for template and templatearg tag tokens
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onTemplate( $token, $cb );
   },
			'TemplateHandler:onTemplate', TemplateHandler\RANK(), 'tag', 'template'
		);
		// Template argument expansion
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onTemplateArg( $token, $cb );
   },
			'TemplateHandler:onTemplateArg', TemplateHandler\RANK(), 'tag', 'templatearg'
		);
		$this->ae = new AttributeExpander( $this->manager, [ 'standalone' => true, 'expandTemplates' => true ] );
	}
	public $parserFunctions;

	public $ae;

	/**
	 * Main template token handler.
	 *
	 * Expands target and arguments (both keys and values) and either directly
	 * calls or sets up the callback to _expandTemplate, which then fetches and
	 * processes the template.
	 */
	public function onTemplate( $token, $cb ) {
		$toks = null;

		function hasTemplateToken( $tokens ) use ( &$TokenUtils ) {
			return is_array( $tokens )
&& $tokens->some( function ( $t ) use ( &$TokenUtils ) { return TokenUtils::isTemplateToken( $t );
} );
		}

		// If the template name is templated, use the attribute transform manager
		// to process all attributes to tokens, and force reprocessing of the token.
		if ( hasTemplateToken( $token->attribs[ 0 ]->k ) ) {
			$cb( [ 'async' => true ] );
			$this->ae->onToken( $token, function ( $ret ) use ( &$cb ) {
					if ( $ret->tokens ) {
						// Force reprocessing of the token by demoting its rank.
						//
						// Note that there's some hacky code in the attribute expander
						// to try and prevent it from returning templates in the
						// expanded attribs.  Otherwise, we can find outselves in a loop
						// here, where `hasTemplateToken` continuously returns true.
						//
						// That was happening when a template name depending on a top
						// level templatearg failed to expand.
						$ret->tokens->rank = TemplateHandler\RANK() - 0.0001;
					}
					$cb( $ret );
			}
			);
			return;
		}

		$env = $this->env;
		$text = $token->dataAttribs->src;
		$state = [
			'token' => $token,
			'wrapperType' => 'mw:Transclusion',
			'wrappedObjectId' => $env->newObjectId(),
			'srcCB' => $this->_startTokenPipeline
		];

		$tgt = $this->resolveTemplateTarget( $state, $token->attribs[ 0 ]->k );
		if ( $tgt && $tgt->magicWordType ) {
			$toks = $this->processSpecialMagicWord( $token, $tgt );
			Assert::invariant( $toks !== null );
			$cb( [ 'tokens' => ( is_array( $toks ) ) ? $toks : [ $toks ] ] );
			return;
		}

		if ( $this->options->expandTemplates && $tgt === null ) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			$this->convertAttribsToString( $state, $token->attribs, $cb );
			return;
		}

		$accum = null;
		$accumReceiveToksFromSibling = null;
		$accumReceiveToksFromChild = null;

		if ( $env->conf->parsoid->usePHPPreProcessor ) {
			if ( $this->options->expandTemplates ) {
				// Use MediaWiki's action=expandtemplates preprocessor
				//
				// The tokenizer needs to use `text` as the cache key for caching
				// expanded tokens from the expanded transclusion text that we get
				// from the preprocessor, since parameter substitution will already
				// have taken place.
				//
				// It's sufficient to pass `[]` in place of attribs since they
				// won't be used.  In `usePHPPreProcessor`, there is no parameter
				// substitution coming from the frame.

				$templateName = $tgt->target;
				$attribs = [];

				// We still need to check for limit violations because of the
				// higher precedence of extension tags, which can result in nested
				// templates even while using the php preprocessor for expansion.
				$checkRes = $this->checkRes( $templateName, true );
				if ( is_array( $checkRes ) ) {
					$cb( [ 'tokens' => $checkRes ] );
					return;
				}

				// Check if we have an expansion for this template in the cache already
				$cachedTransclusion = $env->transclusionCache[ $text ];
				if ( $cachedTransclusion ) {
					// cache hit: reuse the expansion DOM
					// FIXME(SSS): How does this work again for
					// templates like {{start table}} and {[end table}}??
					$toks = PipelineUtils::encapsulateExpansionHTML( $env, $token, $cachedTransclusion, [
							'fromCache' => true
						]
					);
					$cb( [ 'tokens' => $toks ] );
				} else {
					// Use a TokenAccumulator to divide the template processing
					// in two parts: The child part will take care of the main
					// template element (including parameters) and the sibling
					// will process the returned template expansion
					$accum = new TokenAccumulator( $this->manager, $cb );
					$accumReceiveToksFromSibling = $accum->receiveToksFromSibling->bind( $accum );
					$accumReceiveToksFromChild = $accum->receiveToksFromChild->bind( $accum );
					$srcHandler = $state->srcCB->bind(
						$this, $state,
						$accumReceiveToksFromSibling,
						[ 'name' => $templateName, 'attribs' => $attribs ]
					);

					// Process the main template element
					$this->_encapsulateTemplate( $state,
						$accumReceiveToksFromChild
					);
					// Fetch and process the template expansion
					$this->fetchExpandedTpl( $env->page->name || '',
						$text, $accumReceiveToksFromSibling, $srcHandler
					);
				}
			} else {
				// We don't perform recursive template expansion- something
				// template-like that the PHP parser did not expand. This is
				// encapsulated already, so just return the plain text.
				Assert::invariant( TokenUtils::isTemplateToken( $token ) );
				$this->convertAttribsToString( $state, $token->attribs, $cb );
				return;
			}
		} else {
			if ( $this->options->expandTemplates ) {
				// Use a TokenAccumulator to divide the template processing
				// in two parts: The child part will take care of the main
				// template element (including parameters) and the sibling
				// will do the template expansion
				$accum = new TokenAccumulator( $this->manager, $cb );
				// console.warn("onTemplate created TA-" + accum.uid);
				$accumReceiveToksFromSibling = $accum->receiveToksFromSibling->bind( $accum );
				$accumReceiveToksFromChild = $accum->receiveToksFromChild->bind( $accum );

				// Process the main template element
				$this->_encapsulateTemplate( $state,
					$accum->receiveToksFromChild->bind( $accum )
				);
			} else {
				// Don't wrap templates, so we don't need to use the
				// TokenAccumulator and can return the expansion directly
				$accumReceiveToksFromSibling = $cb;
			}

			$accumReceiveToksFromSibling( [ 'tokens' => [], 'async' => true ] );

			// expand argument keys, with callback set to next processing step
			// XXX: would likely be faster to do this in a tight loop here
			$atm = new AttributeTransformManager(
				$this->manager,
				[ 'expandTemplates' => false, 'inTemplate' => true ]
			);
			( $atm->process( $token->attribs )->promises || Promise::resolve() )->then(
				function () use ( &$state, &$tgt, &$accumReceiveToksFromSibling, &$atm, &$token ) {return $this->_expandTemplate( $state, $tgt, $accumReceiveToksFromSibling, $atm->getNewKVs( $token->attribs ) );
	   }
			)->done();
		}
	}

	/**
	 * Parser functions also need template wrapping.
	 */
	public function _parserFunctionsWrapper( $state, $cb, $ret ) {
		if ( $ret->tokens ) {
			// This is only for the Parsoid native expansion pipeline used in
			// parser tests. The "" token sometimes changes foster parenting
			// behavior and trips up some tests.
			$i = 0;
			while ( $i < count( $ret->tokens ) ) {
				if ( $ret->tokens[ $i ] === '' ) {
					array_splice( $ret->tokens, $i, 1 );
				} else {
					$i++;
				}
			}
			// token chunk should be flattened
			Assert::invariant( is_array( $ret->tokens ) );
			Assert::invariant( $ret->tokens->every( function ( $el ) {return !is_array( $el );
   } ) );
			$this->_onChunk( $state, $cb, $ret->tokens );
		}
		if ( !$ret->async ) {
			// Now, ready to finish up
			$this->_onEnd( $state, $cb );
		}
	}

	public function encapTokens( $state, $tokens, $extraDict ) {
		$toks = $this->getEncapsulationInfo( $state, $tokens );
		$toks[] = $this->getEncapsulationInfoEndTag( $state );
		if ( !$this->options->inTemplate ) {
			$argInfo = $this->getArgInfo( $state );
			if ( $extraDict ) { Object::assign( $argInfo->dict, $extraDict );
   }
			$toks[ 0 ]->dataAttribs->tmp->tplarginfo = json_encode( $argInfo );
		}
		return $toks;
	}

	/**
	 * Process the special magic word as specified by `resolvedTgt.magicWordType`.
	 * ```
	 * magicWordType === '!'    => {{!}} is the magic word
	 * magicWordtype === 'MASQ' => DEFAULTSORT, DISPLAYTITLE are the magic words
	 *                             (Util.magicMasqs.has(..))
	 * ```
	 */
	public function processSpecialMagicWord( $tplToken, $resolvedTgt ) {
		$env = $this->manager->env;

		// Special case for {{!}} magic word.  Note that this is only necessary
		// because of the call from the TokenStreamPatcher.  Otherwise, ! is a
		// variable like any other and can be dropped from this function.
		// However, we keep both cases flowing through here for consistency.
		if ( ( $resolvedTgt && $resolvedTgt->magicWordType === '!' ) || $tplToken->attribs[ 0 ]->k === '!' ) {
			// If we're not at the top level, return a table cell. This will always
			// be the case. Either {{!}} was tokenized as a td, or it was tokenized
			// as template but the recursive call to fetch its content returns a
			// single | in an ambiguous context which will again be tokenized as td.
			if ( !$this->atTopLevel ) {
				return [ new TagTk( 'td' ) ];
			}
			$state = [
				'token' => $tplToken,
				'wrapperType' => 'mw:Transclusion',
				'wrappedObjectId' => $env->newObjectId()
			];
			$this->resolveTemplateTarget( $state, '!' );
			return $this->encapTokens( $state, [ '|' ] );
		}

		if ( !$resolvedTgt || $resolvedTgt->magicWordType !== 'MASQ' ) {
			// Nothing to do
			return null;
		}

		$magicWord = strtolower( $resolvedTgt->prefix );
		$pageProp = 'mw:PageProp/';
		if ( $magicWord === 'defaultsort' ) {
			$pageProp += 'category';
		}
		$pageProp += $magicWord;

		$metaToken = new SelfclosingTagTk( 'meta',
			[ new KV( 'property', $pageProp ) ],
			Util::clone( $tplToken->dataAttribs )
		);

		if ( ( $tplToken->dataAttribs->tmp || [] )->templatedAttribs ) {
			// No shadowing if templated
			//
			// SSS FIXME: post-tpl-expansion, WS won't be trimmed. How do we handle this?
			$metaToken->addAttribute( 'content', $resolvedTgt->pfArgToks );
			$metaToken->addAttribute( 'about', $env->newAboutId() );
			$metaToken->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );

			// See [[mw:Specs/HTML/1.4.0#Transclusion-affected_attributes]]
			//
			// For every attribute that has a templated name and/or value,
			// AttributeExpander creates a 2-item array for that attribute.
			// [ {txt: '..', html: '..'}, { html: '..'} ]
			// 'txt' is the plain-text name/value
			// 'html' is the HTML-version of the name/value
			//
			// Massage the templated magic-word info into a similar format.
			// In this case, the attribute name is 'content' (implicit) and
			// since it is implicit, the name itself cannot be attribute.
			// Hence 'html' property is empty.
			//
			// The attribute value has been templated and is encoded there.
			//
			// NOTE: If any part of the 'MAGIC_WORD:value' string is templated,
			// we consider the magic word as having expanded attributes, rather
			// than only when the 'value' part of it. This is because of the
			// limitation of our token representation for templates. This is
			// an edge case that it is not worth a refactoring right now to
			// handle this properly and choose mw:Transclusion or mw:ExpandedAttrs
			// depending on which part is templated.
			//
			// FIXME: Is there a simpler / better repn. for templated attrs?
			$ta = $tplToken->dataAttribs->tmp->templatedAttribs;
			$ta[ 0 ][ 0 ]->txt = 'content'; // Magic-word attribute name
			$ta[ 0 ][ 1 ]->html = $ta[ 0 ][ 0 ]->html; // HTML repn. of the attribute value
			$ta[ 0 ][ 0 ]->html = null;
			$metaToken->addAttribute( 'data-mw', json_encode( [ 'attribs' => $ta ] ) );
		} else {
			// Leading/trailing WS should be stripped
			$key = trim( $resolvedTgt->pfArg );

			$src = ( $tplToken->dataAttribs || [] )->src;
			if ( $src ) {
				// If the token has original wikitext, shadow the sort-key
				$origKey = preg_replace( '/}}$/', '', preg_replace( '/[^:]+:?/', '', $src, 1 ), 1 );
				$metaToken->addNormalizedAttribute( 'content', $key, $origKey );
			} else {
				// If not, this token came from an extension/template
				// in which case, dont bother with shadowing since the token
				// will never be edited directly.
				$metaToken->addAttribute( 'content', $key );
			}
		}
		return $metaToken;
	}

	public function resolveTemplateTarget( $state, $targetToks ) {
		function toStringOrNull( $tokens ) use ( &$TokenUtils, &$SelfclosingTagTk, &$TagTk, &$EndTagTk, &$CommentTk, &$NlTk ) {
			$maybeTarget = TokenUtils::tokensToString( TokenUtils::stripIncludeTokens( $tokens ), true, [ 'retainNLs' => true ] );
			if ( is_array( $maybeTarget ) ) {
				$buf = $maybeTarget[ 0 ];
				$tgtTokens = $maybeTarget[ 1 ];
				$preNlContent = null;
				for ( $i = 0,  $l = count( $tgtTokens );  $i < $l;  $i++ ) {
					$ntt = $tgtTokens[ $i ];
					switch ( $ntt->constructor ) {
						case $String:
						$buf += $ntt;
						break;

						case SelfclosingTagTk::class:
						// Quotes are valid template targets
						if ( $ntt->name === 'mw-quote' ) {
							$buf += $ntt->getAttribute( 'value' );
						} elseif ( !TokenUtils::isEmptyLineMetaToken( $ntt )
&& $ntt->name !== 'template'
&& $ntt->name !== 'templatearg'
						) {
							// We are okay with empty (comment-only) lines,
							// {{..}} and {{{..}}} in template targets.
							return null;
						}
						break;

						case TagTk::class:

						case EndTagTk::class:
						return null;

						case CommentTk::class:
						// Ignore comments as well
						break;

						case NlTk::class:
						// Ignore only the leading or trailing newlnes
						// (module whitespace and comments)

						// empty target .. ignore nl
						if ( preg_match( '/^\s*$/', $buf ) ) {
							break;
						} elseif ( !$preNlContent ) {
							// Buffer accumulated content
							$preNlContent = $buf;
							$buf = '';
							break;
						} else {
							return null;
						}

						default:
						Assert::invariant( false, 'Unexpected token type: ' . $ntt->constructor );
					}
				}

				if ( $preNlContent && !preg_match( '/^\s*$/', $buf ) ) {
					// intervening newline makes this an invalid target
					return null;
				} else {
					// all good! only whitespace/comments post newline
					return ( $preNlContent || '' ) + $buf;
				}
			} else {
				return $maybeTarget;
			}
		}

		// Normalize to an array
		$targetToks = ( !is_array( $targetToks ) ) ? [ $targetToks ] : $targetToks;

		$env = $this->manager->env;
		$wiki = $env->conf->wiki;
		$isTemplate = true;
		$target = toStringOrNull( $targetToks );
		if ( $target === null ) {
			// Retry with a looser attempt to convert tokens to a string.
			// This lenience only applies to parser functions.
			$isTemplate = false;
			$target = TokenUtils::tokensToString( TokenUtils::stripIncludeTokens( $targetToks ) );
		}

		// safesubst found in content should be treated as if no modifier were
		// present.  See https://en.wikipedia.org/wiki/Help:Substitution#The_safesubst:_modifier
		$target = preg_replace( '/^safesubst:/', '', trim( $target ), 1 );

		$pieces = explode( ':', $target );
		$prefix = trim( $pieces[ 0 ] );
		$lowerPrefix = strtolower( $prefix );
		// The check for pieces.length > 1 is require to distinguish between
		// {{lc:FOO}} and {{lc|FOO}}.  The latter is a template transclusion
		// even though the target (=lc) matches a registered parser-function name.
		$isPF = count( $pieces ) > 1;

		// Check if we have a parser function
		$canonicalFunctionName =
		$wiki->functionHooks->get( $prefix ) || $wiki->functionHooks->get( $lowerPrefix )
|| $wiki->variables->get( $prefix ) || $wiki->variables->get( $lowerPrefix );

		if ( $canonicalFunctionName !== null ) {
			// Extract toks that make up pfArg
			$pfArgToks = null;
			$re = new RegExp( '^(.*?)' . $prefix, 'i' );

			// Because of the lenient stringifying above, we need to find the
			// prefix.  The strings we've seen so far are buffered in case they
			// combine to our prefix.  FIXME: We need to account for the call
			// to TokenUtils.stripIncludeTokens above and the safesubst replace.
			$buf = '';
			$i = $targetToks->findIndex( function ( $t ) use ( &$re, &$prefix ) {
					if ( gettype( $t ) !== 'string' ) { return false;
		   }
					$buf += $t;
					$match = $re->exec( $buf );
					if ( $match ) {
						// Check if they combined
						$offset = count( $buf ) - count( $t ) - count( $match[ 1 ] );
						if ( $offset > 0 ) {
							$re = new RegExp( '^' . $prefix->substring( $offset ), 'i' );
						}
						return true;
					}
					return false;
			}
			);

			if ( $i > -1 ) {
				// Strip parser-func / magic-word prefix
				$firstTok = str_replace( $re, '', $targetToks[ $i ] );
				$targetToks = array_slice( $targetToks, $i + 1 );

				if ( $isPF ) {
					// Strip ":", again, after accounting for the lenient stringifying
					while ( count( $targetToks ) > 0
&& ( gettype( $firstTok ) !== 'string' || preg_match( '/^\s*$/', $firstTok ) )
					) {
						$firstTok = $targetToks[ 0 ];
						$targetToks = array_slice( $targetToks, 1 );
					}
					Assert::invariant( gettype( $firstTok ) === 'string' && preg_match( '/^\s*:/', $firstTok ),
						'Expecting : in parser function definiton'
					);
					$pfArgToks = [ preg_replace( '/^\s*:/', '', $firstTok, 1 ) ]->concat( $targetToks );
				} else {
					$pfArgToks = [ $firstTok ]->concat( $targetToks );
				}
			}

			if ( $pfArgToks === null ) {
				// FIXME: Protect from crashers by using the full token -- this is
				// still going to generate incorrect output, but it won't crash.
				$pfArgToks = $targetToks;
			}

			$state->parserFunctionName = $canonicalFunctionName;

			$magicWordType = null;
			if ( $canonicalFunctionName === '!' ) {
				$magicWordType = '!';
			} elseif ( Util::magicMasqs::has( $canonicalFunctionName ) ) {
				$magicWordType = 'MASQ';
			}

			return [
				'isPF' => true,
				'prefix' => $canonicalFunctionName,
				'magicWordType' => $magicWordType,
				'target' => 'pf_' . $canonicalFunctionName,
				'pfArg' => substr( $target, count( $prefix ) + 1 ),
				'pfArgToks' => $pfArgToks
			];
		}

		if ( !$isTemplate ) { return null;
  }

		// `resolveTitle()` adds the namespace prefix when it resolves fragments
		// and relative titles, and a leading colon should resolve to a template
		// from the main namespace, hence we omit a default when making a title
		$namespaceId = ( preg_match( '/^[:#\/\.]/', $target ) ) ?
		null : $wiki->canonicalNamespaces->template;

		// Resolve a possibly relative link and
		// normalize the target before template processing.
		$title = null;
		try {
			$title = $env->resolveTitle( $target );
		} catch ( Exception $e ) {
			// Invalid template target!
			return null;
		}

		// Entities in transclusions aren't decoded in the PHP parser
		// So, treat the title as a url-decoded string!
		$title = $env->makeTitleFromURLDecodedStr( $title, $namespaceId, true );
		if ( !$title ) {
			// Invalid template target!
			return null;
		}

		// data-mw.target.href should be a url
		$state->resolvedTemplateTarget = $env->makeLink( $title );

		return [
			'isPF' => false,
			'magicWordType' => null,
			'target' => $title->getPrefixedDBKey()
		];
	}

	public function convertAttribsToString( $state, $attribs, $cb ) {
		$cb( [ 'tokens' => [], 'async' => true ] );

		// Re-join attribute tokens with '=' and '|'
		$attribTokens = [];
		$attribs->forEach( function ( $kv ) use ( &$TokenUtils ) {
				if ( $kv->k ) {
					$attribTokens = TokenUtils::flattenAndAppendToks( $attribTokens, null, $kv->k );
				}
				if ( $kv->v ) {
					$attribTokens = TokenUtils::flattenAndAppendToks( $attribTokens,
						( $kv->k ) ? '=' : '',
						$kv->v
					);
				}
				$attribTokens[] = '|';
		}
		);
		// pop last pipe separator
		array_pop( $attribTokens );

		$tokens = [ '{{' ]->concat( $attribTokens, [ '}}', new EOFTk() ] );

		// Process exploded token in a new pipeline
		$tplHandler = $this;
		$newTokens = [];
		$endCB = function () use ( &$state, &$tplHandler, &$cb ) {
			$hasTemplatedTarget = (bool)( $state->token->dataAttribs->tmp || [] )->templatedAttribs;
			if ( $hasTemplatedTarget ) {
				// Add encapsulation if we had a templated target
				// FIXME: This is a deliberate wrapping of the entire
				// "broken markup" where one or more templates are nested
				// inside invalid transclusion markup. The proper way to do
				// this would be to disentangle everything and identify
				// transclusions and wrap them individually with meta tags
				// and data-mw info. But, this is an edge case which can be
				// more readily fixed by fixing the markup. The goal here is
				// to ensure that the output renders properly and it roundtrips
				// without dirty diffs rather then faithful DOMspec representation.
				$newTokens = $tplHandler->encapTokens( $state, $newTokens );
			}

			$newTokens->rank = TemplateHandler\RANK(); // Assign the correct rank to the tokens
			$cb( [ 'tokens' => $newTokens ] );
		};
		PipelineUtils::processContentInPipeline(
			$this->manager->env,
			$this->manager->frame,
			$tokens,
			[
				'pipelineType' => 'tokens/x-mediawiki',
				'pipelineOpts' => [
					'expandTemplates' => $this->options->expandTemplates
				],
				'chunkCB' => function ( $chunk ) use ( &$TokenUtils ) {
					// SSS FIXME: This pattern of attempting to strip
					// EOFTk from every chunk is a bit ugly, but unavoidable
					// since EOF token comes with the entire chunk rather
					// than coming through the end event callback.
					$newTokens = $newTokens->concat( TokenUtils::stripEOFTkfromTokens( $chunk ) );
				},
				'endCB' => $endCB,
				'sol' => true
			]
		);
	}

	/**
	 * checkRes
	 */
	public function checkRes( $target, $ignoreLoop ) {
		$checkRes = $this->manager->frame->loopAndDepthCheck( $target, $this->env->conf->parsoid->maxDepth, $ignoreLoop );
		if ( $checkRes ) {
			// Loop detected or depth limit exceeded, abort!
			$res = [
				$checkRes,
				new TagTk( 'a', [ [ 'k' => 'href', 'v' => $target ] ] ),
				$target,
				new EndTagTk( 'a' )
			];
			return $res;
		}
	}

	/**
	 * Fetch, tokenize and token-transform a template after all arguments and the
	 * target were expanded.
	 */
	public function _expandTemplate( $state, $resolvedTgt, $cb, $attribs ) {
		$env = $this->manager->env;
		$target = $attribs[ 0 ]->k;

		if ( !$target ) {
			$env->log( 'debug', 'No target! ', $attribs );
		}

		if ( !$state->resolveTemplateTarget ) {
			// We couldn't get the proper target before going through the
			// AttributeTransformManager, so try again now
			$resolvedTgt = $this->resolveTemplateTarget( $state, $target );
			if ( $resolvedTgt === null ) {
				// Target contains tags, convert template braces and pipes back into text
				// Re-join attribute tokens with '=' and '|'
				$this->convertAttribsToString( $state, $attribs, $cb );
				return;
			}
		}

		// TODO:
		// check for 'subst:'
		// check for variable magic names
		// check for msg, msgnw, raw magics
		// check for parser functions

		// XXX: wrap attribs in object with .dict() and .named() methods,
		// and each member (key/value) into object with .tokens(), .dom() and
		// .wikitext() methods (subclass of Array)

		$res = null;
		$target = $resolvedTgt->target;
		if ( $resolvedTgt->isPF ) {
			// FIXME: Parsoid may not have implemented the parser function natively
			// Emit an error message, but encapsulate it so it roundtrips back.
			if ( !$this->parserFunctions[ $target ] ) {
				$res = [ 'Parser function implementation for ' . $target . ' missing in Parsoid.' ];
				$res->rank = TemplateHandler\RANK();
				if ( $this->options->expandTemplates ) {
					$res[] = $this->getEncapsulationInfoEndTag( $state );
				}
				$cb( [ 'tokens' => $res ] );
				return;
			}

			$pfAttribs = new Params( $attribs );
			$pfAttribs[ 0 ] = new KV( $resolvedTgt->pfArg, [] );
			$env->log( 'debug', 'entering prefix', $target, $state->token );
			$newCB = null;
			if ( $this->options->expandTemplates ) {
				$newCB = function ( $ret ) use ( &$state, &$cb ) {return $this->_parserFunctionsWrapper( $state, $cb, $ret );
	   };
			} else {
				$newCB = $cb;
			}
			$this->parserFunctions[ $target ]( $state->token, $this->manager->frame, $newCB, $pfAttribs );
			return;
		}

		// Loop detection needs to be enabled since we're doing our own template
		// expansion
		$checkRes = $this->checkRes( $target, false );
		if ( is_array( $checkRes ) ) {
			$checkRes->rank = $this->manager->phaseEndRank;
			$cb( [ 'tokens' => $checkRes ] );
			return;
		}

		// XXX: notes from brion's mediawiki.parser.environment
		// resolve template name
		// load template w/ canonical name
		// load template w/ variant names (language variants)

		// strip template target
		$attribs = array_slice( $attribs, 1 );

		// For now, just fetch the template and pass the callback for further
		// processing along.
		$srcHandler = $state->srcCB->bind(
			$this, $state, $cb,
			[ 'name' => $target, 'attribs' => $attribs ]
		);
		$this->_fetchTemplateAndTitle( $target, $cb, $srcHandler, $state );
	}

	/**
	 * Process a fetched template source to a token stream.
	 */
	public function _startTokenPipeline( $state, $cb, $tplArgs, $err, $src ) {
		// We have a choice between aborting or keeping going and reporting the
		// error inline.
		// TODO: report as special error token and format / remove that just
		// before the serializer. (something like <mw:error ../> as source)
		if ( $err ) {
			$src = '';
			// this.manager.env.errCB(err);
		}

		$psd = $this->manager->env->conf->parsoid;
		if ( $psd->dumpFlags && $psd->dumpFlags->has( 'tplsrc' ) ) {
			$console->warn( '='->repeat( 80 ) );
			$console->warn( 'TEMPLATE:', $tplArgs->name, '; TRANSCLUSION:', json_encode( $state->token->dataAttribs->src ) );
			$console->warn( '-'->repeat( 80 ) );
			$console->warn( $src );
			$console->warn( '-'->repeat( 80 ) );
		}

		$this->manager->env->log( 'debug', 'TemplateHandler._startTokenPipeline', $tplArgs->name, $tplArgs->attribs );

		// Get a nested transformation pipeline for the input type. The input
		// pipeline includes the tokenizer, synchronous stage-1 transforms for
		// 'text/wiki' input and asynchronous stage-2 transforms).
		PipelineUtils::processContentInPipeline(
			$this->manager->env,
			$this->manager->frame,
			$src,
			[
				'pipelineType' => 'text/x-mediawiki',
				'pipelineOpts' => [
					'inTemplate' => true,
					'isInclude' => true,
					// NOTE: No template wrapping required for nested templates.
					'expandTemplates' => false,
					'extTag' => $this->options->extTag
				],
				'tplArgs' => $tplArgs,
				'chunkCB' => function ( $chunk ) use ( &$state, &$cb ) {return $this->_onChunk( $state, $cb, $chunk );
	   },
				'endCB' => function () use ( &$state, &$cb ) {return $this->_onEnd( $state, $cb );
	   },
				'sol' => true
			]
		);
	}

	public function getEncapsulationInfo( $state, $chunk ) {
		// TODO
		// * only add this information for top-level includes, but track parameter
		// expansion in lower-level templates
		// * ref all tables to this (just add about)
		// * ref end token to this, add property="mw:Transclusion/End"

		$attrs = [
			new KV( 'typeof', $state->wrapperType ),
			new KV( 'about', '#' . $state->wrappedObjectId )
		];
		$dataParsoid = [
			'tsr' => Util::clone( $state->token->dataAttribs->tsr ),
			'src' => $state->token->dataAttribs->src,
			'tmp' => []
		]; // We'll add the arginfo here if necessary

		$meta = [ new SelfclosingTagTk( 'meta', $attrs, $dataParsoid ) ];
		$chunk = ( $chunk ) ? $meta->concat( $chunk ) : $meta;
		$chunk->rank = TemplateHandler\RANK();
		return $chunk;
	}

	public function getEncapsulationInfoEndTag( $state ) {
		$tsr = $state->token->dataAttribs->tsr;
		return new SelfclosingTagTk( 'meta', [
				new KV( 'typeof', $state->wrapperType . '/End' ),
				new KV( 'about', '#' . $state->wrappedObjectId )
			], [
				'tsr' => [ null, ( $tsr ) ? $tsr[ 1 ] : null ]
			]
		);
	}

	/**
	 * Parameter processing helpers.
	 */
	public static function _isSimpleParam( $tokens ) {
		$isSimpleToken = function ( $token ) use ( &$CommentTk, &$NlTk ) {
			return ( $token->constructor === $String
|| $token->constructor === CommentTk::class
|| $token->constructor === NlTk::class );
		};
		if ( !is_array( $tokens ) ) {
			return $isSimpleToken( $tokens );
		}
		return $tokens->every( $isSimpleToken );
	}

	// Add its HTML conversion to a parameter, and return a Promise which is
	// fulfilled when the conversion is complete.
	public static function getParamHTMLG( $manager, $paramData ) {
		$param = $paramData->param;
		$srcStart = $paramData->info->srcOffsets[ 2 ];
		$srcEnd = $paramData->info->srcOffsets[ 3 ];
		if ( $paramData->info->spc ) {
			$srcStart += count( $paramData->info->spc[ 2 ] );
			$srcEnd -= count( $paramData->info->spc[ 3 ] );
		}

		$html = /* await */ PipelineUtils::promiseToProcessContent(
			$manager->env, $manager->frame,
			$param->wt,
			[
				'pipelineType' => 'text/x-mediawiki/full',
				'pipelineOpts' => [
					'isInclude' => false,
					'expandTemplates' => true,
					// No need to do paragraph-wrapping here
					'inlineContext' => true
				],
				'srcOffsets' => [ $srcStart, $srcEnd ],
				'sol' => true
			]
		);
		// FIXME: We're better off setting a pipeline option above
		// to skip dsr computation to begin with.  Worth revisitting
		// if / when `addHTMLTemplateParameters` is enabled.
		// Remove DSR from children
		DOMUtils::visitDOM( $html->body, function ( $node ) use ( &$DOMUtils, &$DOMDataUtils ) {
				if ( !DOMUtils::isElt( $node ) ) { return;
	   }
				$dp = DOMDataUtils::getDataParsoid( $node );
				$dp->dsr = null;
		}
		);
		$param->html = ContentUtils::ppToXML( $html->body, [ 'innerXML' => true ] );
		return;
	}

	/**
	 * Process the main template element, including the arguments.
	 */
	public function _encapsulateTemplate( $state, $cb ) {
		$i = null;
$n = null;
		$env = $this->manager->env;
		$chunk = $this->getEncapsulationInfo( $state );

		// Template encapsulation normally wouldn't happen in nested context,
		// since they should have already been expanded, and indeed we set
		// expandTemplates === false in the srcCB, _startTokenPipeline.  However,
		// extension tags from templates can have content that requires wikitext
		// parsing and, due to precedence, contain unexpanded templates.
		//
		// For example, {{1x|hi<ref>{{1x|ho}}</ref>}}
		//
		// Since extensions can require template expansion unconditionally, we can
		// end up here inTemplate, in which case the substrings of env.page.src
		// used in getArgInfo are no longer accurate, and so tplarginfo should be
		// omitted.  Presumably, template wrapping in the dom post processor won't
		// be happening anyways, so this is unnecessary work as it is.
		if ( !$this->options->inTemplate ) {
			// Get the arg dict
			$argInfo = $this->getArgInfo( $state );
			$argDict = $argInfo->dict;

			if ( $env->conf->parsoid->addHTMLTemplateParameters ) {
				// Collect the parameters that need parsing into HTML, that is,
				// those that are not simple strings.
				// This optimizes for the common case where all are simple strings,
				// in which we don't need to go async.
				$params = [];
				for ( $i = 0, $n = count( $argInfo->paramInfos );  $i < $n;  $i++ ) {
					$paramInfo = $argInfo->paramInfos[ $i ];
					$param = $argDict->params[ $paramInfo->k ];
					$paramTokens = null;
					if ( $paramInfo->named ) {
						$paramTokens = $state->token->getAttribute( $paramInfo->k );
					} else {
						$paramTokens = $state->token->attribs[ $paramInfo->k ]->v;
					}

					// No need to pass through a whole sub-pipeline to get the
					// html if the param is either a single string, or if it's
					// just text, comments or newlines.
					if ( $paramTokens
&& ( $paramTokens->constructor === $String
|| self::isSimpleParam( $paramTokens ) )
					) {
						$param->html = $param->wt;
					} elseif ( preg_match( '/^https?:\/\/[^[\]{}\s]*$/', $param->wt ) ) {
						// If the param is just a simple URL, we can process it to
						// HTML directly without going through a sub-pipeline.
						$param->html = "<a rel='mw:ExtLink' href='" . preg_replace( "/'/", '&#39;', $param->wt )
. "'>" . $param->wt . '</a>';
					} else {
						// Prepare the data needed to parse to HTML
						$params[] = [
							'param' => $param,
							'info' => $paramInfo,
							'tokens' => $paramTokens
						];
					}
				}

				if ( count( $params ) ) {
					// TODO: We could avoid going async by checking if all params are strings
					// and, in that case returning them immediately.
					$cb( [ 'tokens' => [], 'async' => true ] );
					Promise::all( array_map( $params,
							function ( $paramData ) {return TemplateHandler::_getParamHTML( $this->manager, $paramData );
				   }
						)

					)->
					then( function () use ( &$chunk, &$env, &$cb ) {
							// Use a data-attribute to prevent the sanitizer from stripping this
							// attribute before it reaches the DOM pass where it is needed.
							$chunk[ 0 ]->dataAttribs->tmp->tplarginfo = json_encode( $argInfo );
							$env->log( 'debug', 'TemplateHandler._encapsulateTemplate', $chunk );
							$cb( [ 'tokens' => $chunk ] );
					}
					)->done();
					return;
				} else {
					$chunk[ 0 ]->dataAttribs->tmp->tplarginfo = json_encode( $argInfo );
				}
			} else {
				// Don't add the HTML template parameters, just use their wikitext
				$chunk[ 0 ]->dataAttribs->tmp->tplarginfo = json_encode( $argInfo );
			}
		}

		$env->log( 'debug', 'TemplateHandler._encapsulateTemplate', $chunk );
		$cb( [ 'tokens' => $chunk ] );
	}

	/**
	 * Handle chunk emitted from the input pipeline after feeding it a template.
	 */
	public function _onChunk( $state, $cb, $chunk ) {
		$chunk = TokenUtils::stripEOFTkfromTokens( $chunk );

		$i = null;
$n = null;
		for ( $i = 0, $n = count( $chunk );  $i < $n;  $i++ ) {
			if ( $chunk[ $i ] && $chunk[ $i ]->dataAttribs && $chunk[ $i ]->dataAttribs->tsr ) {
				$chunk[ $i ]->dataAttribs->tsr = null;
			}
			$t = $chunk[ $i ];
			if ( $t->constructor === SelfclosingTagTk::class
&& strtolower( $t->name ) === 'meta'
&& $t->getAttribute( 'typeof' ) === 'mw:Placeholder'
			) {
				// replace with empty string to avoid metas being foster-parented out
				$chunk[ $i ] = '';
			}
		}

		if ( !$this->options->expandTemplates ) {
			// Ignore comments in template transclusion mode
			$newChunk = [];
			for ( $i = 0, $n = count( $chunk );  $i < $n;  $i++ ) {
				if ( $chunk[ $i ]->constructor !== CommentTk::class ) {
					$newChunk[] = $chunk[ $i ];
				}
			}
			$chunk = $newChunk;
		}

		$this->manager->env->log( 'debug', 'TemplateHandler._onChunk', $chunk );
		$chunk->rank = TemplateHandler\RANK();
		$cb( [ 'tokens' => $chunk, 'async' => true ] );
	}

	/**
	 * Handle the end event emitted by the parser pipeline after fully processing
	 * the template source.
	 */
	public function _onEnd( $state, $cb ) {
		$this->manager->env->log( 'debug', 'TemplateHandler._onEnd' );
		if ( $this->options->expandTemplates ) {
			$endTag = $this->getEncapsulationInfoEndTag( $state );
			$res = [ 'tokens' => [ $endTag ] ];
			$res->tokens->rank = TemplateHandler\RANK();
			$cb( $res );
		} else {
			$cb( [ 'tokens' => [] ] );
		}
	}

	/**
	 * Get the public data-mw structure that exposes the template name and
	 * parameters.
	 */
	public function getArgInfo( $state ) {
		$src = $this->manager->env->page->src;
		$params = $state->token->attribs;
		// TODO: `dict` might be a good candidate for a T65370 style cleanup as a
		// Map, but since it's intended to be stringified almost immediately, we'll
		// just have to be cautious with it by checking for own properties.
		$dict = [];
		$paramInfos = [];
		$argIndex = 1;

		// Use source offsets to extract arg-name and arg-value wikitext
		// since the 'k' and 'v' values in params will be expanded tokens
		//
		// Ignore params[0] -- that is the template name
		for ( $i = 1,  $n = count( $params );  $i < $n;  $i++ ) {
			$srcOffsets = $params[ $i ]->srcOffsets;
			$kSrc = null;
$vSrc = null;
			if ( $srcOffsets ) {
				$kSrc = $src->substring( $srcOffsets[ 0 ], $srcOffsets[ 1 ] );
				$vSrc = $src->substring( $srcOffsets[ 2 ], $srcOffsets[ 3 ] );
			} else {
				$kSrc = $params[ $i ]->k;
				$vSrc = $params[ $i ]->v;
			}

			$kWt = trim( $kSrc );
			$k = TokenUtils::tokensToString( $params[ $i ]->k, true, [ 'stripEmptyLineMeta' => true ] );
			if ( is_array( $k ) ) {
				// The PHP parser only removes comments and whitespace to construct
				// the real parameter name, so if there were other tokens, use the
				// original text
				$k = $kWt;
			} else {
				$k = trim( $k );
			}
			$v = $vSrc;

			// Number positional parameters
			$isPositional = null;
			// Even if k is empty, we need to check v immediately follows. If not,
			// it's a blank parameter name (which is valid) and we shouldn't make it
			// positional.
			if ( $k === '' && $srcOffsets[ 1 ] === $srcOffsets[ 2 ] ) {
				$isPositional = true;
				$k = $argIndex->toString();
				$argIndex++;
			} else {
				$isPositional = false;
				// strip ws from named parameter values
				$v = trim( $v );
			}

			if ( !$dict->hasOwnProperty( $k ) ) {
				$paramInfo = [
					'k' => $k,
					'srcOffsets' => $srcOffsets
				];

				$keySpaceMatch = preg_match( '/^(\s*)[^]*?(\s*)$/', $kSrc );
				$valueSpaceMatch = null;

				if ( $isPositional ) {
					// PHP parser does not strip whitespace around
					// positional params and neither will we.
					$valueSpaceMatch = [ null, '', '' ];
				} else {
					$paramInfo->named = true;
					$valueSpaceMatch = ( $v ) ? preg_match( '/^(\s*)[^]*?(\s*)$/', $vSrc ) : [ null, '', $vSrc ];
				}

				// Preserve key and value space prefix / postfix, if any.
				// "=" is the default spacing used by the serializer,
				if ( $keySpaceMatch[ 1 ] || $keySpaceMatch[ 2 ]
|| $valueSpaceMatch[ 1 ] || $valueSpaceMatch[ 2 ]
				) {
					// Remember non-standard spacing
					$paramInfo->spc = [
						$keySpaceMatch[ 1 ], $keySpaceMatch[ 2 ],
						$valueSpaceMatch[ 1 ], $valueSpaceMatch[ 2 ]
					];
				}

				$paramInfos[] = $paramInfo;
			}

			$dict[ $k ] = [ 'wt' => $v ];
			// Only add the original parameter wikitext if named and different from
			// the actual parameter.
			if ( !$isPositional && $kWt !== $k ) {
				$dict[ $k ]->key = [ 'wt' => $kWt ];
			}
		}

		$tplTgtSrcOffsets = $params[ 0 ]->srcOffsets;
		if ( $tplTgtSrcOffsets ) {
			$tplTgtWT = $src->substring( $tplTgtSrcOffsets[ 0 ], $tplTgtSrcOffsets[ 1 ] );
			return [
				'dict' => [
					'target' => [
						'wt' => $tplTgtWT,
						// Add in tpl-target/pf-name info
						// Only one of these will be set.
						'function' => $state->parserFunctionName,
						'href' => $state->resolvedTemplateTarget
					],
					'params' => $dict
				],
				'paramInfos' => $paramInfos
			];
		}
	}

	/**
	 * Fetch a template.
	 */
	public function _fetchTemplateAndTitle( $title, $parentCB, $cb, $state ) {
		$env = $this->manager->env;
		if ( isset( $env->pageCache[ $title ] ) ) {
			$cb( null, $env->pageCache[ $title ] );
		} elseif ( !$env->conf->parsoid->fetchTemplates ) {
			$tokens = [ $state->token->dataAttribs->src ];
			if ( $this->options->expandTemplates ) {
				// FIXME: We've already emitted a start meta to the accumulator in
				// `_encapsulateTemplate`.  We could reach for that and modify it,
				// or refactor to emit it later for all paths, but the pragmatic
				// thing to do is just ignore it and wrap this anew.
				$state->wrappedObjectId = $env->newObjectId();
				$tokens = $this->encapTokens( $state, $tokens, [
						'errors' => [
							[
								'key' => 'mw-api-tplfetch-error',
								'message' => 'Page / template fetching disabled, and no cache for ' . $title
							]
						]
					]
				);
				$typeOf = $tokens[ 0 ]->getAttribute( 'typeof' );
				$tokens[ 0 ]->setAttribute( 'typeof', 'mw:Error ' . $typeOf );
			}
			$parentCB( [ 'tokens' => $tokens ] );
		} else {
			// We are about to start an async request for a template
			$env->log( 'debug', 'Note: trying to fetch ', $title );
			// Start a new request if none is outstanding
			if ( $env->requestQueue[ $title ] === null ) {
				$env->requestQueue[ $title ] = new TemplateRequest( $env, $title );
			}
			// append request, process in document order
			$env->requestQueue[ $title ]->once( 'src', function ( $err, $page ) use ( &$cb ) {
					$cb( $err, ( $page ) ? $page->revision[ '*' ] : null );
			}
			);
			$parentCB( [ 'tokens' => [], 'async' => true ] );
		}
	}

	/**
	 * Fetch the preprocessed wikitext for a template-like construct.
	 */
	public function fetchExpandedTpl( $title, $text, $parentCB, $cb ) {
		$env = $this->manager->env;
		if ( !$env->conf->parsoid->fetchTemplates ) {
			$parentCB( [ 'tokens' => [ 'Warning: Page/template fetching disabled cannot expand ' . $text ] ] );
		} else {
			// We are about to start an async request for a template
			$env->log( 'debug', 'Note: trying to expand ', $text );
			$parentCB( [ 'tokens' => [], 'async' => true ] );
			$env->batcher->preprocess( $title, $text )->nodify( $cb );
		}
	}

	/* ********************** Template argument expansion ****************** */

	/**
	 * Expand template arguments with tokens from the containing frame.
	 */

	public function onTemplateArg( $token, $cb ) {
		$args = $this->manager->frame->args->named();
		$attribs = $token->attribs;
		$newCB = null;

		if ( $this->options->expandTemplates ) {
			// This is a bare use of template arg syntax at the top level
			// outside any template use context.  Wrap this use with RDF attrs.
			// so that this chunk can be RT-ed en-masse.
			$tplHandler = $this;
			$newCB = function ( $res ) use ( &$TokenUtils, &$token, &$tplHandler, &$cb ) {
				$toks = TokenUtils::stripEOFTkfromTokens( $res->tokens );
				$state = [
					'token' => $token,
					'wrapperType' => 'mw:Param',
					'wrappedObjectId' => $tplHandler->manager->env->newObjectId()
				];
				$toks = $tplHandler->encapTokens( $state, $toks );
				$cb( [ 'tokens' => $toks ] );
			};
		} else {
			$newCB = $cb;
		}

		$this->fetchArg( $attribs[ 0 ]->k, function ( $ret ) use ( &$args, &$attribs, &$newCB, &$cb ) {return $this->lookupArg( $args, $attribs, $newCB, $cb, $ret );
  }, $cb );
	}

	public function fetchArg( $arg, $argCB, $asyncCB ) {
		if ( $arg->constructor === $String ) {
			$argCB( [ 'tokens' => [ $arg ] ] );
		} else {
			$this->manager->frame->expand( $arg, [
					'expandTemplates' => false,
					'type' => 'tokens/x-mediawiki/expanded',
					'asyncCB' => $asyncCB,
					'cb' => function ( $tokens ) use ( &$argCB, &$TokenUtils ) {
						$argCB( [ 'tokens' => TokenUtils::stripEOFTkfromTokens( $tokens ) ] );
					}
				]
			);
		}
	}

	public function lookupArg( $args, $attribs, $cb, $asyncCB, $ret ) {
		$toks = $ret->tokens;
		$argName = ( $toks->constructor === $String ) ? $toks : trim( TokenUtils::tokensToString( $toks ) );
		$res = $args->dict[ $argName ];

		// The 'res.constructor !== Function' protects against references to
		// tpl-args named 'prototype' or 'constructor' that haven't been passed in.
		if ( $res !== null && $res !== null && $res->constructor !== $Function ) {
			if ( $res->constructor === $String ) {
				$res = [ $res ];
			}
			$cb( [ 'tokens' => ( $args->namedArgs[ $argName ] ) ? TokenUtils::tokenTrim( $res ) : $res ] );
		} elseif ( count( $attribs ) > 1 ) {
			$this->fetchArg( $attribs[ 1 ]->v, $cb, $asyncCB );
		} else {
			$cb( [ 'tokens' => [ '{{{' . $argName . '}}}' ] ] );
		}
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
TemplateHandler::_getParamHTML = /* async */TemplateHandler::getParamHTMLG;

if ( gettype( $module ) === 'object' ) {
	$module->exports->TemplateHandler = $TemplateHandler;
}
