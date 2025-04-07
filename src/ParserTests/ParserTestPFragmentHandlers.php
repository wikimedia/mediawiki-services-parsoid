<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Ext\Arguments;
use Wikimedia\Parsoid\Ext\AsyncResult;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\PFragmentHandler;
use Wikimedia\Parsoid\Fragments\HtmlPFragment;
use Wikimedia\Parsoid\Fragments\LiteralStringPFragment;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;

/**
 * Various PFragmentHandler implementations used in parser tests.
 * @see ParserHook for registration
 */
class ParserTestPFragmentHandlers {

	/**
	 * Ensure that both integrated and standalone test runners have the
	 * magic word definitions used by these PFragment handlers.
	 * @see SiteConfig::getCustomSiteConfigFileName()
	 * @see ParserTestRunner::staticSetup() (in core)
	 */
	public static function getParserTestConfigFileName(): string {
		return __DIR__ . "/ParserTests.siteconfig.json";
	}

	/**
	 * Return a configuration fragment for the PFragmentHandlers defined
	 * here.
	 * @see ParserHook::getConfig()
	 */
	public static function getPFragmentHandlersConfig(): array {
		// This is a list of "normal" parser function PFragment handlers;
		// no special options.
		$normalPFs = [
			// Following keys must be present in ParserTests.siteconfig.json
			// and as cases in ::getHandler() below.
			'f1_wt', 'f2_if', 'f3_uc',
			'f4_return_html', 'f5_from_nowiki',
			'f7_kv', 'f8_countargs',
		];
		$handlerFactory = self::class . '::getHandler';
		$pFragmentConfig = array_map( static fn ( $key ) => [
			'key' => $key,
			'handler' => [
				'factory' => $handlerFactory,
				'args' => [ $key ],
			],
			'options' => [ 'parserFunction' => true, ],
		], $normalPFs );

		// "Uncommon" parser function PFragment handlers
		$pFragmentConfig[] = [
			'key' => 'f1_wt_nohash',
			'handler' => [
				'factory' => $handlerFactory,
				'args' => [ "f1_wt_nohash" ],
			],
			'options' => [
				'parserFunction' => true,
				# 'magicVariable' => true, # Not yet implemented: T391063
				'nohash' => true,
			],
		];
		$pFragmentConfig[] = [
			'key' => 'f6_async_return',
			'handler' => [
				'factory' => $handlerFactory,
				'args' => [ "f6_async_return" ]
			],
			'options' => [
				'parserFunction' => true,
				'hasAsyncContent' => true,
			],
		];
		return $pFragmentConfig;
	}

	/**
	 * Return a handler for a registered parser function
	 *
	 * @param string $fn
	 *
	 * @return PFragmentHandler
	 */
	public static function getHandler( string $fn ): PFragmentHandler {
		switch ( $fn ) {
			case 'f1_wt':
			case 'f1_wt_nohash':
				// This is a test function which simply concatenates all of
				// its (ordered) arguments.
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						$result = [];
						foreach ( $arguments->getOrderedArgs( $extApi ) as $a ) {
							$result[] = $a;
							$result[] = ' ';
						}
						if ( $result ) {
							array_pop( $result ); // remove trailing space
						}
						return WikitextPFragment::newFromSplitWt(
							$result, null, true
						);
					}
				};

			case 'f2_if':
				// This is our implementation of the {{#if:..}} parser function.
				// Extension or other fragments will evaluate to 'true'
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						$args = $arguments->getOrderedArgs( $extApi, false );
						$test = $args[0] ?? null;
						if ( $test === null ) {
							$result = '';
						} else {
							// Eager evaluation of the 'test'
							$test = $test->expand( $extApi );
							if ( $test->containsMarker() ) {
								$result = '1'; // non-empty value
							} else {
								$result = trim( $test->killMarkers() );
							}
						}
						$empty = WikitextPFragment::newFromLiteral( '', null );
						// Note that we are doing lazy evaluation of the
						// 'then' and 'else' branches, mostly as a test case
						// and demonstration.  The actual {{#if}}
						// implementation in core eagerly evaluates the result
						// in order to trim() it.
						if ( $result !== '' ) {
							return $args[1] ?? $empty;
						} else {
							return $args[2] ?? $empty;
						}
					}
				};

			case 'f3_uc':
				// This is our implementation of the {{uc:..}} parser function.
				// It skips over extension and other DOM fragments (legacy
				// parser uses markerSkipCallback in core).
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						// Expand before using markerSkipCallback, or else
						// we'll end up expanding inside extension tags, etc.
						$s = $arguments->getOrderedArgs( $extApi )[0] ??
						   WikitextPFragment::newFromLiteral( '', null );
						return $s->markerSkipCallback( "mb_strtoupper" );
					}
				};

			case 'f4_return_html':
				// Demonstrate returning an HTML fragment from a parser
				// function
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						return HtmlPFragment::newFromHtmlString(
							'html <b> contents',
							null
						);
					}
				};

			case 'f5_from_nowiki':
				// Demonstrate fetching the raw text of an argument which
				// was protected with <nowiki>
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						$s = $arguments->getOrderedArgs( $extApi )[0] ?? null;
						$s = ( $s === null ) ? '' : $s->toRawText( $extApi );
						// reverse the string to demonstrate processing;
						// this also disrupts/reveals any &-entities!
						$s = strrev( $s );
						// LiteralStringPFragment can be chained between
						// FragmentHandlers to safely pass raw text.
						return LiteralStringPFragment::newFromLiteral( $s, null );
					}
				};

			case 'f6_async_return':
				// Demonstrate a conditionally-asynchronous return.
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						$args = $arguments->getOrderedArgs( $extApi, [
							true, false // 'content' argument is lazy
						] );
						$notready = $args[0] ? $args[0]->toRawText( $extApi ) : '';
						$content = $args[1] ?? null; // lazy
						if ( $notready == 'not ready' ) {
							// Return "not ready yet" with $content
							// (which could be null if second arg is missing)
							return new class( $content ) extends AsyncResult {
								public ?PFragment $content;

								public function __construct( ?PFragment $f ) {
									$this->content = $f;
								}

								public function fallbackContent( ParsoidExtensionAPI $extAPI ): ?PFragment {
									return $this->content;
								}
							};
						}
						// The content is "ready", just return $content.
						return $content ??
							LiteralStringPFragment::newFromLiteral( '<missing>', null );
					}
				};

			case 'f7_kv':
				// Demonstrate Arguments as return value
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						return new class( $arguments ) extends PFragment implements Arguments {
							private Arguments $arguments;

							public function __construct( Arguments $arguments ) {
								parent::__construct( null );
								$this->arguments = $arguments;
							}

							/** @inheritDoc */
							public function asHtmlString( ParsoidExtensionAPI $extApi ): string {
								return '(arguments)';
							}

							/** @inheritDoc */
							public function getOrderedArgs(
								ParsoidExtensionAPI $extApi,
								$expandAndTrim = true
							): array {
								return $this->arguments->getOrderedArgs( $extApi, $expandAndTrim );
							}

							/** @inheritDoc */
							public function getNamedArgs(
								ParsoidExtensionAPI $extApi,
								$expandAndTrim = true
							): array {
								return $this->arguments->getNamedArgs( $extApi, $expandAndTrim );
							}
						};
					}
				};

			case 'f8_countargs':
				// This is a test function which simply reports the number
				// of ordered arguments.
				return new class extends PFragmentHandler {
					/** @inheritDoc */
					public function sourceToFragment(
						ParsoidExtensionAPI $extApi,
						Arguments $arguments,
						bool $tagSyntax
					) {
						return LiteralStringPFragment::newFromLiteral(
							strval( count( $arguments->getOrderedArgs( $extApi ) ) ),
							null
						);
					}
				};

			default:
				throw new UnreachableException( "Unknown parser function $fn" );
		}
	}
}
