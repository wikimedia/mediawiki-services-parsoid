<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Closure;
use DateTime;
use Generator;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Perform post-processing steps on an already-built HTML DOM.
 */
class DOMPostProcessor extends PipelineStage {
	private array $options;
	private array $processors = [];
	private ParsoidExtensionAPI $extApi; // Provides post-processing support to extensions
	private array $metadataMap;
	private string $timeProfile = '';
	private ?SelectiveUpdateData $selparData = null;

	public function __construct(
		Env $env, array $options = [], string $stageId = "",
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );

		$this->options = $options;
		$this->extApi = new ParsoidExtensionAPI( $env );

		// map from mediawiki metadata names to RDFa property names
		$this->metadataMap = [
			'ns' => [
				'property' => 'mw:pageNamespace',
				'content' => '%d',
			],
			'id' => [
				'property' => 'mw:pageId',
				'content' => '%d',
			],

			// DO NOT ADD rev_user, rev_userid, and rev_comment (See T125266)

			// 'rev_revid' is used to set the overall subject of the document, we don't
			// need to add a specific <meta> or <link> element for it.

			'rev_parentid' => [
				'rel' => 'dc:replaces',
				'resource' => 'mwr:revision/%d',
			],
			'rev_timestamp' => [
				'property' => 'dc:modified',
				'content' => static function ( $m ) {
					# Convert from TS_MW ("mediawiki timestamp") format
					$dt = DateTime::createFromFormat( 'YmdHis', $m['rev_timestamp'] );
					# Note that DateTime::ISO8601 is not actually ISO8601, alas.
					return $dt->format( 'Y-m-d\TH:i:s.000\Z' );
				},
			],
			'rev_sha1' => [
				'property' => 'mw:revisionSHA1',
				'content' => '%s',
			]
		];
	}

	public function registerProcessors( ?array $processors ): void {
		foreach ( $processors as $p ) {
			$p['name'] ??= Utils::stripNamespace( $p['Processor'] );
			$p['shortcut'] ??= $p['name'];
			if ( empty( $p['isTraverser'] ) ) {
				// Internal processor w/ ::run() method, class name given
				// @phan-suppress-next-line PhanNonClassMethodCall
				$p['proc'] = new $p['Processor']();
			} else {
				$t = new DOMPPTraverser(
					$p['tplInfo'] ?? false,
					$p['applyToAttributeEmbeddedHTML'] ?? false
				);
				foreach ( $p['handlers'] as $h ) {
					$t->addHandler( $h['nodeName'], $h['action'] );
				}
				$p['proc'] = $t;
			}
			$this->processors[] = $p;
		}
	}

	/* ---------------------------------------------------------------------------
	 * FIXME:
	 * 1. PipelineFactory caches pipelines per env
	 * 2. PipelineFactory.parse uses a default cache key
	 * 3. ParserTests uses a shared/global env object for all tests.
	 * 4. ParserTests also uses PipelineFactory.parse (via env.getContentHandler())
	 *    => the pipeline constructed for the first test that runs wt2html
	 *       is used for all subsequent wt2html tests
	 * 5. If we are selectively turning on/off options on a per-test basis
	 *    in parser tests, those options won't work if those options are
	 *    also used to configure pipeline construction (including which DOM passes
	 *    are enabled).
	 *
	 *    Ex: if (env.wrapSections) { addPP('wrapSections', wrapSections); }
	 *
	 *    This won't do what you expect it to do. This is primarily a
	 *    parser tests script issue -- but given the abstraction layers that
	 *    are on top of the parser pipeline construction, fixing that is
	 *    not straightforward right now. So, this note is a warning to future
	 *    developers to pay attention to how they construct pipelines.
	 * --------------------------------------------------------------------------- */

	/**
	 * @inheritDoc
	 */
	public function setSourceOffsets( SourceRange $so ): void {
		$this->options['sourceOffsets'] = $so;
	}

	private function updateBodyClasslist( Element $body, Env $env ): void {
		$dir = $env->getPageConfig()->getPageLanguageDir();
		$bodyCL = DOMCompat::getClassList( $body );
		$bodyCL->add( 'mw-content-' . $dir );
		$bodyCL->add( 'sitedir-' . $dir );
		$bodyCL->add( $dir );
		$body->setAttribute( 'dir', $dir );

		// Set 'mw-body-content' directly on the body.
		// This is the designated successor for #bodyContent in core skins.
		$bodyCL->add( 'mw-body-content' );
		// Set 'parsoid-body' to add the desired layout styling from Vector.
		$bodyCL->add( 'parsoid-body' );
		// Also, add the 'mediawiki' class.
		// Some MediaWiki:Common.css seem to target this selector.
		$bodyCL->add( 'mediawiki' );
		// Set 'mw-parser-output' directly on the body.
		// Templates target this class as part of the TemplateStyles RFC
		// FIXME: This isn't expected to be found on the same element as the
		// body class above, since some css targets it as a descendant.
		// In visual diff'ing, we migrate the body contents to a wrapper div
		// with this class to reduce visual differences.  Consider getting
		// rid of it.
		$bodyCL->add( 'mw-parser-output' );

		// Set the parsoid version on the body, for consistency with
		// the wrapper div.
		$body->setAttribute( 'data-mw-parsoid-version', Parsoid::version() );
		$body->setAttribute( 'data-mw-html-version', Parsoid::defaultHTMLVersion() );
	}

	/**
	 * FIXME: consider moving to DOMUtils or Env.
	 *
	 * @param Env $env
	 * @param Document $document
	 */
	public function addMetaData( Env $env, Document $document ): void {
		$title = $env->getContextTitle();

		// Set the charset in the <head> first.
		// This also adds the <head> element if it was missing.
		DOMUtils::appendToHead( $document, 'meta', [ 'charset' => 'utf-8' ] );

		// add mw: and mwr: RDFa prefixes
		$prefixes = [
			'dc: http://purl.org/dc/terms/',
			'mw: http://mediawiki.org/rdf/'
		];
		$document->documentElement->setAttribute( 'prefix', implode( ' ', $prefixes ) );

		// (From wfParseUrl in core:)
		// Protocol-relative URLs are handled really badly by parse_url().
		// It's so bad that the easiest way to handle them is to just prepend
		// 'https:' and strip the protocol out later.
		$baseURI = $env->getSiteConfig()->baseURI();
		$wasRelative = substr( $baseURI, 0, 2 ) == '//';
		if ( $wasRelative ) {
			$baseURI = "https:$baseURI";
		}
		// add 'https://' to baseURI if it was missing
		$pu = parse_url( $baseURI );
		$mwrPrefix = ( !empty( $pu['scheme'] ) ? '' : 'https://' ) .
			$baseURI . 'Special:Redirect/';

		( DOMCompat::getHead( $document ) )->setAttribute( 'prefix', 'mwr: ' . $mwrPrefix );

		// add <head> content based on page meta data:

		// Add page / revision metadata to the <head>
		// PORT-FIXME: We will need to do some refactoring to eliminate
		// this hardcoding. Probably even merge this into metadataMap
		$pageConfig = $env->getPageConfig();
		$revProps = [
			'id' => $pageConfig->getPageId(),
			'ns' => $title->getNamespace(),
			'rev_parentid' => $pageConfig->getParentRevisionId(),
			'rev_revid' => $pageConfig->getRevisionId(),
			'rev_sha1' => $pageConfig->getRevisionSha1(),
			'rev_timestamp' => $pageConfig->getRevisionTimestamp()
		];
		foreach ( $revProps as $key => $value ) {
			// generate proper attributes for the <meta> or <link> tag
			if ( $value === null || $value === '' || !isset( $this->metadataMap[$key] ) ) {
				continue;
			}

			$attrs = [];
			$mdm = $this->metadataMap[$key];

			/** FIXME: The JS side has a bunch of other checks here */

			foreach ( $mdm as $k => $v ) {
				// evaluate a function, or perform sprintf-style formatting, or
				// use string directly, depending on value in metadataMap
				if ( $v instanceof Closure ) {
					$v = $v( $revProps );
				} elseif ( strpos( $v, '%' ) !== false ) {
					// @phan-suppress-next-line PhanPluginPrintfVariableFormatString
					$v = sprintf( $v, $value );
				}
				$attrs[$k] = $v;
			}

			// <link> is used if there's a resource or href attribute.
			DOMUtils::appendToHead( $document,
				isset( $attrs['resource'] ) || isset( $attrs['href'] ) ? 'link' : 'meta',
				$attrs
			);
		}

		if ( $revProps['rev_revid'] ) {
			$document->documentElement->setAttribute(
				'about', $mwrPrefix . 'revision/' . $revProps['rev_revid']
			);
		}

		// Normalize before comparison
		if ( $title->isSameLinkAs( $env->getSiteConfig()->mainPageLinkTarget() ) ) {
			DOMUtils::appendToHead( $document, 'meta', [
				'property' => 'isMainPage',
				'content' => 'true' /* HTML attribute values should be strings */
			] );
		}

		// Set the parsoid content-type strings
		// FIXME: Should we be using http-equiv for this?
		DOMUtils::appendToHead( $document, 'meta', [
				'property' => 'mw:htmlVersion',
				'content' => $env->getOutputContentVersion()
			]
		);
		// Temporary backward compatibility for clients
		// This could be skipped if we support a version downgrade path
		// with a major version bump.
		DOMUtils::appendToHead( $document, 'meta', [
				'property' => 'mw:html:version',
				'content' => $env->getOutputContentVersion()
			]
		);

		$expTitle = explode( '/', $title->getPrefixedDBKey() );
		$expTitle = array_map( static function ( $comp ) {
			return PHPUtils::encodeURIComponent( $comp );
		}, $expTitle );

		DOMUtils::appendToHead( $document, 'link', [
			'rel' => 'dc:isVersionOf',
			'href' => $env->getSiteConfig()->baseURI() . implode( '/', $expTitle )
		] );

		// Add base href pointing to the wiki root
		DOMUtils::appendToHead( $document, 'base', [
			'href' => $env->getSiteConfig()->baseURI()
		] );

		// Stick data attributes in the head
		if ( $env->pageBundle ) {
			DOMDataUtils::injectPageBundle( $document, DOMDataUtils::getPageBundle( $document ) );
		}

		// PageConfig guarantees language will always be non-null.
		$lang = $env->getPageConfig()->getPageLanguageBcp47();
		$body = DOMCompat::getBody( $document );
		$body->setAttribute( 'lang', $lang->toBcp47Code() );
		$this->updateBodyClasslist( $body, $env );
		// T324431: Note that this is *not* the displaytitle, and that
		// the title element contents are plaintext *not* HTML
		DOMCompat::setTitle( $document, $title->getPrefixedText() );
		$env->getSiteConfig()->exportMetadataToHeadBcp47(
			$document, $env->getMetadata(),
			$title->getPrefixedText(), $lang
		);

		// Indicate whether LanguageConverter is enabled, so that downstream
		// caches can split on variant (if necessary)
		DOMUtils::appendToHead( $document, 'meta', [
				'http-equiv' => 'content-language',
				// Note that this is "wrong": we should be returning
				// $env->htmlContentLanguageBcp47()->toBcp47Code() directly
				// but for back-compat we'll return the "old" mediawiki-internal
				// code for now
				'content' => Utils::bcp47ToMwCode( # T323052: remove this call
					$env->htmlContentLanguageBcp47()->toBcp47Code()
				),
			]
		);
		DOMUtils::appendToHead( $document, 'meta', [
				'http-equiv' => 'vary',
				'content' => $env->htmlVary()
			]
		);

		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			$body->appendChild( $body->ownerDocument->createTextNode( "\n" ) );
			$body->appendChild( $body->ownerDocument->createComment( $this->timeProfile ) );
			$body->appendChild( $body->ownerDocument->createTextNode( "\n" ) );
		}
	}

	public function doPostProcess( Node $node ): void {
		$env = $this->env;

		$hasDumpFlags = $env->hasDumpFlags();

		if ( $hasDumpFlags && $env->hasDumpFlag( 'dom:post-builder' ) ) {
			$opts = [];
			$env->writeDump( ContentUtils::dumpDOM( $node, 'DOM: after tree builder', $opts ) );
		}

		$prefix = null;
		$traceLevel = null;
		$resourceCategory = null;

		$profile = null;
		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			if ( $this->atTopLevel ) {
				$this->timeProfile = str_repeat( "-", 85 ) . "\n";
				$prefix = 'TOP';
				// Turn off DOM pass timing tracing on non-top-level documents
				$resourceCategory = 'DOMPasses:TOP';
			} else {
				$prefix = '---';
				$resourceCategory = 'DOMPasses:NESTED';
			}
		}

		foreach ( $this->processors as $pp ) {
			if ( $pp['applyToAttributeEmbeddedHTML'] ?? false ) {
				Assert::invariant( ( $pp['isTraverser'] ?? false ) === true,
					'applyToAttributeEmbeddedHTML can only be executed for DOM traverser passes, and ' . $pp['name'] .
					'is not such a pass' );
			}

			// error_log("RUNNING " . ($pp['shortcut'] ?? $pp['name']));

			if ( !empty( $pp['withAnnotations'] ) && !$this->env->hasAnnotations ) {
				continue;
			}

			$ppName = null;
			$ppStart = null;

			// Trace
			if ( $profile ) {
				$ppName = $pp['name'] . str_repeat(
					" ",
					( strlen( $pp['name'] ) < 30 ) ? 30 - strlen( $pp['name'] ) : 0
				);
				$ppStart = microtime( true );
			}

			$opts = null;
			if ( $hasDumpFlags ) {
				$opts = [
					'env' => $env,
					'dumpFragmentMap' => $this->atTopLevel,
					'keepTmp' => true
				];

				if ( $env->hasDumpFlag( 'dom:pre-' . $pp['shortcut'] )
					|| $env->hasDumpFlag( 'dom:pre-*' )
				) {
					$env->writeDump(
						ContentUtils::dumpDOM( $node, 'DOM: pre-' . $pp['shortcut'], $opts )
					);
				}
			}

			// FIXME: env, extApi, frame, selparData, options, atTopLevel can all be
			// put into a stdclass or a real class (DOMProcConfig?) and passed around.
			$pp['proc']->run(
				$this->env,
				$node,
				[
					'extApi' => $this->extApi,
					'frame' => $this->frame,
					'selparData' => $this->selparData,
				] + $this->options,
				$this->atTopLevel
			);

			if ( $hasDumpFlags && ( $env->hasDumpFlag( 'dom:post-' . $pp['shortcut'] )
				|| $env->hasDumpFlag( 'dom:post-*' ) )
			) {
				$env->writeDump(
					ContentUtils::dumpDOM( $node, 'DOM: post-' . $pp['shortcut'], $opts )
				);
			}

			if ( $profile ) {
				$ppElapsed = 1000 * ( microtime( true ) - $ppStart );
				if ( $this->atTopLevel ) {
					$this->timeProfile .= str_pad( $prefix . '; ' . $ppName, 65 ) .
						' time = ' .
						str_pad( number_format( $ppElapsed, 2 ), 10, ' ', STR_PAD_LEFT ) . "\n";
				}
				$profile->bumpTimeUse( $resourceCategory, $ppElapsed, 'DOM' );
			}
		}

		// For sub-pipeline documents, we are done.
		// For the top-level document, we generate <head> and add it.
		if ( $this->atTopLevel ) {
			self::addMetaData( $env, $node->ownerDocument );
			if ( $env->hasDumpFlag( 'wt2html:limits' ) ) {
				/*
				 * PORT-FIXME: Not yet implemented
				$env->printWt2HtmlResourceUsage( [
					'HTML Size' => strlen( DOMCompat::getOuterHTML( $document->documentElement ) )
				] );
				*/
			}
		}
	}

	/**
	 * @inheritDoc
	 */
	public function process( $node, array $opts = null ) {
		if ( isset( $opts['selparData'] ) ) {
			$this->selparData = $opts['selparData'];
		}
		'@phan-var Node $node'; // @var Node $node
		$this->doPostProcess( $node );
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $node;
	}

	/**
	 * @inheritDoc
	 */
	public function processChunkily( $input, ?array $options ): Generator {
		if ( $this->prevStage ) {
			// The previous stage will yield a DOM.
			// FIXME: Should we change the signature of that to return a DOM
			// If we do so, a pipeline stage returns either a generator or
			// concrete output (in this case, a DOM).
			$node = $this->prevStage->processChunkily( $input, $options )->current();
		} else {
			$node = $input;
		}
		$this->process( $node );
		yield $node;
	}
}
