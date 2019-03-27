<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Perform post-processing steps on an already-built HTML DOM.
 * @module
 */

namespace Parsoid;



use Parsoid\domino as domino;
use Parsoid\events as events;
use Parsoid\url as url;
use Parsoid\util as util;
use Parsoid\fs as fs;

$ContentUtils = require( '../utils/ContentUtils.js' )::ContentUtils;
$DOMDataUtils = require( '../utils/DOMDataUtils.js' )::DOMDataUtils;
$Util = require( '../utils/Util.js' )::Util;
$DOMTraverser = require( '../utils/DOMTraverser.js' )::DOMTraverser;
$LanguageConverter = require( '../language/LanguageConverter' )::LanguageConverter;
$Promise = require( '../utils/promise.js' );
$JSUtils = require( '../utils/jsutils.js' )::JSUtils;

// processors
$requireProcessor = function ( $p ) {
	return require( './pp/processors/' . $p . '.js' )[ $p ];
};
$MarkFosteredContent = $requireProcessor( 'MarkFosteredContent' );
$Linter = $requireProcessor( 'Linter' );
$ProcessTreeBuilderFixups = $requireProcessor( 'ProcessTreeBuilderFixups' );
$MigrateTemplateMarkerMetas = $requireProcessor( 'MigrateTemplateMarkerMetas' );
$HandlePres = $requireProcessor( 'HandlePres' );
$MigrateTrailingNLs = $requireProcessor( 'MigrateTrailingNLs' );
$ComputeDSR = $requireProcessor( 'ComputeDSR' );
$WrapTemplates = $requireProcessor( 'WrapTemplates' );
$WrapSections = $requireProcessor( 'WrapSections' );
$AddExtLinkClasses = $requireProcessor( 'AddExtLinkClasses' );
$PWrap = $requireProcessor( 'PWrap' );
$AddMediaInfo = $requireProcessor( 'AddMediaInfo' );
$PHPDOMTransform = null;

// handlers
$requireHandlers = function ( $h ) {
	return require( './pp/handlers/' . $h . '.js' )[ $h ];
};
$CleanUp = $requireHandlers( 'CleanUp' );
$DedupeStyles = $requireHandlers( 'DedupeStyles' );
$HandleLinkNeighbours = $requireHandlers( 'HandleLinkNeighbours' );
$Headings = $requireHandlers( 'Headings' );
$LiFixups = $requireHandlers( 'LiFixups' );
$PrepareDOM = $requireHandlers( 'PrepareDOM' );
$TableFixups = $requireHandlers( 'TableFixups' );
$UnpackDOMFragments = $requireHandlers( 'UnpackDOMFragments' );

// map from mediawiki metadata names to RDFa property names
$metadataMap = [
	'ns' => [
		'property' => 'mw:pageNamespace',
		'content' => '%d'
	],
	'id' => [
		'property' => 'mw:pageId',
		'content' => '%d'
	],

	// DO NOT ADD rev_user, rev_userid, and rev_comment (See T125266)

	// 'rev_revid' is used to set the overall subject of the document, we don't
	// need to add a specific <meta> or <link> element for it.

	'rev_parentid' => [
		'rel' => 'dc:replaces',
		'resource' => 'mwr:revision/%d'
	],
	'rev_timestamp' => [
		'property' => 'dc:modified',
		'content' => function ( $m ) {
			return new Date( $m->get( 'rev_timestamp' ) )->toISOString();
		}
	],
	'rev_sha1' => [
		'property' => 'mw:revisionSHA1',
		'content' => '%s'
	]
];

// Sanity check for dom behavior: we are
// relying on DOM level 4 getAttribute. In level 4, getAttribute on a
// non-existing key returns null instead of the empty string.
$testDom = domino::createWindow( '<h1>Hello world</h1>' )->document;
if ( $testDom->body->getAttribute( 'somerandomstring' ) === '' ) {
	throw "Your DOM version appears to be out of date! \n"
.		'Please run npm update in the js directory.';
}

/**
 * Create an element in the document.head with the given attrs.
 */
function appendToHead( $document, $tagName, $attrs ) {
	global $DOMDataUtils;
	$elt = $document->createElement( $tagName );
	DOMDataUtils::addAttributes( $elt, $attrs || [] );
	$document->head->appendChild( $elt );
}

/**
 * @class
 * @extends EventEmitter
 * @param {MWParserEnvironment} env
 * @param {Object} options
 */
function DOMPostProcessor( $env, $options ) {
	global $DOMTraverser;
	global $PrepareDOM;
	global $MarkFosteredContent;
	global $ProcessTreeBuilderFixups;
	global $PWrap;
	global $MigrateTemplateMarkerMetas;
	global $HandlePres;
	global $MigrateTrailingNLs;
	global $ComputeDSR;
	global $WrapTemplates;
	global $HandleLinkNeighbours;
	global $UnpackDOMFragments;
	global $LiFixups;
	global $TableFixups;
	global $DedupeStyles;
	global $AddMediaInfo;
	global $Headings;
	global $WrapSections;
	global $LanguageConverter;
	global $Linter;
	global $CleanUp;
	global $AddExtLinkClasses;
	global $ContentUtils;
	call_user_func( [ $events, 'EventEmitter' ] );
	$this->env = $env;
	$this->options = $options;
	$this->seenIds = new Set();
	$this->seenDataIds = new Set();

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

	$this->processors = [];
	$addPP = function ( $name, $shortcut, $proc, $skipNested ) {
		$this->processors[] = [
			'name' => $name,
			'shortcut' => $shortcut || $name,
			'proc' => $proc,
			'skipNested' => $skipNested
		];




		;
	};

	// DOM traverser that runs before the in-order DOM handlers.
	$dataParsoidLoader = new DOMTraverser( $env );
	$dataParsoidLoader->addHandler( null, function ( ...$args ) use ( &$PrepareDOM ) {return  PrepareDOM::prepareDOM( $this->seenDataIds, ...$args ); } );

	// Common post processing
	$addPP( 'dpLoader', 'dpload',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$dataParsoidLoader ) {return  $dataParsoidLoader->traverse( $node, $env, $opts, $atTopLevel ); }
	);
	$addPP( 'MarkFosteredContent', 'fostered', function ( ...$args ) use ( &$MarkFosteredContent ) {return  ( new MarkFosteredContent() )->run( ...$args ); } );
	$addPP( 'ProcessTreeBuilderFixups', 'process-fixups', function ( ...$args ) use ( &$ProcessTreeBuilderFixups ) {return  ( new ProcessTreeBuilderFixups() )->run( ...$args ); } );
	$addPP( 'normalize', null, function ( $body ) { $body->normalize();  } );
	$addPP( 'PWrap', 'pwrap', function ( ...$args ) use ( &$PWrap ) {return  ( new PWrap() )->run( ...$args ); }, true );

	// Run this after 'ProcessTreeBuilderFixups' because the mw:StartTag
	// and mw:EndTag metas would otherwise interfere with the
	// firstChild/lastChild check that this pass does.
	$addPP( 'MigrateTemplateMarkerMetas', 'migrate-metas', function ( ...$args ) use ( &$MigrateTemplateMarkerMetas ) {return  ( new MigrateTemplateMarkerMetas() )->run( ...$args ); } );
	$addPP( 'HandlePres', 'pres', function ( ...$args ) use ( &$HandlePres ) {return  ( new HandlePres() )->run( ...$args ); } );
	$addPP( 'MigrateTrailingNLs', 'migrate-nls', function ( ...$args ) use ( &$MigrateTrailingNLs ) {return  ( new MigrateTrailingNLs() )->run( ...$args ); } );

	if ( !$options->inTemplate ) {
		// dsr computation and tpl encap are only relevant for top-level content
		$addPP( 'ComputeDSR', 'dsr', function ( ...$args ) use ( &$ComputeDSR ) {return  ( new ComputeDSR() )->run( ...$args ); } );
		$addPP( 'WrapTemplates', 'tplwrap', function ( ...$args ) use ( &$WrapTemplates ) {return  ( new WrapTemplates() )->run( ...$args ); } );
	}

	// 1. Link prefixes and suffixes
	// 2. Unpack DOM fragments
	// FIXME: Picked a terse 'v' varname instead of trying to find
	// a suitable name that addresses both functions above.
	$v = new DOMTraverser( $env );
	$v->addHandler( 'a', HandleLinkNeighbours::handleLinkNeighbours );
	$v->addHandler( null, UnpackDOMFragments::unpackDOMFragments );
	$addPP( 'linkNbrs+unpackDOMFragments', 'dom-unpack',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$v ) {return  $v->traverse( $node, $env, $opts, $atTopLevel ); }
	);

	// FIXME: There are two potential ordering problems here.
	//
	// 1. unpackDOMFragment should always run immediately
	//    before these extensionPostProcessors, which we do currently.
	//    This ensures packed content get processed correctly by extensions
	//    before additional transformations are run on the DOM.
	//
	// This ordering issue is handled through documentation.
	//
	// 2. This has existed all along (in the PHP parser as well as Parsoid
	//    which is probably how the ref-in-ref hack works - because of how
	//    parser functions and extension tags are procesed, #tag:ref doesn't
	//    see a nested ref anymore) and this patch only exposes that problem
	//    more clearly with the unwrapFragments property.
	//
	// * Consider the set of extensions that
	//   (a) process wikitext
	//   (b) provide an extensionPostProcessor
	//   (c) run the extensionPostProcessor only on the top-level
	//   As of today, there is exactly one extension (Cite) that has all
	//   these properties, so the problem below is a speculative problem
	//   for today. But, this could potentially be a problem in the future.
	//
	// * Let us say there are at least two of them, E1 and E2 that
	//   support extension tags <e1> and <e2> respectively.
	//
	// * Let us say in an instance of <e1> on the page, <e2> is present
	//   and in another instance of <e2> on the page, <e1> is present.
	//
	// * In what order should E1's and E2's extensionPostProcessors be
	//   run on the top-level? Depending on what these handlers do, you
	//   could get potentially different results. You can see this quite
	//   starkly with the unwrapFragments flag.
	//
	// * The ideal solution to this problem is to require that every extension's
	//   extensionPostProcessor be idempotent which lets us run these
	//   post processors repeatedly till the DOM stabilizes. But, this
	//   still doesn't necessarily guarantee that ordering doesn't matter.
	//   It just guarantees that with the unwrapFragments flag set on
	//   multiple extensions, all sealed fragments get fully processed.
	//   So, we still need to worry about that problem.
	//
	//   But, idempotence *could* potentially be a sufficient property in most cases.
	//   To see this, consider that there is a Footnotes extension which is similar
	//   to the Cite extension in that they both extract inline content in the
	//   page source to a separate section of output and leave behind pointers to
	//   the global section in the output DOM. Given this, the Cite and Footnote
	//   extension post processors would essentially walk the dom and
	//   move any existing inline content into that global section till it is
	//   done. So, even if a <footnote> has a <ref> and a <ref> has a <footnote>,
	//   we ultimately end up with all footnote content in the footnotes section
	//   and all ref content in the references section and the DOM stabilizes.
	//   Ordering is irrelevant here.
	//
	//   So, perhaps one way of catching these problems would be in code review
	//   by analyzing what the DOM postprocessor does and see if it introduces
	//   potential ordering issues.

	$env->conf->wiki->extConfig->domProcessors->forEach( function ( $extProcs ) use ( &$addPP ) {
			$addPP( 'tag:' . $extProcs->extName, null, $extProcs->procs->wt2htmlPostProcessor );
		}
	);

	$fixupsVisitor = new DOMTraverser( $env );
	// 1. Deal with <li>-hack and move trailing categories in <li>s out of the list
	$fixupsVisitor->addHandler( 'li', LiFixups::handleLIHack );
	$fixupsVisitor->addHandler( 'li', LiFixups::migrateTrailingCategories );
	$fixupsVisitor->addHandler( 'dt', LiFixups::migrateTrailingCategories );
	$fixupsVisitor->addHandler( 'dd', LiFixups::migrateTrailingCategories );
	// 2. Fix up issues from templated table cells and table cell attributes
	$tableFixer = new TableFixups( $env );
	$fixupsVisitor->addHandler( 'td', function ( $node, $env ) use ( &$env, &$tableFixer ) {return  $tableFixer->stripDoubleTDs( $node, $env ); } );
	$fixupsVisitor->addHandler( 'td', function ( $node, $env ) use ( &$env, &$tableFixer ) {return  $tableFixer->handleTableCellTemplates( $node, $env ); } );
	$fixupsVisitor->addHandler( 'th', function ( $node, $env ) use ( &$env, &$tableFixer ) {return  $tableFixer->handleTableCellTemplates( $node, $env ); } );
	// 3. Deduplicate template styles
	//   (should run after dom-fragment expansion + after extension post-processors)
	$fixupsVisitor->addHandler( 'style', DedupeStyles::dedupe );
	$addPP( '(li+table)Fixups', 'fixups',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$fixupsVisitor ) {return  $fixupsVisitor->traverse( $node, $env, $opts, $atTopLevel ); },
		true
	);

	// This is run at all levels since, for now, we don't have a generic
	// solution to running top level passes on HTML stashed in data-mw.
	// See T214994 for that.
	//
	// Also, the gallery extension's "packed" mode would otherwise need a
	// post-processing pass to scale media after it has been fetched.  That
	// introduces an ordering dependency that may or may not complicate things.
	$addPP( 'AddMediaInfo', 'media', AddMediaInfo::addMediaInfo );

	// Benefits from running after determining which media are redlinks
	$headingsVisitor = new DOMTraverser( $env );
	$headingsVisitor->addHandler( null, Headings::genAnchors );
	$addPP( 'heading gen anchor', 'headings',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$headingsVisitor ) {return  $headingsVisitor->traverse( $node, $env, $opts, $atTopLevel ); },
		true
	);

	// Add <section> wrappers around sections
	$addPP( 'WrapSections', 'sections', function ( ...$args ) use ( &$WrapSections ) {return  ( new WrapSections() )->run( ...$args ); }, true );

	// Make heading IDs unique
	$headingVisitor = new DOMTraverser( $env );
	$headingVisitor->addHandler( null, function ( $node, $env ) use ( &$env, &$Headings ) {return  Headings::dedupeHeadingIds( $this->seenIds, $node, $env ); } );
	$addPP( 'heading id uniqueness', 'heading-ids',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$headingVisitor ) {return  $headingVisitor->traverse( $node, $env, $opts, $atTopLevel ); },
		true
	);

	// Language conversion
	$addPP( 'LanguageConverter', 'lang-converter', function ( $rootNode, $env, $options ) use ( &$env, &$options, &$LanguageConverter ) {
			LanguageConverter::maybeConvert(
				$env, $rootNode->ownerDocument,
				$env->htmlVariantLanguage, $env->wtVariantLanguage
			);
		}, true/* skipNested */
	);

	if ( $env->conf->parsoid->linting ) {
		$addPP( 'linter', null, function ( ...$args ) use ( &$Linter ) {return  ( new Linter() )->run( ...$args ); }, true );
	}

	// Strip marker metas -- removes left over marker metas (ex: metas
	// nested in expanded tpl/extension output).
	$markerMetasVisitor = new DOMTraverser( $env );
	$markerMetasVisitor->addHandler( 'meta', CleanUp::stripMarkerMetas );
	$addPP( 'stripMarkerMetas', 'strip-metas',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$markerMetasVisitor ) {return  $markerMetasVisitor->traverse( $node, $env, $opts, $atTopLevel ); }
	);

	$addPP( 'AddExtLinkClasses', 'linkclasses', function ( ...$args ) use ( &$AddExtLinkClasses ) {return  ( new AddExtLinkClasses() )->run( ...$args ); }, true );

	$cleanupVisitor = new DOMTraverser( $env );
	// Strip empty elements from template content
	$cleanupVisitor->addHandler( null, CleanUp::handleEmptyElements );
	// Save data.parsoid into data-parsoid html attribute.
	// Make this its own thing so that any changes to the DOM
	// don't affect other handlers that run alongside it.
	$cleanupVisitor->addHandler( null, CleanUp::cleanupAndSaveDataParsoid );
	$addPP( 'handleEmptyElts+cleanupAndSaveDP', 'cleanup',
		function ( $node, $env, $opts, $atTopLevel ) use ( &$env, &$cleanupVisitor ) {return  $cleanupVisitor->traverse( $node, $env, $opts, $atTopLevel ); }
	);

	// (Optional) red links
	$addPP( 'AddRedLinks', 'redlinks', function ( $rootNode, $env, $options ) use ( &$env, &$options, &$ContentUtils ) {
			if ( $env->conf->parsoid->useBatchAPI ) {
				// Async; returns promise for completion.
				return ContentUtils::addRedLinks( $env, $rootNode->ownerDocument );
			}
		}, true
	);
}

// Inherit from EventEmitter
util::inherits( $DOMPostProcessor, events\EventEmitter );

/**
 * Debugging aid: set pipeline id
 */
DOMPostProcessor::prototype::setPipelineId = function ( $id ) {
	$this->pipelineId = $id;
};

DOMPostProcessor::prototype::setSourceOffsets = function ( $start, $end ) {
	$this->options->sourceOffsets = [ $start, $end ];
};

DOMPostProcessor::prototype::resetState = function ( $opts ) {
	$this->atTopLevel = $opts && $opts->toplevel;
	$this->env->page->meta->displayTitle = null;
	$this->seenIds->clear();
	$this->seenDataIds->clear();
};

// FIXME: consider moving to DOMUtils or MWParserEnvironment.
DOMPostProcessor::addMetaData = function ( $env, $document ) use ( &$url, &$metadataMap, &$util, &$DOMDataUtils, &$Util ) {
	// add <head> element if it was missing
	if ( !$document->head ) {
		$document->documentElement->
		insertBefore( $document->createElement( 'head' ), $document->body );
	}

	// add mw: and mwr: RDFa prefixes
	$prefixes = [
		'dc: http://purl.org/dc/terms/',
		'mw: http://mediawiki.org/rdf/'
	];
	// add 'http://' to baseURI if it was missing
	$mwrPrefix = url::resolve( 'http://',
		$env->conf->wiki->baseURI . 'Special:Redirect/'
	);
	$document->documentElement->setAttribute( 'prefix', implode( ' ', $prefixes ) );
	$document->head->setAttribute( 'prefix', 'mwr: ' . $mwrPrefix );

	// add <head> content based on page meta data:

	// Set the charset first.
	appendToHead( $document, 'meta', [ 'charset' => 'utf-8' ] );

	// collect all the page meta data (including revision metadata) in 1 object
	$m = new Map();
	Object::keys( $env->page->meta || [] )->forEach( function ( $k ) use ( &$m, &$env ) {
			$m->set( $k, $env->page->meta[ $k ] );
		}
	);
	// include some other page properties
	[ 'ns', 'id' ]->forEach( function ( $p ) use ( &$m, &$env ) {
			$m->set( $p, $env->page[ $p ] );
		}
	);
	$rev = $m->get( 'revision' );
	Object::keys( $rev || [] )->forEach( function ( $k ) use ( &$m, &$rev ) {
			$m->set( 'rev_' . $k, $rev[ $k ] );
		}
	);
	// use the metadataMap to turn collected data into <meta> and <link> tags.
	$m->forEach( function ( $g, $f ) use ( &$metadataMap, &$m, &$util, &$document ) {
			$mdm = $metadataMap[ $f ];
			if ( !$m->has( $f ) || $m->get( $f ) === null || $m->get( $f ) === null || !$mdm ) {
				return;
			}
			// generate proper attributes for the <meta> or <link> tag
			$attrs = [];
			Object::keys( $mdm )->forEach( function ( $k ) use ( &$mdm, &$m, &$util, &$f, &$attrs ) {
					// evaluate a function, or perform sprintf-style formatting, or
					// use string directly, depending on value in metadataMap
					$v = ( gettype( $mdm[ $k ] ) === 'function' ) ? $mdm[ $k ]( $m ) :
					( array_search( '%', $mdm[ $k ] ) >= 0 ) ? util::format( $mdm[ $k ], $m->get( $f ) ) :
					$mdm[ $k ];
					$attrs[ $k ] = $v;
				}
			);
			// <link> is used if there's a resource or href attribute.
			appendToHead( $document,
				( $attrs->resource || $attrs->href ) ? 'link' : 'meta',
				$attrs
			);
		}
	);
	if ( $m->has( 'rev_revid' ) ) {
		$document->documentElement->setAttribute(
			'about', $mwrPrefix . 'revision/' . $m->get( 'rev_revid' )
		);
	}

	// Normalize before comparison
	if ( preg_replace( '/_/', ' ', $env->conf->wiki->mainpage ) === preg_replace( '/_/', ' ', $env->page->name ) ) {
		appendToHead( $document, 'meta', [
				'property' => 'isMainPage',
				'content' => true
			]
		);
	}

	// Set the parsoid content-type strings
	// FIXME: Should we be using http-equiv for this?
	appendToHead( $document, 'meta', [
			'property' => 'mw:html:version',
			'content' => $env->outputContentVersion
		]
	);
	$wikiPageUrl = $env->conf->wiki->baseURI
+		implode( '/', array_map( explode( '/', $env->page->name ), $encodeURIComponent ) );
	appendToHead( $document, 'link',
		[ 'rel' => 'dc:isVersionOf', 'href' => $wikiPageUrl ]
	);

	$document->title = $env->page->meta->displayTitle || $env->page->meta->title || '';

	// Add base href pointing to the wiki root
	appendToHead( $document, 'base', [ 'href' => $env->conf->wiki->baseURI ] );

	// Hack: link styles
	$modules = new Set( [
			'mediawiki.legacy.commonPrint,shared',
			'mediawiki.skinning.content.parsoid',
			'mediawiki.skinning.interface',
			'skins.vector.styles',
			'site.styles'
		]
	);
	// Styles from native extensions
	$env->conf->wiki->extConfig->styles->forEach( function ( $mo ) use ( &$modules ) {
			$modules->add( $mo );
		}
	);
	// Styles from modules returned from preprocessor / parse requests
	if ( $env->page->extensionModuleStyles ) {
		$env->page->extensionModuleStyles->forEach( function ( $mo ) use ( &$modules ) {
				$modules->add( $mo );
			}
		);
	}
	$styleURI = $env->getModulesLoadURI()
.		'?modules=' . encodeURIComponent( implode( '|', Array::from( $modules ) ) ) . '&only=styles&skin=vector';
	appendToHead( $document, 'link', [ 'rel' => 'stylesheet', 'href' => $styleURI ] );

	// Stick data attributes in the head
	if ( $env->pageBundle ) {
		DOMDataUtils::injectPageBundle( $document, DOMDataUtils::getPageBundle( $document ) );
	}

	// html5shiv
	$shiv = $document->createElement( 'script' );
	$src = $env->getModulesLoadURI() . '?modules=html5shiv&only=scripts&skin=vector&sync=1';
	$shiv->setAttribute( 'src', $src );
	$fi = $document->createElement( 'script' );
	$fi->appendChild( $document->createTextNode( "html5.addElements('figure-inline');" ) );
	$comment = $document->createComment(
		'[if lt IE 9]>' . $shiv->outerHTML . $fi->outerHTML . '<![endif]'
	);
	$document->head->appendChild( $comment );

	$lang = $env->page->pagelanguage || $env->conf->wiki->lang || 'en';
	$dir = $env->page->pagelanguagedir || ( ( $env->conf->wiki->rtl ) ? 'rtl' : 'ltr' );

	// Indicate whether LanguageConverter is enabled, so that downstream
	// caches can split on variant (if necessary)
	appendToHead( $document, 'meta', [
			'http-equiv' => 'content-language',
			'content' => $env->htmlContentLanguage()
		]
	);
	appendToHead( $document, 'meta', [
			'http-equiv' => 'vary',
			'content' => $env->htmlVary()
		]
	);

	// Indicate language & directionality on body
	$document->body->setAttribute( 'lang', Util::bcp47( $lang ) );
	$document->body->classList->add( 'mw-content-' . $dir );
	$document->body->classList->add( 'sitedir-' . $dir );
	$document->body->classList->add( $dir );
	$document->body->setAttribute( 'dir', $dir );

	// Set 'mw-body-content' directly on the body.
	// This is the designated successor for #bodyContent in core skins.
	$document->body->classList->add( 'mw-body-content' );
	// Set 'parsoid-body' to add the desired layout styling from Vector.
	$document->body->classList->add( 'parsoid-body' );
	// Also, add the 'mediawiki' class.
	// Some Mediawiki:Common.css seem to target this selector.
	$document->body->classList->add( 'mediawiki' );
	// Set 'mw-parser-output' directly on the body.
	// Templates target this class as part of the TemplateStyles RFC
	$document->body->classList->add( 'mw-parser-output' );
};

function processDumpAndGentestFlags( $psd, $body, $shortcut, $opts, $preOrPost ) {
	global $ContentUtils;
	global $fs;
	// We don't support --dump & --genTest flags at the same time.
	// Only one or the other can be used and if both are present,
	// dumping takes precedence.
	if ( $psd->dumpFlags && $psd->dumpFlags->has( 'dom:' . $preOrPost . '-' . $shortcut ) ) {
		ContentUtils::dumpDOM( $body, 'DOM: ' . $preOrPost . '-' . $shortcut, $opts );
	} elseif ( $psd->generateFlags && $psd->generateFlags->handlers ) {
		$opts->quiet = true;
		$psd->generateFlags->handlers->forEach( function ( $handler ) use ( &$shortcut, &$opts, &$fs, &$preOrPost, &$psd, &$ContentUtils, &$body ) {
				if ( $handler === ( 'dom:' . $shortcut ) ) {
					$opts->outStream = fs::createWriteStream( $psd->generateFlags->directory + $psd->generateFlags->pageName . '-' . $shortcut . '-' . $preOrPost . '.txt' );
					$opts->dumpFragmentMap = $psd->generateFlags->fragments;
					ContentUtils::dumpDOM( $body, 'DOM: ' . $preOrPost . '-' . $shortcut, $opts );
				}
			}
		);
	}
}

DOMPostProcessor::prototype::doPostProcess = /* async */function ( $document ) use ( &$ContentUtils, &$JSUtils, &$DOMDataUtils, &$PHPDOMTransform, &$requireProcessor ) {
	$env = $this->env;

	$psd = $env->conf->parsoid;
	if ( $psd->dumpFlags && $psd->dumpFlags->has( 'dom:post-builder' ) ) {
		ContentUtils::dumpDOM( $document->body, 'DOM: after tree builder' );
	}

	$tracePP = $psd->traceFlags && ( $psd->traceFlags->has( 'time/dompp' ) || $psd->traceFlags->has( 'time' ) );

	$startTime = null; $endTime = null; $prefix = null; $logLevel = null; $resourceCategory = null;
	if ( $tracePP ) {
		if ( $this->atTopLevel ) {
			$prefix = 'TOP';
			// Turn off DOM pass timing tracing on non-top-level documents
			// Turn off DOM pass timing tracing on non-top-level documents
			$logLevel = 'trace/time/dompp';
			$resourceCategory = 'DOMPasses:TOP';
		} else {
			$prefix = '---';
			$logLevel = 'debug/time/dompp';
			$resourceCategory = 'DOMPasses:NESTED';
		}
		$startTime = JSUtils::startTime();
		$env->log( $logLevel, $prefix . '; start=' . $startTime );
	}

	if ( $this->atTopLevel && $psd->generateFlags && $psd->generateFlags->handlers ) {
		// Pre-set data-parsoid.dsr for <body>
		// Useful for genTest mode for ComputeDSR tests
		DOMDataUtils::getDataParsoid( $document->body )->dsr = [ 0, count( $env->page->src ), 0, 0 ];
	}

	$pipelineConfig = $this->env->conf->parsoid->pipelineConfig;
	$phpDOMTransformers = $pipelineConfig && $pipelineConfig->phpDOMTransformers || null;
	for ( $i = 0;  $i < count( $this->processors );  $i++ ) {
		$pp = $this->processors[ $i ];
		if ( $pp->skipNested && !$this->atTopLevel ) {
			continue;
		}
		try {
			// Trace
			$ppStart = null; $ppElapsed = null; $ppName = null;
			if ( $tracePP ) {
				$ppName = $pp->name + ' '->repeat( ( count( $pp->name ) < 30 ) ? 30 - count( $pp->name ) : 0 );
				$ppStart = JSUtils::startTime();
				$env->log( $logLevel, $prefix . '; ' . $ppName . ' start' );
			}
			$opts = null;
			if ( $this->atTopLevel ) {
				$opts = [
					'env' => $env,
					'dumpFragmentMap' => true,
					'keepTmp' => true
				];
				processDumpAndGentestFlags( $psd, $document->body, $pp->shortcut, $opts, 'pre' );
			}

			if ( $phpDOMTransformers && array_search( $pp->name, $phpDOMTransformers ) >= 0 ) {
				// Run the PHP version of this DOM transformation
				if ( !$PHPDOMTransform ) {
					$PHPDOMTransform = new ( $requireProcessor( 'PHPDOMTransform' ) )();
				}
				// Overwrite!
				// Overwrite!
				$document = PHPDOMTransform::run( $pp->name, $document->body, $env, $this->options, $this->atTopLevel );
			} else {
				$ret = $pp->proc( $document->body, $env, $this->options, $this->atTopLevel );
				if ( $ret ) {
					// Processors can return a Promise iff they need to be async.
					/* await */ $ret;
				}
			}

			if ( $this->atTopLevel ) {
				processDumpAndGentestFlags( $psd, $document->body, $pp->shortcut, $opts, 'post' );
			}
			if ( $tracePP ) {
				$ppElapsed = JSUtils::elapsedTime( $ppStart );
				$env->log( $logLevel, $prefix . '; ' . $ppName . ' end; time = ' . $ppElapsed->toFixed( 5 ) );
				$env->bumpTimeUse( $resourceCategory, $ppElapsed, 'DOM' );
			}
		} catch ( Exception $e ) {
			$env->log( 'fatal', $e );
			return;
		}
	}
	if ( $tracePP ) {
		$endTime = JSUtils::startTime();
		$env->log( $logLevel, $prefix . '; end=' . $endTime->toFixed( 5 ) . '; time = ' . JSUtils::elapsedTime( $startTime )->toFixed( 5 ) );
	}

	// For sub-pipeline documents, we are done.
	// For the top-level document, we generate <head> and add it.
	// For sub-pipeline documents, we are done.
	// For the top-level document, we generate <head> and add it.
	if ( $this->atTopLevel ) {
		DOMPostProcessor::addMetaData( $env, $document );
		if ( $psd->traceFlags && $psd->traceFlags->has( 'time' ) ) {
			$env->printTimeProfile();
		}
		if ( $psd->dumpFlags && $psd->dumpFlags->has( 'wt2html:limits' ) ) {
			$env->printParserResourceUsage( [ 'HTML Size' => count( $document->outerHTML ) ] );
		}
	}

	$this->emit( 'document', $document );
}






































































































;

/**
 * Register for the 'document' event, normally emitted from the HTML5 tree
 * builder.
 */
DOMPostProcessor::prototype::addListenersOn = function ( $emitter ) {
	$emitter->addListener( 'document', function ( $document ) {
			$this->doPostProcess( $document )->done();
		}
	);
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->DOMPostProcessor = $DOMPostProcessor;
}
