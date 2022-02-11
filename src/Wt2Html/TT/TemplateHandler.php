<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\Assert;
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
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wikitext\Wikitext;
use Wikimedia\Parsoid\Wt2Html\Params;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

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
	 * @param TokenTransformManager $manager
	 * @param array $options
	 *  - ?bool inTemplate Is this being invoked while processing a template?
	 *  - ?bool expandTemplates Should we expand templates encountered here?
	 *  - ?string extTag The name of the extension tag, if any, which is being expanded.
	 */
	public function __construct( TokenTransformManager $manager, array $options ) {
		parent::__construct( $manager, $options );
		// Set this here so that it's available in the TokenStreamPatcher,
		// which continues to inherit from TemplateHandler.
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
			strlen( $this->env->getPageConfig()->getPageMainContent() )
		);
	}

	/**
	 * Parser functions also need template wrapping.
	 *
	 * @param array $state
	 * @param array $ret
	 * @return array
	 */
	private function parserFunctionsWrapper( array $state, array $ret ): array {
		$chunkToks = [];
		if ( $ret ) {
			$tokens = $ret;

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

			$chunkToks = $this->processTemplateTokens( $state, $tokens );
		}
		return $chunkToks;
	}

	/**
	 * Strip include tags, and the contents of includeonly tags as well.
	 * @param (Token|string)[] $tokens
	 * @return (Token|string)[]
	 */
	private function stripIncludeTokens( array $tokens ): array {
		$toks = [];
		$includeOnly = false;
		foreach ( $tokens as $tok ) {
			if ( is_string( $tok ) ) {
				if ( !$includeOnly ) {
					$toks[] = $tok;
				}
				continue;
			}

			switch ( get_class( $tok ) ) {
				case TagTk::class:
				case EndTagTk::class:
				case SelfclosingTagTk::class:
					$tokName = $tok->getName();
					if ( $tokName === 'noinclude' || $tokName === 'onlyinclude' ) {
						break;
					} elseif ( $tokName === 'includeonly' ) {
						$includeOnly = $tok instanceof TagTk;
						break;
					}
					// Fall through
				default:
					if ( !$includeOnly ) {
						$toks[] = $tok;
					}
			}
		}
		return $toks;
	}

	/**
	 * @param array $tokens
	 * @return ?string
	 */
	private function toStringOrNull( array $tokens ): ?string {
		$maybeTarget = TokenUtils::tokensToString( $tokens, true, [ 'retainNLs' => true ] );
		if ( !is_array( $maybeTarget ) ) {
			return $maybeTarget;
		}

		$buf = $maybeTarget[0]; // Will always be a string
		$tgtTokens = $maybeTarget[1];
		$preNlContent = null;
		foreach ( $tgtTokens as $ntt ) {
			if ( is_string( $ntt ) ) {
				$buf .= $ntt;
				continue;
			}

			switch ( get_class( $ntt ) ) {
				case SelfclosingTagTk::class:
					// Quotes are valid template targets
					if ( $ntt->getName() === 'mw-quote' ) {
						$buf .= $ntt->getAttribute( 'value' );
					} elseif ( !TokenUtils::isEmptyLineMetaToken( $ntt ) &&
						$ntt->getName() !== 'template' &&
						$ntt->getName() !== 'templatearg'
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
					// Ignore only the leading or trailing newlines
					// (modulo whitespace and comments)
					//
					// If we only have whitespace in $buf thus far,
					// the newline can be ignored. But, if we have
					// non-ws content in $buf, everything that follows
					// can only be ws.
					if ( preg_match( '/^\s*$/D', $buf ) ) {
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
					PHPUtils::unreachable( 'Unexpected token type: ' . get_class( $ntt ) );
			}
		}

		if ( $preNlContent && !preg_match( '/^\s*$/D', $buf ) ) {
			// intervening newline makes this an invalid target
			return null;
		} else {
			// all good! only whitespace/comments post newline
			return ( $preNlContent ?? '' ) . $buf;
		}
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
	 * @param array &$state
	 * @param string|Token|array $targetToks
	 * @param SourceRange $srcOffsets
	 * @return array|null
	 */
	private function resolveTemplateTarget( array &$state, $targetToks, $srcOffsets ): ?array {
		// Normalize to an array
		$targetToks = !is_array( $targetToks ) ? [ $targetToks ] : $targetToks;

		$env = $this->env;
		$siteConfig = $env->getSiteConfig();
		$isTemplate = true;
		$includesStrippedTokens = $this->stripIncludeTokens( $targetToks );
		$target = $this->toStringOrNull( $includesStrippedTokens );
		if ( $target === null ) {
			// Retry with a looser attempt to convert tokens to a string.
			// This lenience only applies to parser functions.
			$isTemplate = false;
			$target = TokenUtils::tokensToString( $includesStrippedTokens );
		}

		$target = trim( $target );
		$pieces = explode( ':', $target );
		$prefix = trim( $pieces[0] );

		// safesubst found in content should be treated as if no modifier were
		// present. See https://en.wikipedia.org/wiki/Help:Substitution#The_safesubst:_modifier
		if ( $this->isSafeSubst( $prefix ) ) {
			$target = substr( $target, strlen( $pieces[0] ) + 1 );
			array_shift( $pieces );
			$prefix = trim( $pieces[0] );
		}

		// Check if we have a parser function
		$canonicalFunctionName = $siteConfig->getMagicWordForFunctionHook( $prefix ) ??
			$siteConfig->getMagicWordForVariable( $prefix ) ??
			$siteConfig->getMagicWordForVariable( mb_strtolower( $prefix ) );

		if ( $canonicalFunctionName !== null ) {
			$state['parserFunctionName'] = $canonicalFunctionName;
			$magicWordType = null;
			if ( $canonicalFunctionName === '!' ) {
				$magicWordType = '!';
			} elseif ( isset( Utils::magicMasqs()[$canonicalFunctionName] ) ) {
				$magicWordType = 'MASQ';
			}

			$pfArg = substr( $target, strlen( $prefix ) + 1 );
			return [
				'isPF' => true,
				'prefix' => $canonicalFunctionName,
				'pfArg' => $pfArg === false ? '' : $pfArg,
				'target' => 'pf_' . $canonicalFunctionName,
				'title' => $env->makeTitleFromURLDecodedStr( "Special:ParserFunction/$canonicalFunctionName" ),
				'srcOffsets' => $srcOffsets,
				'magicWordType' => $magicWordType,
				// Is this of the form {{somepf:arg}}? Ex: {{lc:FOO}}
				'haveArgsAfterColon' => count( $pieces ) > 1,
				'targetToks' => $targetToks
			];
		}

		if ( !$isTemplate ) {
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
		$state['resolvedTemplateTarget'] = $env->makeLink( $title );

		return [
			'isPF' => false,
			'magicWordType' => null,
			'target' => $title->getPrefixedDBKey(),
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
	 * @param Token $token
	 * @return array
	 */
	private function convertToString( Token $token ): array {
		$frame = $this->manager->getFrame();
		$tsr = $token->dataAttribs->tsr;
		$src = substr( $token->dataAttribs->src, 1, -1 );
		$startOffset = $tsr->start + 1;
		$srcOffsets = new SourceRange( $startOffset, $startOffset + strlen( $src ) );

		$toks = PipelineUtils::processContentInPipeline(
			$this->env, $frame, $src, [
				'pipelineType' => 'text/x-mediawiki',
				'pipelineOpts' => [
					'expandTemplates' => $this->options['expandTemplates'],
					'inTemplate' => $this->options['inTemplate'],
				],
				'sol' => false,
				'srcOffsets' => $srcOffsets,
			]
		);
		TokenUtils::stripEOFTkfromTokens( $toks );

		$toks = array_merge( [ '{' ], $toks, [ '}' ] );

		// Shuttle tokens to the end of the stage since they've gone through the
		// rest of the handlers in the current pipeline in the pipeline above.
		return $this->manager->shuttleTokensToEndOfStage( $toks );
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
	 * @param array $state
	 * @param array $resolvedTgt
	 * @param array $attribs
	 * @return array
	 */
	private function expandTemplate(
		array $state, array $resolvedTgt, array $attribs
	): array {
		$env = $this->env;

		// TODO:
		// check for 'subst:'
		// check for variable magic names
		// check for msg, msgnw, raw magics
		// check for parser functions

		// XXX: wrap attribs in object with .dict() and .named() methods,
		// and each member (key/value) into object with .tokens(), .dom() and
		// .wikitext() methods (subclass of Array)

		$res = null;
		$target = $resolvedTgt['target'];
		if ( $resolvedTgt['isPF'] ) {
			// FIXME: Parsoid may not have implemented the parser function natively
			// Emit an error message, but encapsulate it so it roundtrips back.
			if ( !is_callable( [ $this->parserFunctions, $target ] ) ) {
				// FIXME: Consolidate error response format with enforceTemplateConstraints
				return [ 'Parser function implementation for ' . $target . ' missing in Parsoid.' ];
			}

			$pfAttribs = new Params( $attribs );
			$pfAttribs->args[0] = new KV(
				$resolvedTgt['pfArg'], [],
				$resolvedTgt['srcOffsets']->expandTsrK()
			);
			$env->log( 'debug', 'entering prefix', $target, $state['token'] );
			$res = call_user_func( [ $this->parserFunctions, $target ],
				$state['token'], $this->manager->getFrame(), $pfAttribs );
			if ( $this->wrapTemplates ) {
				$res = $this->parserFunctionsWrapper( $state, $res );
			}
			return $res;
		}

		// Loop detection needs to be enabled since we're doing our own template expansion
		$error = $this->enforceTemplateConstraints( $target, $resolvedTgt['title'], false );
		if ( is_array( $error ) ) {
			return $error;
		}

		// XXX: notes from brion's mediawiki.parser.environment
		// resolve template name
		// load template w/ canonical name
		// load template w/ variant names (language variants)

		// strip template target
		$attribs = array_slice( $attribs, 1 );

		// Fetch template source and expand it
		$title = $resolvedTgt['title'];
		$res = $this->fetchTemplateAndTitle( $target, $state, $attribs );
		if ( isset( $res['tplSrc'] ) ) {
			return $this->processTemplateSource(
				$state,
				[ 'name' => $target, 'title' => $title, 'attribs' => $attribs ],
				$res['tplSrc']
			);
		} else {
			return $res['tokens'];
		}
	}

	/**
	 * Process a fetched template source to a token stream.
	 *
	 * @param array $state
	 * @param array $tplArgs
	 * @param ?string $src
	 * @return array
	 */
	private function processTemplateSource(
		array $state, array $tplArgs, ?string $src
	): array {
		if ( $src === null ) {
			// We have a choice between aborting or keeping going and reporting the
			// error inline.
			// TODO: report as special error token and format / remove that just
			// before the serializer. (something like <mw:error ../> as source)
			$src = '';
		}
		$env = $this->env;
		if ( $env->hasDumpFlag( 'tplsrc' ) ) {
			$env->log( 'dump/tplsrc', str_repeat( '=', 80 ) );
			$env->log( 'dump/tplsrc', 'TEMPLATE:', $tplArgs['name'], '; TRANSCLUSION:',
				PHPUtils::jsonEncode( $state['token']->dataAttribs->src ) );
			$env->log( 'dump/tplsrc', str_repeat( '-', 80 ) );
			$env->log( 'dump/tplsrc', $src );
			$env->log( 'dump/tplsrc', str_repeat( '-', 80 ) );
		}

		$env->log( 'debug', 'TemplateHandler.processTemplateSource',
			$tplArgs['name'], $tplArgs['attribs'] );

		// Get a nested transformation pipeline for the wikitext that takes
		// us through stages 1-2, with the appropriate pipeline options set.
		//
		// Simply returning the tokenized source here (which may be correct
		// when using the legacy preprocessor because we don't expect to
		// tokenize any templates or include directives so skipping those
		// handlers should be ok) won't work since the options for the pipeline
		// we're in probably aren't what we want.
		$toks = PipelineUtils::processContentInPipeline(
			$env,
			$this->manager->getFrame(),
			$src,
			[
				'pipelineType' => 'text/x-mediawiki',
				'pipelineOpts' => [
					'inTemplate' => true,
					'isInclude' => true,
					// FIXME: In reality, this is broken for parser tests where
					// we expand templates natively. We do want all nested templates
					// to be expanded. But, setting this to !usePHPPreProcessor seems
					// to break a number of tests. Not pursuing this line of enquiry
					// for now since this parserTests vs production distinction will
					// disappear with parser integration. We'll just bear the stench
					// till that time.
					//
					// NOTE: No expansion required for nested templates.
					'expandTemplates' => false,
					'extTag' => $this->options['extTag'] ?? null
				],
				'srcText' => $src,
				'srcOffsets' => new SourceRange( 0, strlen( $src ) ),
				'tplArgs' => $tplArgs,
				'sol' => true
			]
		);

		$toks = $this->processTemplateTokens( $state, $toks );

		// Shuttle tokens to the end of the stage since they've gone through the
		// rest of the handlers in the current pipeline in the pipeline above.
		return $this->manager->shuttleTokensToEndOfStage( $toks );
	}

	/**
	 * Process the main template element, including the arguments.
	 *
	 * @param array $state
	 * @param array $tokens
	 * @return array
	 */
	private function encapTokens( array $state, array $tokens ): array {
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

		$encap = new TemplateEncapsulator(
			$this->env,
			$this->manager->getFrame(),
			$state['token'],
			$state['wrapperType'],
			$state['wrappedObjectId'],
			$state['parserFunctionName'] ?? null,
			$state['resolvedTemplateTarget'] ?? null
		);
		return $encap->encapTokens( $tokens );
	}

	/**
	 * Handle chunk emitted from the input pipeline after feeding it a template.
	 *
	 * @param array $state
	 * @param array $chunk
	 * @return array
	 */
	private function processTemplateTokens( array $state, array $chunk ): array {
		TokenUtils::stripEOFTkfromTokens( $chunk );

		foreach ( $chunk as $i => $t ) {
			if ( $t && isset( $t->dataAttribs->tsr ) ) {
				unset( $t->dataAttribs->tsr );
			}
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
	 * @param array $state
	 * @param array $attribs
	 * @return array
	 */
	private function fetchTemplateAndTitle(
		string $templateName, array $state, array $attribs
	): array {
		$env = $this->env;
		if ( isset( $env->pageCache[$templateName] ) ) {
			$tplSrc = $env->pageCache[$templateName];
		} else {
			$start = microtime( true );
			$pageContent = $env->getDataAccess()->fetchTemplateSource( $env->getPageConfig(), $templateName );
			if ( $env->profiling() ) {
				$profile = $env->getCurrentProfile();
				$profile->bumpMWTime( "TemplateFetch", 1000 * ( microtime( true ) - $start ), "api" );
				$profile->bumpCount( "TemplateFetch" );
			}
			if ( !$pageContent ) {
				// Missing page!
				// FIXME: This should be a redlink here!
				$tplSrc = '';
			} else {
				// PORT-FIXME: Hard-coded 'main' role
				$tplSrc = $pageContent->getContent( 'main' );
			}
		}
		return [ 'tplSrc' => $tplSrc ];
	}

	/**
	 * @param mixed $arg
	 * @param SourceRange $srcOffsets
	 * @return array
	 */
	private function fetchArg( $arg, SourceRange $srcOffsets ): array {
		if ( is_string( $arg ) ) {
			return [ $arg ];
		} else {
			return $this->manager->getFrame()->expand( $arg, [
				'expandTemplates' => false,
				'inTemplate' => false,
				'srcOffsets' => $srcOffsets,
			] );
		}
	}

	/**
	 * @param array $args
	 * @param KV[] $attribs
	 * @param array $toks
	 * @return array
	 */
	private function lookupArg( array $args, array $attribs, array $toks ): array {
		$argName = trim( TokenUtils::tokensToString( $toks ) );
		$res = $args['dict'][$argName] ?? null;

		if ( $res !== null ) {
			$res = isset( $args['namedArgs'][$argName] ) ? TokenUtils::tokenTrim( $res ) : $res;
			return is_string( $res ) ? [ $res ] : $res;
		} elseif ( count( $attribs ) > 1 ) {
			return $this->fetchArg( $attribs[1]->v, $attribs[1]->srcOffsets->value );
		} else {
			return [ '{{{' . $argName . '}}}' ];
		}
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
	 * Extract tokens from the $targetToks token array that correspond to
	 * parser function args.
	 * FIXME: This method below can probably be dramatically simplified given that
	 * this is now only processed for magic words.
	 *
	 * @param string $prefix
	 * @param bool $haveArgsAfterColon
	 * @param array $targetToks
	 * @return array
	 */
	private function extractParserFunctionToks(
		string $prefix, bool $haveArgsAfterColon, array $targetToks
	): array {
		$pfArgToks = null;

		// Because of the lenient stringifying earlier, we need to find the prefix.
		// The strings we've seen so far are buffered in case they combine to our prefix.
		// FIXME: We need to account for the call to $this->stripIncludeTokens
		// and the safesubst replace.
		$buf = '';
		$index = -1;
		$partialPrefix = false;
		foreach ( $targetToks as $i => $t ) {
			if ( !is_string( $t ) ) {
				continue;
			}

			$buf .= $t;
			$prefixPos = stripos( $buf, $prefix );
			if ( $prefixPos !== false ) {
				// Check if they combined
				$offset = strlen( $buf ) - strlen( $t ) - $prefixPos;
				if ( $offset > 0 ) {
					$partialPrefix = substr( $prefix, $offset );
				}
				$index = $i;
				break;
			}
		}

		if ( $index > -1 ) {
			// Strip parser-func / magic-word prefix
			$firstTok = $targetToks[$index];
			if ( $partialPrefix !== false ) {
				// Remove the partial prefix if it case insensitively
				// appears at the start of the token
				if ( substr_compare( $firstTok, $partialPrefix,
						0, strlen( $partialPrefix ), true ) === 0
				) {
					$firstTok = substr( $firstTok, strlen( $partialPrefix ) );
				}
			} else {
				// Remove the first occurrence of the prefix from $firstTok,
				// case insensitively
				$prefixPos = stripos( $firstTok, $prefix );
				if ( $prefixPos !== false ) {
					$firstTok = substr( $firstTok, $prefixPos + strlen( $prefix ) );
				}
			}
			$targetToks = array_slice( $targetToks, $index + 1 );

			if ( $haveArgsAfterColon ) {
				// Strip ":", again, after accounting for the lenient stringifying
				while ( count( $targetToks ) > 0 &&
					( !is_string( $firstTok ) || preg_match( '/^\s*$/D', $firstTok ) )
				) {
					$firstTok = $targetToks[0];
					$targetToks = array_slice( $targetToks, 1 );
				}
				Assert::invariant( is_string( $firstTok ) && preg_match( '/^\s*:/', $firstTok ),
					'Expecting : in parser function definiton'
				);
				$pfArgToks = array_merge( [ preg_replace( '/^\s*:/', '', $firstTok, 1 ) ], $targetToks );
			} else {
				$pfArgToks = array_merge( [ $firstTok ], $targetToks );
			}
		}

		if ( $pfArgToks === null ) {
			// FIXME: Protect from crashers by using the full token -- this is
			// still going to generate incorrect output, but it won't crash.
			$pfArgToks = $targetToks;
		}

		return $pfArgToks;
	}

	/**
	 * Process the special magic word as specified by `resolvedTgt.magicWordType`.
	 * ```
	 * magicWordType === '!'    => {{!}} is the magic word
	 * magicWordtype === 'MASQ' => DEFAULTSORT, DISPLAYTITLE are the magic words
	 *                             (Util.magicMasqs.has(..))
	 * ```
	 * @param bool $atTopLevel
	 * @param Token $tplToken
	 * @param array $resolvedTgt
	 * @return ?array
	 */
	public function processSpecialMagicWord(
		bool $atTopLevel, Token $tplToken, array $resolvedTgt
	): ?array {
		$env = $this->env;

		// Special case for {{!}} magic word.
		//
		// If we tokenized as a magic word, we meant for it to expand to a
		// string.  The tokenizer has handling for this syntax in table
		// positions.  However, proceeding to go through template expansion
		// will reparse it as a table cell token.  Hence this special case
		// handling to avoid that path.
		if ( $resolvedTgt['magicWordType'] === '!' || $tplToken->attribs[0]->k === '!' ) {
			// If we're not at the top level, return a table cell. This will always
			// be the case. Either {{!}} was tokenized as a td, or it was tokenized
			// as template but the recursive call to fetch its content returns a
			// single | in an ambiguous context which will again be tokenized as td.
			// In any case, this should only be relevant for parserTests.
			if ( empty( $atTopLevel ) ) {
				return [ new TagTk( 'td' ) ];
			}
			$state = [
				'token' => $tplToken,
				'wrapperType' => 'mw:Transclusion',
				'wrappedObjectId' => $env->newObjectId()
			];
			$this->resolveTemplateTarget( $state, '!', $tplToken->attribs[0]->srcOffsets->key );
			$toks = [ '|' ];
			return $this->wrapTemplates ?
				$this->encapTokens( $state, $toks ) : $toks;
		}

		if ( $resolvedTgt['magicWordType'] !== 'MASQ' ) {
			// Nothing to do
			// FIXME: This is going to result in a throw
			return null;
		}

		$magicWord = mb_strtolower( $resolvedTgt['prefix'] );
		$pageProp = 'mw:PageProp/';
		if ( $magicWord === 'defaultsort' ) {
			$pageProp .= 'category';
		}
		$pageProp .= $magicWord;

		$metaToken = new SelfclosingTagTk( 'meta',
			[ new KV( 'property', $pageProp ) ],
			$tplToken->dataAttribs->clone()
		);

		if ( isset( $tplToken->dataAttribs->tmp->templatedAttribs ) ) {
			$pfArgToks = $this->extractParserFunctionToks(
				$resolvedTgt['prefix'],
				$resolvedTgt['haveArgsAfterColon'],
				$resolvedTgt['targetToks']
			);
			// No shadowing if templated
			//
			// SSS FIXME: post-tpl-expansion, WS won't be trimmed. How do we handle this?
			$metaToken->addAttribute( 'content', $pfArgToks, $resolvedTgt['srcOffsets']->expandTsrV() );
			$metaToken->addAttribute( 'about', $env->newAboutId() );
			$metaToken->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );

			// See [[mw:Specs/HTML#Generated_attributes_of_HTML_tags]]
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
			// FIXME: the content still contains the parser function prefix
			//  (eg, the html is 'DISPLAYTITLE:Foo' even though the stripped
			//   content attribute is 'Foo')
			$ta = $tplToken->dataAttribs->tmp->templatedAttribs;
			$ta[0] = [
				[ 'txt' => 'content' ],         // Magic-word attribute name
				[ 'html' => $ta[0][0]['html'] ] // HTML repn. of the attribute value
			];
			$metaToken->addAttribute( 'data-mw', PHPUtils::jsonEncode( [ 'attribs' => $ta ] ) );
		} else {
			// Leading/trailing WS should be stripped
			$key = trim( $resolvedTgt['pfArg'] );

			$src = $tplToken->dataAttribs->src ?? '';
			if ( $src ) {
				// If the token has original wikitext, shadow the sort-key
				$origKey = PHPUtils::stripSuffix( preg_replace( '/[^:]+:?/', '', $src, 1 ), '}}' );
				$metaToken->addNormalizedAttribute( 'content', $key, $origKey );
			} else {
				// If not, this token came from an extension/template
				// in which case, dont bother with shadowing since the token
				// will never be edited directly.
				$metaToken->addAttribute( 'content', $key );
			}
		}

		return [ $metaToken ];
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
		$env = $this->env;
		$expandTemplates = $this->options['expandTemplates'];

		// Since AttributeExpander runs later in the pipeline than TemplateHandler,
		// if the template name is templated, use our copy of AttributeExpander
		// to process all attributes to tokens, and force reprocessing of this
		// template token since we will then know the actual template target.
		if ( $expandTemplates && self::hasTemplateToken( $token->attribs[0]->k ) ) {
			$ret = $this->ae->processComplexAttributes( $token );
			$toks = $ret->tokens ?? null;
			Assert::invariant( $toks && count( $toks ) === 1 && $toks[0] === $token,
				"Expected only the input token as the return value." );
		}

		if ( $this->atMaxArticleSize ) {
			// As described above, if we were already greater than $wgMaxArticleSize
			// we're going to return the tokens without expanding them.
			// (This case is where the original article as fetched from the DB
			// or passed to the API exceeded max article size.)
			return new TokenHandlerResult( $this->convertToString( $token ) );
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
			return new TokenHandlerResult( $this->convertToString( $token ) );
		}

		$toks = null;
		$text = $token->dataAttribs->src ?? '';
		$state = [
			'token' => $token,
			'wrapperType' => 'mw:Transclusion',
			'wrappedObjectId' => $env->newObjectId(),
		];

		$tgt = $this->resolveTemplateTarget(
			$state, $token->attribs[0]->k, $token->attribs[0]->srcOffsets->key
		);

		if ( $expandTemplates && $tgt === null ) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			return new TokenHandlerResult( $this->convertToString( $token ) );
		}

		if ( isset( $tgt['magicWordType'] ) ) {
			$toks = $this->processSpecialMagicWord( $this->atTopLevel, $token, $tgt );
			Assert::invariant( $toks !== null, "Expected non-null tokens array." );
			return new TokenHandlerResult( $toks );
		}

		if ( $env->nativeTemplateExpansionEnabled() ) {
			// Expand argument keys
			$atm = new AttributeTransformManager( $this->manager->getFrame(),
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
				return new TokenHandlerResult( $this->convertToString( $token ) );
			}
			$tplToks = $this->expandTemplate( $state, $resolvedTgt, $newAttribs );
			return new TokenHandlerResult(
				( $expandTemplates && $this->wrapTemplates ) ?
					$this->encapTokens( $state, $tplToks ) : $tplToks
			);
		} else {
			if ( $expandTemplates ) {
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
				$templateName = $tgt['target'];
				$templateTitle = $tgt['title'];
				$attribs = array_slice( $token->attribs, 1 ); // Strip template name

				// We still need to check for limit violations because of the
				// higher precedence of extension tags, which can result in nested
				// templates even while using the php preprocessor for expansion.
				$error = $this->enforceTemplateConstraints( $templateName, $templateTitle, true );
				if ( is_array( $error ) ) {
					return new TokenHandlerResult( $error );
				}

				// Check if we have an expansion for this template in the cache already
				$cachedTransclusion = $env->transclusionCache[$text] ?? null;
				if ( $cachedTransclusion ) {
					// cache hit: reuse the expansion DOM
					// FIXME(SSS): How does this work again for
					// templates like {{start table}} and {[end table}}??
					return new TokenHandlerResult(
						PipelineUtils::encapsulateExpansionHTML( $env, $token, $cachedTransclusion, [
							'fromCache' => true
						] )
					);
				} else {
					// Fetch and process the template expansion
					$expansion = Wikitext::preprocess( $env, $text );
					if ( $expansion['error'] ) {
						$tplToks = [ $expansion['src'] ];
					} else {
						$tplToks = $this->processTemplateSource(
							$state,
							[
								'name' => $templateName,
								'title' => $templateTitle,
								'attribs' => $attribs
							],
							$expansion['src']
						);
					}
					return new TokenHandlerResult(
						$this->wrapTemplates ? $this->encapTokens( $state, $tplToks ) : $tplToks
					);
				}
			} else {
				// We don't perform recursive template expansion- something
				// template-like that the PHP parser did not expand. This is
				// encapsulated already, so just return the plain text.
				Assert::invariant( TokenUtils::isTemplateToken( $token ), "Expected template token." );
				return new TokenHandlerResult( $this->convertToString( $token ) );
			}
		}
	}

	/**
	 * Expand template arguments with tokens from the containing frame.
	 * @param Token $token
	 * @return TokenHandlerResult
	 */
	private function onTemplateArg( Token $token ): TokenHandlerResult {
		$args = $this->manager->getFrame()->getArgs()->named();
		$attribs = $token->attribs;

		$toks = $this->fetchArg( $attribs[0]->k, $attribs[0]->srcOffsets->key );
		$toks = $this->lookupArg( $args, $attribs, $toks );

		// Shuttle tokens to the end of the stage since they've gone through the
		// rest of the handlers in the current pipeline in the pipeline above.
		$toks = $this->manager->shuttleTokensToEndOfStage( $toks );

		if ( $this->wrapTemplates && $this->options['expandTemplates'] ) {
			// This is a bare use of template arg syntax at the top level
			// outside any template use context.  Wrap this use with RDF attrs.
			// so that this chunk can be RT-ed en-masse.
			$state = [
				'token' => $token,
				'wrapperType' => 'mw:Param',
				'wrappedObjectId' => $this->env->newObjectId()
			];
			return new TokenHandlerResult( $this->encapTokens( $state, $toks ) );
		} else {
			return new TokenHandlerResult( $toks );
		}
	}

	/**
	 * @param Token $token
	 * @return TokenHandlerResult|null
	 */
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
