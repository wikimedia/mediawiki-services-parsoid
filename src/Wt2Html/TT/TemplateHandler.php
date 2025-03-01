<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\Assert;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\NodeData\TempData;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TitleException;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wikitext\Wikitext;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\Params;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Template and template argument handling.
 */
class TemplateHandler extends TokenHandler {
	/**
	 * @var bool Should we wrap template tokens with template meta tags?
	 */
	private $wrapTemplates;

	/**
	 * @var AttributeExpander
	 * Local copy of the attribute expander to deal with template targets
	 * that are templated themselves
	 */
	private $ae;

	/**
	 * @var ParserFunctions
	 */
	private $parserFunctions;

	/**
	 * @var bool
	 */
	 private $atMaxArticleSize;

	 /** @var string|null */
	 private $safeSubstRegex;

	/**
	 * @param TokenHandlerPipeline $manager
	 * @param array $options
	 *  - ?bool inTemplate Is this being invoked while processing a template?
	 *  - ?bool expandTemplates Should we expand templates encountered here?
	 *  - ?string extTag The name of the extension tag, if any, which is being expanded.
	 */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->parserFunctions = new ParserFunctions( $this->env );
		$this->ae = new AttributeExpander( $this->manager, [
			'expandTemplates' => $this->options['expandTemplates'],
			'inTemplate' => $this->options['inTemplate'],
			'standalone' => true,
		] );
		$this->wrapTemplates = !$options['inTemplate'];

		// In the legacy parser, the call to replaceVariables from internalParse
		// returns early if the text is already greater than the $wgMaxArticleSize
		// We're going to compare and set a boolean here, then do the "early
		// return" below.
		$this->atMaxArticleSize = !$this->env->compareWt2HtmlLimit(
			'wikitextSize',
			strlen( $this->env->topFrame->getSrcText() )
		);
	}

	/**
	 * Parser functions also need template wrapping.
	 *
	 * @param array $tokens
	 * @return array
	 */
	private function parserFunctionsWrapper( array $tokens ): array {
		$chunkToks = [];
		if ( $tokens ) {
			// This is only for the Parsoid native expansion pipeline used in
			// parser tests. The "" token sometimes changes foster parenting
			// behavior and trips up some tests.
			$tokens = array_values( array_filter( $tokens, static function ( $t ) {
				return $t !== '';
			} ) );

			// token chunk should be flattened
			$flat = true;
			foreach ( $tokens as $t ) {
				if ( is_array( $t ) ) {
					$flat = false;
					break;
				}
			}
			Assert::invariant( $flat, "Expected token chunk to be flattened" );

			$chunkToks = $this->processTemplateTokens( $tokens );
		}
		return $chunkToks;
	}

	/**
	 * Take output of tokensToString and further postprocess it.
	 * - If it can be processed to a string which would be a valid template transclusion target,
	 *   the return value will be [ $the_string_value, null ]
	 * - If not, the return value will be [ $partial_string, $unprocessed_token_array ]
	 * The caller can then decide if this would be a valid parser function call
	 * where the unprocessed token array would be part of the first arg to the parser function.
	 * Ex: With "{{uc:foo [[foo]] {{1x|foo}} bar}}", we return
	 *     [ "uc:foo ", [ wikilink-token, " ", template-token, " bar" ] ]
	 *
	 * @param array $tokens
	 * @return array first element is always a string
	 */
	private function processToString( array $tokens ): array {
		$maybeTarget = TokenUtils::tokensToString( $tokens, true, [ 'retainNLs' => true ] );
		if ( !is_array( $maybeTarget ) ) {
			return [ $maybeTarget, null ];
		}

		$buf = $maybeTarget[0]; // Will always be a string
		$tgtTokens = $maybeTarget[1];
		$preNlContent = null;
		$i = 0;
		$n = count( $tgtTokens );
		while ( $i < $n ) {
			$ntt = $tgtTokens[$i];
			if ( is_string( $ntt ) ) {
				$buf .= $ntt;
				if ( $preNlContent !== null && !preg_match( '/^\s*$/D', $buf ) ) {
					// intervening newline makes this an invalid template target
					return [ $preNlContent, array_merge( [ $buf ], array_slice( $tgtTokens, $i ) ) ];
				}
			} else {
				switch ( get_class( $ntt ) ) {
					case SelfclosingTagTk::class:
						// Quotes are valid template targets
						if ( $ntt->getName() === 'mw-quote' ) {
							$buf .= $ntt->getAttributeV( 'value' );
						} elseif (
							!TokenUtils::isEmptyLineMetaToken( $ntt ) &&
							$ntt->getName() !== 'template' &&
							$ntt->getName() !== 'templatearg' &&
							// Ignore annotations in template targets
							// NOTE(T295834): There's a large discussion about who's responsible
							// for stripping these tags in I487baaafcf1ffd771cb6a9e7dd4fb76d6387e412
							!(
								$ntt->getName() === 'meta' &&
								TokenUtils::matchTypeOf( $ntt, WTUtils::ANNOTATION_META_TYPE_REGEXP )
							) &&
							// Note that OnlyInclude only converts to metas during TT
							// in inTemplate context, but we shouldn't find ourselves
							// here in that case.
							!(
								$ntt->getName() === 'meta' &&
								TokenUtils::matchTypeOf( $ntt, '#^mw:Includes/#' )
							)
						) {
							// We are okay with empty (comment-only) lines,
							// {{..}} and {{{..}}} in template targets.
							if ( $preNlContent !== null ) {
								return [ $preNlContent, array_merge( [ $buf ], array_slice( $tgtTokens, $i ) ) ];
							} else {
								return [ $buf, array_slice( $tgtTokens, $i ) ];
							}
						}
						break;

					case TagTk::class:
						if ( TokenUtils::isEntitySpanToken( $ntt ) ) {
							$buf .= $tgtTokens[$i + 1];
							$i += 2;
							break;
						}
						// Fall-through
					case EndTagTk::class:
						if ( $preNlContent !== null ) {
							return [ $preNlContent, array_merge( [ $buf ], array_slice( $tgtTokens, $i ) ) ];
						} else {
							return [ $buf, array_slice( $tgtTokens, $i ) ];
						}

					case CommentTk::class:
						// Ignore comments as well
						break;

					case NlTk::class:
						// Ignore only the leading or trailing newlines
						// (modulo whitespace and comments)
						//
						// If we only have whitespace in $buf thus far,
						// the newline can be ignored. But, if we have
						// non-ws content in $buf, everything that follows
						// can only be ws.
						if ( preg_match( '/^\s*$/D', $buf ) ) {
							$buf .= "\n";
							break;
						} elseif ( $preNlContent === null ) {
							// Buffer accumulated content
							$preNlContent = $buf;
							$buf = "\n";
							break;
						} else {
							return [ $preNlContent, array_merge( [ $buf ], array_slice( $tgtTokens, $i ) ) ];
						}

					default:
						throw new UnreachableException( 'Unexpected token type: ' . get_class( $ntt ) );
				}
			}
			$i++;
		}

		// All good! No newline / only whitespace/comments post newline.
		// (Well, annotation metas and template(arg) tokens too)
		return [ $preNlContent . $buf, null ];
	}

	/**
	 * Is the prefix "safesubst"
	 * @param string $prefix
	 * @return bool
	 */
	private function isSafeSubst( $prefix ): bool {
		if ( $this->safeSubstRegex === null ) {
			$this->safeSubstRegex = $this->env->getSiteConfig()->getMagicWordMatcher( 'safesubst' );
		}
		return (bool)preg_match( $this->safeSubstRegex, $prefix . ':' );
	}

	/**
	 * @param TemplateEncapsulator $state
	 * @param string|Token|array $targetToks
	 * @param SourceRange $srcOffsets
	 * @return array|null
	 */
	private function resolveTemplateTarget(
		TemplateEncapsulator $state, $targetToks, $srcOffsets
	): ?array {
		$additionalToks = null;
		if ( is_string( $targetToks ) ) {
			$target = $targetToks;
		} else {
			$toks = !is_array( $targetToks ) ? [ $targetToks ] : $targetToks;
			$toks = $this->processToString( $toks );
			[ $target, $additionalToks ] = $toks;
		}

		$target = trim( $target );
		$pieces = explode( ':', $target );
		$untrimmedPrefix = $pieces[0];
		$prefix = trim( $pieces[0] );

		// Parser function names usually (not always) start with a hash
		$hasHash = substr( $target, 0, 1 ) === '#';
		// String found after the colon will be the parser function arg
		$haveColon = count( $pieces ) > 1;

		// safesubst found in content should be treated as if no modifier were
		// present. See https://en.wikipedia.org/wiki/Help:Substitution#The_safesubst:_modifier
		if ( $haveColon && $this->isSafeSubst( $prefix ) ) {
			$target = substr( $target, strlen( $untrimmedPrefix ) + 1 );
			array_shift( $pieces );
			$untrimmedPrefix = $pieces[0];
			$prefix = trim( $pieces[0] );
			$haveColon = count( $pieces ) > 1;
		}

		$env = $this->env;
		$siteConfig = $env->getSiteConfig();

		// Additional tokens are only justifiable in parser functions scenario
		if ( !$haveColon && $additionalToks ) {
			return null;
		}

		$pfArg = '';
		if ( $haveColon ) {
			$pfArg = substr( $target, strlen( $untrimmedPrefix ) + 1 );
			if ( $additionalToks ) {
				$pfArg = [ $pfArg ];
				PHPUtils::pushArray( $pfArg, $additionalToks );
			}
		}

		// Check if we have a magic-word variable.
		$magicWordVar = $siteConfig->getMagicWordForVariable( $prefix ) ??
			$siteConfig->getMagicWordForVariable( mb_strtolower( $prefix ) );
		if ( $magicWordVar ) {
			$state->variableName = $magicWordVar;
			return [
				'isVariable' => true,
				'magicWordType' => $magicWordVar === '!' ? '!' : null,
				'name' => $magicWordVar,
				// FIXME: Some made up synthetic title
				'title' => $env->makeTitleFromURLDecodedStr( "Special:Variable/$magicWordVar" ),
				'pfArg' => $pfArg,
				'srcOffsets' => new SourceRange(
					$srcOffsets->start + strlen( $untrimmedPrefix ) + 1,
					$srcOffsets->end ),
			];
		}

		// FIXME: Checks for msgnw, msg, raw are missing at this point

		$canonicalFunctionName = null;
		if ( $haveColon ) {
			$canonicalFunctionName = $siteConfig->getMagicWordForFunctionHook( $prefix );
		}
		if ( $canonicalFunctionName === null && $hasHash ) {
			// If the target starts with a '#' it can't possibly be a template
			// so this must be a "broken" parser function invocation
			$canonicalFunctionName = substr( $prefix, 1 );
			// @todo: Flag this as an author error somehow (T314524)
		}
		if ( $canonicalFunctionName !== null ) {
			$state->parserFunctionName = $canonicalFunctionName;
			// XXX this is made up.
			$syntheticTitle = $env->makeTitleFromURLDecodedStr(
				"Special:ParserFunction/$canonicalFunctionName",
				$env->getSiteConfig()->canonicalNamespaceId( 'Special' ),
				true // No exceptions
			);
			// Note that parserFunctionName/$canonicalFunctionName is not
			// necessarily a valid title!  Parsing rules are pretty generous
			// w/r/t valid parser function names.
			if ( $syntheticTitle === null ) {
				$syntheticTitle = $env->makeTitleFromText(
					'Special:ParserFunction/unknown'
				);
			}
			return [
				'isParserFunction' => true,
				'magicWordType' => null,
				'name' => $canonicalFunctionName,
				'title' => $syntheticTitle, // FIXME: Some made up synthetic title
				'pfArg' => $pfArg,
				'srcOffsets' => new SourceRange(
					$srcOffsets->start + strlen( $untrimmedPrefix ) + 1,
					$srcOffsets->end ),
			];
		}

		// We've exhausted the parser-function scenarios, and we still have additional tokens.
		if ( $additionalToks ) {
			return null;
		}

		// `resolveTitle()` adds the namespace prefix when it resolves fragments
		// and relative titles, and a leading colon should resolve to a template
		// from the main namespace, hence we omit a default when making a title
		$namespaceId = strspn( $target, ':#/.' ) ?
			null : $siteConfig->canonicalNamespaceId( 'template' );

		// Resolve a possibly relative link and
		// normalize the target before template processing.
		$title = null;
		try {
			$title = $env->resolveTitle( $target );
		} catch ( TitleException $e ) {
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
			'magicWordType' => null,
			'name' => $title->getPrefixedDBKey(),
			'title' => $title,
		];
	}

	/**
	 * Flatten
	 * @param (Token|string)[] $tokens
	 * @param ?string $prefix
	 * @param Token|string|(Token|string)[] $t
	 * @return array
	 */
	private function flattenAndAppendToks(
		array $tokens, ?string $prefix, $t
	): array {
		if ( is_array( $t ) ) {
			$len = count( $t );
			if ( $len > 0 ) {
				if ( $prefix !== null && $prefix !== '' ) {
					$tokens[] = $prefix;
				}
				PHPUtils::pushArray( $tokens, $t );
			}
		} elseif ( is_string( $t ) ) {
			$len = strlen( $t );
			if ( $len > 0 ) {
				if ( $prefix !== null && $prefix !== '' ) {
					$tokens[] = $prefix;
				}
				$tokens[] = $t;
			}
		} else {
			if ( $prefix !== null && $prefix !== '' ) {
				$tokens[] = $prefix;
			}
			$tokens[] = $t;
		}

		return $tokens;
	}

	/**
	 * By default, don't attempt to expand any templates in the wikitext that will be reprocessed.
	 *
	 * @param Token $token
	 * @param bool $expandTemplates
	 * @return TemplateExpansionResult
	 */
	private function convertToString( Token $token, bool $expandTemplates = false ): TemplateExpansionResult {
		$frame = $this->manager->getFrame();
		$tsr = $token->dataParsoid->tsr;
		$src = substr( $token->dataParsoid->src, 1, -1 );
		$startOffset = $tsr->start + 1;
		$srcOffsets = new SourceRange( $startOffset, $startOffset + strlen( $src ) );

		$toks = PipelineUtils::processContentInPipeline(
			$this->env, $frame, $src, [
				'pipelineType' => 'wikitext-to-expanded-tokens',
				'pipelineOpts' => [
					'inTemplate' => $this->options['inTemplate'],
					'expandTemplates' => $expandTemplates && $this->options['expandTemplates'],
				],
				'sol' => false,
				// FIXME: Set toplevel when bailing
				// 'toplevel' => $this->atTopLevel,
				'srcOffsets' => $srcOffsets,
			]
		);
		TokenUtils::stripEOFTkfromTokens( $toks );
		return new TemplateExpansionResult( array_merge( [ '{' ], $toks, [ '}' ] ), true );
	}

	/**
	 * Enforce template loops / loop depth limit constraints and emit
	 * error message if constraints are violated.
	 *
	 * @param mixed $target
	 * @param Title $title
	 * @param bool $ignoreLoop
	 * @return ?array
	 */
	private function enforceTemplateConstraints( $target, Title $title, bool $ignoreLoop ): ?array {
		$error = $this->manager->getFrame()->loopAndDepthCheck(
			$title, $this->env->getSiteConfig()->getMaxTemplateDepth(),
			$ignoreLoop
		);

		return $error ? [ // Loop detected or depth limit exceeded, abort!
			new TagTk( 'span', [ new KV( 'class', 'error' ) ] ),
			$error,
			new SelfclosingTagTk( 'wikilink', [ new KV( 'href', $target, null, '', '' ) ] ),
			new EndTagTk( 'span' ),
		] : null;
	}

	/**
	 * Fetch, tokenize and token-transform a template after all arguments and
	 * the target were expanded.
	 *
	 * @param TemplateEncapsulator $state
	 * @param array $resolvedTgt
	 * @param array $attribs
	 * @return TemplateExpansionResult
	 */
	private function expandTemplateNatively(
		TemplateEncapsulator $state, array $resolvedTgt, array $attribs
	): TemplateExpansionResult {
		$env = $this->env;
		$encap = $this->options['expandTemplates'] && $this->wrapTemplates;

		// XXX: wrap attribs in object with .dict() and .named() methods,
		// and each member (key/value) into object with .tokens(), .dom() and
		// .wikitext() methods (subclass of Array)

		$target = $resolvedTgt['name'];
		if ( isset( $resolvedTgt['isParserFunction'] ) || isset( $resolvedTgt['isVariable'] ) ) {
			// FIXME: HARDCODED to core parser function implementations!
			// These should go through function hook registrations in the
			// ParserTests mock setup ideally. But, it is complicated because the
			// Parsoid core parser function versions have "token" versions
			// which are incompatible with implementation in FunctionHookHandler
			// and FunctionArgs. So, we continue down this hacky path for now.
			if ( $target === '=' ) {
				$target = 'equal';  // '=' is not a valid character in function names
			}
			$target = 'pf_' . $target;
			// FIXME: Parsoid may not have implemented the parser function natively
			// Emit an error message, but encapsulate it so it roundtrips back.
			if ( !is_callable( [ $this->parserFunctions, $target ] ) ) {
				// FIXME: Consolidate error response format with enforceTemplateConstraints
				$err = 'Parser function implementation for ' . $target . ' missing in Parsoid.';
				return new TemplateExpansionResult( [ $err ], false, $encap );
			}

			$pfAttribs = new Params( $attribs );
			$pfAttribs->args[0] = new KV(
				// FIXME: This is bogus, but preserves borked b/c
				TokenUtils::tokensToString( $resolvedTgt['pfArg'] ), [],
				$resolvedTgt['srcOffsets']->expandTsrK()
			);
			$env->log( 'debug', 'entering prefix', $target, $state->token );
			$res = $this->parserFunctions->$target(
				$state->token, $this->manager->getFrame(), $pfAttribs );
			if ( $this->wrapTemplates ) {
				$res = $this->parserFunctionsWrapper( $res );
			}
			return new TemplateExpansionResult( $res, false, $encap );
		}

		// Loop detection needs to be enabled since we're doing our own template expansion
		$error = $this->enforceTemplateConstraints( $target, $resolvedTgt['title'], false );
		if ( $error ) {
			// FIXME: Should we be encapsulating here?
			// Inconsistent with the other place constrainsts are enforced.
			return new TemplateExpansionResult( $error, false, $encap );
		}

		// XXX: notes from brion's mediawiki.parser.environment
		// resolve template name
		// load template w/ canonical name
		// load template w/ variant names (language variants)

		// Fetch template source and expand it
		$src = $this->fetchTemplateAndTitle( $target, $attribs );
		if ( $src !== null ) {
			$toks = $this->processTemplateSource(
				$this->manager->getFrame(),
				$state->token,
				[
					'name' => $target,
					'title' => $resolvedTgt['title'],
					'attribs' => array_slice( $attribs, 1 ), // strip template target
				],
				$src,
				$this->options
			);
			return new TemplateExpansionResult( $toks, true, $encap );
		} else {
			// Convert to a wikilink (which will become a redlink after the redlinks pass).
			$toks = [ new SelfclosingTagTk( 'wikilink' ) ];
			$hrefSrc = $resolvedTgt['name'];
			$toks[0]->attribs[] = new KV( 'href', $hrefSrc, null, null, $hrefSrc );
			return new TemplateExpansionResult( $toks, false, $encap );
		}
	}

	/**
	 * Process a fetched template source to a token stream.
	 */
	private function processTemplateSource(
		Frame $frame, Token $token, array $tplArgs, string $src,
		array $options = []
	): array {
		if ( $this->env->hasDumpFlag( 'tplsrc' ) ) {
			PipelineUtils::dumpTplSrc(
				$this->env, $token, $tplArgs['name'], $src, false
			);
		}
		$this->env->log( 'debug', 'TemplateHandler.processTemplateSource',
			$tplArgs['name'], $tplArgs['attribs'] );
		$toks = PipelineUtils::processTemplateSource(
			$this->env,
			$frame,
			$token,
			$tplArgs,
			$src,
			$options
		);
		return $this->processTemplateTokens( $toks );
	}

	/**
	 * Process the main template element, including the arguments.
	 *
	 * @param TemplateEncapsulator $state
	 * @param array $tokens
	 * @return array
	 */
	private function encapTokens( TemplateEncapsulator $state, array $tokens ): array {
		// Template encapsulation normally wouldn't happen in nested context,
		// since they should have already been expanded, and indeed we set
		// expandTemplates === false in processTemplateSource.  However,
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
		Assert::invariant(
			$this->wrapTemplates, 'Encapsulating tokens when not wrapping!'
		);
		return $state->encapTokens( $tokens );
	}

	/**
	 * Handle chunk emitted from the input pipeline after feeding it a template.
	 *
	 * @param array $chunk
	 * @return array
	 */
	private function processTemplateTokens( array $chunk ): array {
		TokenUtils::stripEOFTkfromTokens( $chunk );

		foreach ( $chunk as $i => $t ) {
			if ( !$t ) {
				continue;
			}

			if ( isset( $t->dataParsoid->tsr ) ) {
				unset( $t->dataParsoid->tsr );
			}
			Assert::invariant( !isset( $t->dataParsoid->tmp->endTSR ),
				"Expected endTSR to not be set on templated content." );
			if ( $t instanceof SelfclosingTagTk &&
				strtolower( $t->getName() ) === 'meta' &&
				TokenUtils::hasTypeOf( $t, 'mw:Placeholder' )
			) {
				// replace with empty string to avoid metas being foster-parented out
				$chunk[$i] = '';
			}
		}

		// FIXME: What is this stuff here? Why do we care about stripping out comments
		// so much that we create a new token array for every expanded template?
		// Unlikely to help perf very much.
		if ( !$this->options['expandTemplates'] ) {
			// Ignore comments in template transclusion mode
			$newChunk = [];
			for ( $i = 0, $n = count( $chunk ); $i < $n;  $i++ ) {
				if ( !( $chunk[$i] instanceof CommentTk ) ) {
					$newChunk[] = $chunk[$i];
				}
			}
			$chunk = $newChunk;
		}

		$this->env->log( 'debug', 'TemplateHandler.processTemplateTokens', $chunk );
		return $chunk;
	}

	/**
	 * Fetch a template.
	 *
	 * @param string $templateName
	 * @param array $attribs
	 * @return ?string
	 */
	private function fetchTemplateAndTitle( string $templateName, array $attribs ): ?string {
		$env = $this->env;
		if ( isset( $env->pageCache[$templateName] ) ) {
			return $env->pageCache[$templateName];
		}

		$start = microtime( true );
		$pageContent = $env->getDataAccess()->fetchTemplateSource(
			$env->getPageConfig(),
			Title::newFromText( $templateName, $env->getSiteConfig() )
		);
		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			$profile->bumpMWTime( "TemplateFetch", 1000 * ( microtime( true ) - $start ), "api" );
			$profile->bumpCount( "TemplateFetch" );
		}

		// FIXME:
		// 1. Hard-coded 'main' role
		return $pageContent ? $pageContent->getContent( 'main' ) : null;
	}

	/**
	 * @param mixed $tokens
	 * @return bool
	 */
	private static function hasTemplateToken( $tokens ): bool {
		if ( is_array( $tokens ) ) {
			foreach ( $tokens as $t ) {
				if ( TokenUtils::isTemplateToken( $t ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Process the special magic word as specified by $resolvedTgt['magicWordType'].
	 * ```
	 * magicWordType === '!' => {{!}} is the magic word
	 * ```
	 * @param TemplateEncapsulator $state
	 * @param array $resolvedTgt
	 * @return TemplateExpansionResult
	 */
	private function processSpecialMagicWord(
		TemplateEncapsulator $state, array $resolvedTgt
	): TemplateExpansionResult {
		$env = $this->env;
		$tplToken = $state->token;

		// Special case for {{!}} magic word.
		//
		// If we tokenized as a magic word, we meant for it to expand to a
		// string.  The tokenizer has handling for this syntax in table
		// positions.  However, proceeding to go through template expansion
		// will reparse it as a table cell token.  Hence this special case
		// handling to avoid that path.
		if ( $resolvedTgt['magicWordType'] === '!' ) {
			// If we're not at the top level, return a table cell. This will always
			// be the case. Either {{!}} was tokenized as a td, or it was tokenized
			// as template but the recursive call to fetch its content returns a
			// single | in an ambiguous context which will again be tokenized as td.
			// In any case, this should only be relevant for parserTests.
			if ( $this->options['inTemplate'] ) {
				$td = new TagTk( 'td' );
				$td->dataParsoid->getTemp()->attrSrc = '';
				$td->dataParsoid->setTempFlag( TempData::AT_SRC_START );
				$toks = [ $td ];
			} else {
				$toks = [ '|' ];
			}
			return new TemplateExpansionResult( $toks, false, (bool)$this->wrapTemplates );
		}

		throw new UnreachableException(
			'Unsupported magic word type: ' . ( $resolvedTgt['magicWordType'] ?? 'null' )
		);
	}

	private function expandTemplate( TemplateEncapsulator $state ): TemplateExpansionResult {
		$env = $this->env;
		$token = $state->token;
		$expandTemplates = $this->options['expandTemplates'];

		// Since AttributeExpander runs later in the pipeline than TemplateHandler,
		// if the template name is templated, use our copy of AttributeExpander
		// to process the first attribute to tokens, and force reprocessing of this
		// template token since we will then know the actual template target.
		if ( $expandTemplates && self::hasTemplateToken( $token->attribs[0]->k ) ) {
			$ret = $this->ae->expandFirstAttribute( $token );
			$toks = $ret->tokens ?? null;
			Assert::invariant( $toks && count( $toks ) === 1 && $toks[0] === $token,
				"Expected only the input token as the return value." );
		}

		if ( $this->atMaxArticleSize ) {
			// As described above, if we were already greater than $wgMaxArticleSize
			// we're going to return the tokens without expanding them.
			// (This case is where the original article as fetched from the DB
			// or passed to the API exceeded max article size.)
			return $this->convertToString( $token );
		}

		// There's no point in proceeding if we've already hit the maximum inclusion size
		// XXX should this be combined with the previous test?
		if ( !$env->bumpWt2HtmlResourceUse( 'wikitextSize', 0 ) ) {
			// FIXME: The legacy parser would try to make this a link and
			// elsewhere we'd return the $e->getMessage()
			// (This case is where the template post-expansion accumulation is
			// over the maximum wikitext size.)
			// XXX: It could be combined with the previous test, but we might
			// want to use different error messages in the future.
			return $this->convertToString( $token );
		}

		$toks = null;
		$text = $token->dataParsoid->src ?? '';

		$tgt = $this->resolveTemplateTarget(
			$state, $token->attribs[0]->k, $token->attribs[0]->srcOffsets->key
		);

		if ( $expandTemplates && $tgt === null ) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			return $this->convertToString( $token, true );
		}

		if ( isset( $tgt['magicWordType'] ) ) {
			return $this->processSpecialMagicWord( $state, $tgt );
		}

		$frame = $this->manager->getFrame();

		if ( $env->nativeTemplateExpansionEnabled() ) {
			// Expand argument keys
			$atm = new AttributeTransformManager( $frame,
				[ 'expandTemplates' => false, 'inTemplate' => true ]
			);
			$newAttribs = $atm->process( $token->attribs );
			$target = $newAttribs[0]->k;
			if ( !$target ) {
				$env->log( 'debug', 'No template target! ', $newAttribs );
			}
			// Resolve the template target again now that the template token's
			// attributes have been expanded by the AttributeTransformManager
			$resolvedTgt = $this->resolveTemplateTarget( $state, $target, $newAttribs[0]->srcOffsets->key );
			if ( $resolvedTgt === null ) {
				// Target contains tags, convert template braces and pipes back into text
				// Re-join attribute tokens with '=' and '|'
				return $this->convertToString( $token, true );
			} else {
				return $this->expandTemplateNatively( $state, $resolvedTgt, $newAttribs );
			}
		} elseif ( $expandTemplates ) {
			// Use MediaWiki's preprocessor
			//
			// The tokenizer needs to use `text` as the cache key for caching
			// expanded tokens from the expanded transclusion text that we get
			// from the preprocessor, since parameter substitution will already
			// have taken place.
			//
			// It's sufficient to pass `[]` in place of attribs since they
			// won't be used.  In `usePHPPreProcessor`, there is no parameter
			// substitution coming from the frame.

			/* If $tgt is not null, target will be present. */
			$templateName = $tgt['name'];
			$templateTitle = $tgt['title'];
			// FIXME: This is a source of a lot of issues since templateargs
			// get looked up from the Frame and yield these tokens which then enter
			// the token stream. See T301948 and others from wmf.22
			// $attribs = array_slice( $token->attribs, 1 ); // Strip template name
			$attribs = [];

			// We still need to check for limit violations because of the
			// higher precedence of extension tags, which can result in nested
			// templates even while using the php preprocessor for expansion.
			$error = $this->enforceTemplateConstraints( $templateName, $templateTitle, true );
			if ( $error ) {
				// FIXME: Should we be encapsulating here?
				// Inconsistent with the other place constrainsts are enforced.
				return new TemplateExpansionResult( $error );
			}

			if ( str_starts_with( $text, PipelineUtils::PARSOID_FRAGMENT_PREFIX ) ) {
				// See PipelineUtils::pFragmentToParsoidFragmentMarkers()
				// This is an atomic DOM subtree/forest, and so we're going
				// to process it all the way to DOM.  Contrast with our
				// handling of a PFragment return value from a parser
				// function below, which process to tokens only.
				$pFragment = $env->getPFragment( $text );
				$domFragment = $pFragment->asDom(
					new ParsoidExtensionAPI(
						$env, [
							'wt2html' => [
								'frame' => $this->manager->getFrame(),
								'parseOpts' => [
									// This fragment comes from a template and it is important to set
									// the 'inTemplate' parse option for it.
									'inTemplate' => true,
									// There might be translcusions within this fragment and we want
									// to expand them. Ex: {{1x|<ref>{{my-tpl}}foo</ref>}}
									'expandTemplates' => true
								] + $this->options
							]
						]
					)
				);
				$toks = PipelineUtils::tunnelDOMThroughTokens( $env, $token, $domFragment, [] );
				$toks = $this->processTemplateTokens( $toks );
				// This is an internal strip marker, it should be wrapped at a
				// higher level and we don't need to wrap it again.
				$wrapTemplates = false;
				return new TemplateExpansionResult( $toks, true, $wrapTemplates );
			} else {
				if (
					!isset( $tgt['isParserFunction'] ) &&
					!isset( $tgt['isVariable'] ) &&
					!$templateTitle->isExternal() &&
					$templateTitle->isSpecialPage()
				) {
					$domFragment = PipelineUtils::parseToHTML( $env, $text );
					$toks = $domFragment
						? PipelineUtils::tunnelDOMThroughTokens( $env, $token, $domFragment, [] )
						: [];
					$toks = $this->processTemplateTokens( $toks );
					return new TemplateExpansionResult( $toks, true, $this->wrapTemplates );
				}

				// Fetch and process the template expansion
				$expansion = Wikitext::preprocess( $env, $text );
				if ( $expansion['error'] ) {
					return new TemplateExpansionResult(
						[ $expansion['src'] ], false, $this->wrapTemplates
					);
				} else {
					if ( isset( $expansion['fragment'] ) ) {
						// This is a mixed expansion which contains wikitext and
						// atomic PFragments.  Process this to tokens.
						// (Contrast with the processing of {{#parsoid-fragment}}
						// above, which represents an atomic PFragment.)
						[
							'wikitext' => $wikitext,
						] = PipelineUtils::preparePFragment(
							$env,
							$this->manager->getFrame(),
							$expansion['fragment'],
							[
								// options
							]
						);
						// We need to expand embedded {{#parsoid-fragment}}
						// markers still (T385806)
						$expandTemplates = true;
					} else {
						$wikitext = $expansion['src'];
						$expandTemplates = false;
					}
					$tplToks = $this->processTemplateSource(
						$this->manager->getFrame(),
						$token,
						[
							'name' => $templateName,
							'title' => $templateTitle,
							'attribs' => $attribs
						],
						$wikitext,
						[
							'expandTemplates' => $expandTemplates,
						] + $this->options
					);
					return new TemplateExpansionResult(
						$tplToks, true, $this->wrapTemplates
					);
				}
			}
		} else {
			// We don't perform recursive template expansion- something
			// template-like that the PHP parser did not expand. This is
			// encapsulated already, so just return the plain text.
			Assert::invariant( TokenUtils::isTemplateToken( $token ), "Expected template token." );
			return $this->convertToString( $token );
		}
	}

	/**
	 * Main template token handler.
	 *
	 * Expands target and arguments (both keys and values) and either directly
	 * calls or sets up the callback to expandTemplate, which then fetches and
	 * processes the template.
	 *
	 * @param Token $token
	 * @return TokenHandlerResult
	 */
	private function onTemplate( Token $token ): TokenHandlerResult {
		$state = new TemplateEncapsulator(
			$this->env, $this->manager->getFrame(), $token, 'mw:Transclusion'
		);
		$res = $this->expandTemplate( $state );
		$toks = $res->tokens;
		if ( $res->encap ) {
			$toks = $this->encapTokens( $state, $toks );
		}
		if ( $res->shuttle ) {
			// Shuttle tokens to the end of the stage since they've gone through the
			// rest of the handlers in the current pipeline in the pipeline above.
			$toks = $this->manager->shuttleTokensToEndOfStage( $toks );
		}
		return new TokenHandlerResult( $toks );
	}

	/**
	 * Expand template arguments with tokens from the containing frame.
	 * @param Token $token
	 * @return TokenHandlerResult
	 */
	private function onTemplateArg( Token $token ): TokenHandlerResult {
		$toks = $this->manager->getFrame()->expandTemplateArg( $token );

		if ( $this->wrapTemplates && $this->options['expandTemplates'] ) {
			// This is a bare use of template arg syntax at the top level
			// outside any template use context.  Wrap this use with RDF attrs.
			// so that this chunk can be RT-ed en-masse.
			$state = new TemplateEncapsulator(
				$this->env, $this->manager->getFrame(), $token, 'mw:Param'
			);
			$toks = $this->encapTokens( $state, $toks );
		}

		// Shuttle tokens to the end of the stage since they've gone through the
		// rest of the handlers in the current pipeline in the pipeline above.
		$toks = $this->manager->shuttleTokensToEndOfStage( $toks );

		return new TokenHandlerResult( $toks );
	}

	public function onTag( Token $token ): ?TokenHandlerResult {
		switch ( $token->getName() ) {
			case "template":
				return $this->onTemplate( $token );
			case "templatearg":
				return $this->onTemplateArg( $token );
			default:
				return null;
		}
	}
}
