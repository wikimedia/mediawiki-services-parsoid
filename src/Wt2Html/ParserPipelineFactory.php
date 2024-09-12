<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\InternalException;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\AddAnnotationIds;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\AddLinkAttributes;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\CleanUp;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\DedupeStyles;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\DisplaySpace;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\HandleLinkNeighbours;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\Headings;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\LiFixups;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\TableFixups;
use Wikimedia\Parsoid\Wt2Html\DOM\Handlers\UnpackDOMFragments;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\AddMediaInfo;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\AddMetaData;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\AddRedLinks;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ComputeDSR;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ConvertOffsets;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\LangConverter;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\Linter;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\MarkFosteredContent;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\MigrateTemplateMarkerMetas;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\MigrateTrailingNLs;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\Normalize;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ProcessEmbeddedDocs;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ProcessTreeBuilderFixups;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\PWrap;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\RunExtensionProcessors;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\UpdateTemplateOutput;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\WrapAnnotations;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\WrapSections;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\WrapTemplates;
use Wikimedia\Parsoid\Wt2Html\TreeBuilder\TreeBuilderStage;
use Wikimedia\Parsoid\Wt2Html\TT\AttributeExpander;
use Wikimedia\Parsoid\Wt2Html\TT\BehaviorSwitchHandler;
use Wikimedia\Parsoid\Wt2Html\TT\DOMFragmentBuilder;
use Wikimedia\Parsoid\Wt2Html\TT\ExtensionHandler;
use Wikimedia\Parsoid\Wt2Html\TT\ExternalLinkHandler;
use Wikimedia\Parsoid\Wt2Html\TT\IncludeOnly;
use Wikimedia\Parsoid\Wt2Html\TT\LanguageVariantHandler;
use Wikimedia\Parsoid\Wt2Html\TT\ListHandler;
use Wikimedia\Parsoid\Wt2Html\TT\NoInclude;
use Wikimedia\Parsoid\Wt2Html\TT\OnlyInclude;
use Wikimedia\Parsoid\Wt2Html\TT\ParagraphWrapper;
use Wikimedia\Parsoid\Wt2Html\TT\PreHandler;
use Wikimedia\Parsoid\Wt2Html\TT\QuoteTransformer;
use Wikimedia\Parsoid\Wt2Html\TT\SanitizerHandler;
use Wikimedia\Parsoid\Wt2Html\TT\TemplateHandler;
use Wikimedia\Parsoid\Wt2Html\TT\TokenStreamPatcher;
use Wikimedia\Parsoid\Wt2Html\TT\WikiLinkHandler;

/**
 * This class assembles parser pipelines from parser stages
 */
class ParserPipelineFactory {
	private static $initialized = false;
	private static $globalPipelineId = 0;

	public static function init(): void {
		if ( self::$initialized ) {
			return;
		}

		self::$stages["FullParseDOMTransform"]["processors"] =
			array_merge(
				self::NESTED_PIPELINE_DOM_TRANSFORMS,
				self::FULL_PARSE_GLOBAL_DOM_TRANSFORMS
			);

		self::$stages["SelectiveUpdateFragmentDOMTransform"]["processors"] =
			array_merge(
				self::NESTED_PIPELINE_DOM_TRANSFORMS,
				self::SELECTIVE_UPDATE_FRAGMENT_GLOBAL_DOM_TRANSFORMS
			);

		self::$initialized = true;
	}

	private const DOM_PROCESSOR_CONFIG = [
		'addmetadata' => AddMetaData::class,
		'annwrap' => WrapAnnotations::class,
		'convertoffsets' => ConvertOffsets::class,
		'dsr' => ComputeDSR::class,
		'embedded-docs' => ProcessEmbeddedDocs::class,
		'extpp' => RunExtensionProcessors::class,
		'fostered' => MarkFosteredContent::class,
		'linter' => Linter::class,
		'lang-converter' => LangConverter::class,
		'media' => AddMediaInfo::class,
		'migrate-metas' => MigrateTemplateMarkerMetas::class,
		'migrate-nls' => MigrateTrailingNLs::class,
		'normalize' => Normalize::class,
		'process-fixups' => ProcessTreeBuilderFixups::class,
		'pwrap' => PWrap::class,
		'redlinks' => AddRedLinks::class,
		'sections' => WrapSections::class, // Don't process HTML in embedded attributes
		'tplwrap' => WrapTemplates::class,
		'update-template' => UpdateTemplateOutput::class,
		'ann-ids' => [
			'name' => 'AddAnnotationIds',
			'handlers' => [
				[ 'nodeName' => 'meta', 'action' => [ AddAnnotationIds::class, 'handler' ] ]
			],
			'withAnnotations' => true
		],
		'linkneighbours+dom-unpack' => [
			'name' => 'HandleLinkNeighbours,UnpackDOMFragments',
			'handlers' => [
				// Link prefixes and suffixes
				[ 'nodeName' => 'a', 'action' => [ HandleLinkNeighbours::class, 'handler' ] ],
				[ 'nodeName' => null, 'action' => [ UnpackDOMFragments::class, 'handler' ] ]
			]
		],
		'fixups' => [
			'name' => 'MigrateTrailingCategories,TableFixups',
			'tplInfo' => true,
			'handlers' => [
				// 1. Move trailing categories in <li>s out of the list
				[ 'nodeName' => 'li', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				[ 'nodeName' => 'dt', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				[ 'nodeName' => 'dd', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				// 2. Fix up issues from templated table cells and table cell attributes
				[ 'nodeName' => 'td', 'action' => [ TableFixups::class, 'handleTableCellTemplates' ] ],
				[ 'nodeName' => 'th', 'action' => [ TableFixups::class, 'handleTableCellTemplates' ] ],
			]
		],
		'fixups+dedupe-styles' => [
			'name' => 'MigrateTrailingCategories,TableFixups,DedupeStyles',
			'tplInfo' => true,
			'handlers' => [
				// 1. Move trailing categories in <li>s out of the list
				[ 'nodeName' => 'li', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				[ 'nodeName' => 'dt', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				[ 'nodeName' => 'dd', 'action' => [ LiFixups::class, 'migrateTrailingSolTransparentLinks' ] ],
				// 2. Fix up issues from templated table cells and table cell attributes
				[ 'nodeName' => 'td', 'action' => [ TableFixups::class, 'handleTableCellTemplates' ] ],
				[ 'nodeName' => 'th', 'action' => [ TableFixups::class, 'handleTableCellTemplates' ] ],
				// 3. Deduplicate template styles
				// (should run after dom-fragment expansion + after extension post-processors)
				[ 'nodeName' => 'style', 'action' => [ DedupeStyles::class, 'dedupe' ] ]
			]
		],
		// Strip marker metas -- removes left over marker metas (ex: metas
		// nested in expanded tpl/extension output).
		'strip-metas' => [
			'name' => 'CleanUp-stripMarkerMetas',
			'handlers' => [
				[ 'nodeName' => 'meta', 'action' => [ CleanUp::class, 'stripMarkerMetas' ] ]
			]
		],
		'displayspace+linkclasses' => [
			'name' => 'DisplaySpace+AddLinkAttributes',
			'handlers' => [
				[ 'nodeName' => null, 'action' => [ DisplaySpace::class, 'leftHandler' ] ],
				[ 'nodeName' => null, 'action' => [ DisplaySpace::class, 'rightHandler' ] ],
				[ 'nodeName' => 'a', 'action' => [ AddLinkAttributes::class, 'handler' ] ]
			]
		],
		'gen-anchors' => [
			'name' => 'Headings-genAnchors',
			'handlers' => [
				[ 'nodeName' => null, 'action' => [ Headings::class, 'genAnchors' ] ],
			]
		],
		'dedupe-heading-ids' => [
			'name' => 'Headings-dedupeIds',
			'handlers' => [
				[ 'nodeName' => null, 'action' => [ Headings::class, 'dedupeHeadingIds' ] ]
			]
		],
		'heading-ids' => [
			'name' => 'Headings-genAnchors',
			'handlers' => [
				[ 'nodeName' => null, 'action' => [ Headings::class, 'genAnchors' ] ],
				[ 'nodeName' => null, 'action' => [ Headings::class, 'dedupeHeadingIds' ] ]
			]
		],
		'cleanup' => [
			'name' => 'CleanUp-handleEmptyElts,CleanUp-cleanup',
			'tplInfo' => true,
			'handlers' => [
				// Strip empty elements from template content
				[ 'nodeName' => null, 'action' => [ CleanUp::class, 'handleEmptyElements' ] ],
				// Additional cleanup
				[ 'nodeName' => null, 'action' => [ CleanUp::class, 'finalCleanup' ] ]
			]
		],
		'saveDP' => [
			'name' => 'CleanUp-saveDataParsoid',
			'tplInfo' => true,
			'handlers' => [
				// Save data.parsoid into data-parsoid html attribute.
				// Make this its own thing so that any changes to the DOM
				// don't affect other handlers that run alongside it.
				[ 'nodeName' => null, 'action' => [ CleanUp::class, 'saveDataParsoid' ] ]
			]
		]
	];

	// NOTES about ordering / inclusion:
	//
	// media:
	//    This is run at all levels for now - gallery extension's "packed" mode
	//    would otherwise need a post-processing pass to scale media after it
	//    has been fetched. That introduces an ordering dependency that may
	//    or may not complicate things.
	// migrate-metas:
	//    - Run this after 'pwrap' because it can add additional opportunities for
	//      meta migration which we will miss if we run this before p-wrapping.
	//    - We could potentially move this just before 'tplwrap' by seeing this
	//      as a preprocessing pass for that. But, we will have to update the pass
	//      to update DSR properties where required.
	//    - In summary, this can at most be moved before 'media' or after
	//      'migrate-nls' without needing any other changes.
	// dsr, tplwrap:
	//    DSR computation and template wrapping cannot be skipped for top-level content
	//    even if they are part of nested level pipelines, because such content might be
	//    embedded in attributes and they may need to be processed independently.
	//
	// Nested (non-top-level) pipelines can never include the following:
	// - lang-converter, convertoffsets, dedupe-styles, cleanup, saveDP
	//
	// FIXME: Perhaps introduce a config flag in the processor config that
	// verifies this property against a pipeline's 'toplevel' state.
	public const NESTED_PIPELINE_DOM_TRANSFORMS = [
		'fostered', 'process-fixups', 'normalize', 'pwrap',
		'media', 'migrate-metas', 'migrate-nls', 'dsr', 'tplwrap',
		'ann-ids', 'annwrap', 'linkneighbours+dom-unpack'
	];

	// NOTES about ordering:
	// lang-converter, redlinks:
	//    Language conversion and redlink marking are done here
	//    *before* we cleanup and save data-parsoid because they
	//    are also used in pb2pb/html2html passes, and we want to
	//    keep their input/output formats consistent.
	public const FULL_PARSE_GLOBAL_DOM_TRANSFORMS = [
		// FIXME: It should be documented in the spec that an extension's
		// wtDOMProcess handler is run once on the top level document.
		'extpp',
		'fixups+dedupe-styles', 'linter', 'strip-metas',
		'lang-converter', 'redlinks', 'displayspace+linkclasses',
		// Benefits from running after determining which media are redlinks
		'heading-ids',
		'sections', 'convertoffsets', 'cleanup',
		'embedded-docs',
		'saveDP', 'addmetadata'
	];

	// Skipping sections, addmetadata from the above pipeline
	//
	// FIXME: Skip extpp, linter, lang-converter, redlinks, heading-ids, convertoffsets, saveDP for now.
	// This replicates behavior prior to this refactor.
	public const FULL_PARSE_EMBEDDED_DOC_DOM_TRANSFORMS = [
		'fixups+dedupe-styles', 'strip-metas',
		'displayspace+linkclasses',
		'cleanup',
		// Need to run this recursively
		'embedded-docs',
		// FIXME This means the data-* from embedded HTML fragments won't end up
		// in the pagebundle. But, if we try to call this on those fragments,
		// we get multiple calls to store embedded docs. So, we may need to
		// write a custom traverser if we want these embedded data* objects
		// in the pagebundle (this is not a regression since they weren't part
		// of the pagebundle all this while anyway.)
		/* 'saveDP' */
	];

	public const SELECTIVE_UPDATE_FRAGMENT_GLOBAL_DOM_TRANSFORMS = [
		'extpp', // FIXME: this should be a different processor
		'fixups', 'strip-metas', 'redlinks', 'displayspace+linkclasses',
		'gen-anchors', 'convertoffsets', 'cleanup',
		// FIXME: This will probably need some special-case code to first
		// strip old metadata before adding fresh metadata.
		'addmetadata'
	];

	public const SELECTIVE_UPDATE_GLOBAL_DOM_TRANSFORMS = [
		'update-template', 'linter', 'lang-converter', /* FIXME: Are lang converters idempotent? */
		'heading-ids', 'sections', 'saveDP'
	];

	private static $stages = [
		"Tokenizer" => [
			"class" => PegTokenizer::class,
		],
		"TokenTransform2" => [
			"class" => TokenTransformManager::class,
			"transformers" => [
				OnlyInclude::class,
				IncludeOnly::class,
				NoInclude::class,

				TemplateHandler::class,
				ExtensionHandler::class,

				// Expand attributes after templates to avoid expanding unused branches.
				// No expansion of quotes, paragraphs etc in attributes,
				// as with the legacy parser - up to end of TokenTransform2.
				AttributeExpander::class,

				// now all attributes expanded to tokens or string
				// more convenient after attribute expansion
				WikiLinkHandler::class,
				ExternalLinkHandler::class,
				LanguageVariantHandler::class,

				// This converts dom-fragment-token tokens all the way to DOM
				// and wraps them in DOMFragment wrapper tokens which will then
				// get unpacked into the DOM by a dom-fragment unpacker.
				DOMFragmentBuilder::class
			],
		],
		"TokenTransform3" => [
			"class" => TokenTransformManager::class,
			"transformers" => [
				TokenStreamPatcher::class,
				// add <pre>s
				PreHandler::class,
				QuoteTransformer::class,
				// add before transforms that depend on behavior switches
				// examples: toc generation, edit sections
				BehaviorSwitchHandler::class,

				ListHandler::class,
				SanitizerHandler::class,
				// Wrap tokens into paragraphs post-sanitization so that
				// tags that converted to text by the sanitizer have a chance
				// of getting wrapped into paragraphs.  The sanitizer does not
				// require the existence of p-tags for its functioning.
				ParagraphWrapper::class
			],
		],
		// Build a tree out of the fully processed token stream
		"TreeBuilder" => [
			"class" => TreeBuilderStage::class,
		],
		// DOM transformer for top-level documents.
		// This performs a lot of post-processing of the DOM
		// (Template wrapping, broken wikitext/html detection, etc.)
		"FullParseDOMTransform" => [
			"class" => DOMPostProcessor::class,
			"processors" => null // Will be initialized in an init function()
		],
		// DOM transformer for fragments of a top-level document
		"NestedFragmentDOMTransform" => [
			"class" => DOMPostProcessor::class,
			"processors" => self::NESTED_PIPELINE_DOM_TRANSFORMS
		],
		// DOM transformations to run on attribute-embedded docs of the top level doc
		"FullParseEmbeddedDocsDOMTransform" => [
			"class" => DOMPostProcessor::class,
			"processors" => self::FULL_PARSE_EMBEDDED_DOC_DOM_TRANSFORMS
		],
		// DOM transformer for fragments during selective updates.
		// This may eventually become identical to NestedFrgmentDOMTransform,
		// but at this time, it is unclear if that will materialize.
		"SelectiveUpdateFragmentDOMTransform" => [
			"class" => DOMPostProcessor::class,
			"processors" => null // Will be initialized in an init function()
		],
		// DOM transformer for the top-level page during selective updates.
		"SelectiveUpdateDOMTransform" => [
			// For use in the top-level of the selective-update pipeline
			"class" => DOMPostProcessor::class,
			"processors" => self::SELECTIVE_UPDATE_GLOBAL_DOM_TRANSFORMS
		]
	];

	private static $pipelineRecipes = [
		// This pipeline takes wikitext as input and emits a fully
		// processed DOM as output. This is the pipeline used for
		// all top-level documents.
		"fullparse-wikitext-to-dom" => [
			"alwaysToplevel" => true,
			"outType" => "DOM",
			"stages" => [
				"Tokenizer", "TokenTransform2", "TokenTransform3", "TreeBuilder", "FullParseDOMTransform"
			]
		],

		"fullparse-embedded-docs-dom-to-dom" => [
			"alwaysToplevel" => true,
			"outType" => "DOM",
			"stages" => [ "FullParseEmbeddedDocsDOMTransform" ]
		],

		// This pipeline takes a DOM and emits a fully processed DOM as output.
		"selective-update-dom-to-dom" => [
			"alwaysToplevel" => true,
			"outType" => "DOM",
			"stages" => [ "SelectiveUpdateDOMTransform" ]
		],

		// This pipeline takes wikitext as input and emits a partially
		// processed DOM as output. This is the pipeline used for processing
		// page fragments to DOM in a selective page update context
		// This is always toplevel because the wikitext being updated
		// is found at the toplevel of the page.
		"selective-update-fragment-wikitext-to-dom" => [
			"alwaysToplevel" => true,
			"outType" => "DOM",
			"stages" => [
				"Tokenizer", "TokenTransform2", "TokenTransform3", "TreeBuilder", "SelectiveUpdateFragmentDOMTransform"
			]
		],

		// This pipeline takes wikitext as input and emits a fully
		// processed DOM as output. This is the pipeline used for
		// wikitext fragments of a top-level document that should be
		// processed to a DOM fragment. This pipeline doesn't run all
		// of the DOM transformations in the DOMTransform pipeline.
		// We will like use a specialized DOMTransform stage here.
		"wikitext-to-fragment" => [
			// FIXME: This is known to be always *not* top-level
			// We could use a different flag to lock these pipelines too.
			"outType" => "DOM",
			"stages" => [
				"Tokenizer", "TokenTransform2", "TokenTransform3", "TreeBuilder", "NestedFragmentDOMTransform"
			]
		],

		// This pipeline takes tokens from stage 2 and emits a DOM fragment
		// as output - this runs the same DOM transforms as the 'wikitext-to-fragment'
		// pipeline and will get a spcialized DOMTransform stage as above.
		"expanded-tokens-to-fragment" => [
			"outType" => "DOM",
			"stages" => [ "TokenTransform3", "TreeBuilder", "NestedFragmentDOMTransform" ]
		],

		// This pipeline takes wikitext as input and emits tokens that
		// have had all templates, extensions, links, images processed
		"wikitext-to-expanded-tokens" => [
			"outType" => "Tokens",
			"stages" => [ "Tokenizer", "TokenTransform2" ]
		],

		// This pipeline takes tokens from the PEG tokenizer and emits
		// tokens that have had all templates and extensions processed.
		"peg-tokens-to-expanded-tokens" => [
			"outType" => "Tokens",
			"stages" => [ "TokenTransform2" ]
		]
	];

	private static $supportedOptions = [
		// If true, templates found in content will have its contents expanded
		'expandTemplates',

		// If true, indicates pipeline is processing the expanded content of a
		// template or its arguments
		'inTemplate',

		// If true, indicates that we are in a <includeonly> context
		// (in current usage, isInclude === inTemplate)
		'isInclude',

		// The extension tag that is being processed (Ex: ref, references)
		// (in current usage, only used for native tag implementation)
		'extTag',

		// Extension-specific options
		'extTagOpts',

		// Content being parsed is used in an inline context
		'inlineContext',

		// Are we processing content of attributes?
		// (in current usage, used for transcluded attr. keys/values)
		'attrExpansion',
	];

	private array $pipelineCache = [];

	private Env $env;

	public function __construct( Env $env ) {
		$this->env = $env;
	}

	/**
	 * Default options processing
	 *
	 * @param array $options
	 * @return array
	 */
	private function defaultOptions( array $options ): array {
		// default: not in a template
		$options['inTemplate'] ??= false;

		// default: not an include context
		$options['isInclude'] ??= false;

		// default: wrap templates
		$options['expandTemplates'] ??= true;

		// Catch pipeline option typos
		foreach ( $options as $k => $v ) {
			Assert::invariant(
				in_array( $k, self::$supportedOptions, true ),
				'Invalid cacheKey option: ' . $k
			);
		}

		return $options;
	}

	public static function procNamesToProcs( array $procNames ): array {
		$processors = [];
		foreach ( $procNames as $name ) {
			$proc = self::DOM_PROCESSOR_CONFIG[$name];
			if ( !is_array( $proc ) ) {
				$proc = [
					'name' => Utils::stripNamespace( $proc ),
					'Processor' => $proc,
				];
			}
			$proc['shortcut'] = $name;
			$processors[] = $proc;
		}
		return $processors;
	}

	/**
	 * Generic pipeline creation from the above recipes.
	 *
	 * @param string $type
	 * @param string $cacheKey
	 * @param array $options
	 * @return ParserPipeline
	 */
	private function makePipeline(
		string $type, string $cacheKey, array $options
	): ParserPipeline {
		self::init();

		if ( !isset( self::$pipelineRecipes[$type] ) ) {
			throw new InternalException( 'Unsupported Pipeline: ' . $type );
		}
		$recipe = self::$pipelineRecipes[$type];
		$pipeStages = [];
		$prevStage = null;
		$recipeStages = $recipe["stages"];

		foreach ( $recipeStages as $stageId ) {
			$stageData = self::$stages[$stageId];
			// @phan-suppress-next-line PhanNonClassMethodCall,PhanTypeExpectedObjectOrClassName
			$stage = new $stageData["class"]( $this->env, $options, $stageId, $prevStage );
			if ( isset( $stageData["transformers"] ) ) {
				foreach ( $stageData["transformers"] as $tName ) {
					$stage->addTransformer( new $tName( $stage, $options ) );
				}
			} elseif ( isset( $stageData["processors"] ) ) {
				$stage->registerProcessors( self::procNamesToProcs( $stageData["processors"] ) );
			}

			$prevStage = $stage;
			$pipeStages[] = $stage;
		}

		return new ParserPipeline(
			$recipe['alwaysToplevel'] ?? false,
			$type,
			$recipe["outType"],
			$cacheKey,
			$pipeStages,
			$this->env
		);
	}

	private function getCacheKey( string $cacheKey, array $options ): string {
		if ( empty( $options['isInclude'] ) ) {
			$cacheKey .= '::noInclude';
		}
		if ( empty( $options['expandTemplates'] ) ) {
			$cacheKey .= '::noExpand';
		}
		if ( !empty( $options['inlineContext'] ) ) {
			$cacheKey .= '::inlineContext';
		}
		if ( !empty( $options['inTemplate'] ) ) {
			$cacheKey .= '::inTemplate';
		}
		if ( !empty( $options['attrExpansion'] ) ) {
			$cacheKey .= '::attrExpansion';
		}
		if ( isset( $options['extTag'] ) ) {
			$cacheKey .= '::' . $options['extTag'];
			// FIXME: This is not the best strategy. But, instead of
			// premature complexity, let us see how extensions want to
			// use this and then figure out what constraints are needed.
			if ( isset( $options['extTagOpts'] ) ) {
				$cacheKey .= '::' . PHPUtils::jsonEncode( $options['extTagOpts'] );
			}
		}
		return $cacheKey;
	}

	public function parse( string $src ): Document {
		$pipe = $this->getPipeline( 'fullparse-wikitext-to-dom' );
		$pipe->init( [
			'frame' => $this->env->topFrame,
			'toFragment' => false,
		] );
		// Top-level doc parsing always start in SOL state
		return $pipe->parseChunkily( $src, [ 'sol' => true ] )->ownerDocument;
	}

	/**
	 * @param SelectiveUpdateData $selparData
	 * @param array $options Options for selective DOM update
	 * - mode: (string) One of "template", "section", "generic"
	 *         For now, defaults to 'template', if absent
	 */
	public function selectiveDOMUpdate( SelectiveUpdateData $selparData, array $options = [] ): Document {
		$pipe = $this->getPipeline( 'selective-update-dom-to-dom' );
		$pipe->init( [
			'frame' => $this->env->topFrame,
			'toFragment' => false,
		] );
		return $pipe->selectiveParse( $selparData, $options );
	}

	/**
	 * Get a pipeline of a given type.  Pipelines are cached as they are
	 * frequently created.
	 *
	 * @param string $type
	 * @param array $options These also determine the key under which the
	 *   pipeline is cached for reuse.
	 * @return ParserPipeline
	 */
	public function getPipeline(
		string $type, array $options = []
	): ParserPipeline {
		$options = $this->defaultOptions( $options );
		$cacheKey = $this->getCacheKey( $type, $options );

		$this->pipelineCache[$cacheKey] ??= [];

		if ( $this->pipelineCache[$cacheKey] ) {
			$pipe = array_pop( $this->pipelineCache[$cacheKey] );
		} else {
			$pipe = $this->makePipeline( $type, $cacheKey, $options );
		}

		// Debugging aid: Assign unique id to the pipeline
		$pipe->setPipelineId( self::$globalPipelineId++ );

		return $pipe;
	}

	/**
	 * Callback called by a pipeline at the end of its processing. Returns the
	 * pipeline to the cache.
	 *
	 * @param ParserPipeline $pipe
	 */
	public function returnPipeline( ParserPipeline $pipe ): void {
		$cacheKey = $pipe->getCacheKey();
		$this->pipelineCache[$cacheKey] ??= [];
		if ( count( $this->pipelineCache[$cacheKey] ) < 100 ) {
			$this->pipelineCache[$cacheKey][] = $pipe;
		}
	}
}
