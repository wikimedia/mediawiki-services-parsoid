<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Utils\ContentUtils;

/**
 * Perform post-processing steps on an already-built HTML DOM.
 */
class DOMPostProcessor extends PipelineStage {
	private array $options;
	/** @var array[] */
	private array $processors = [];
	private ParsoidExtensionAPI $extApi; // Provides post-processing support to extensions
	private string $timeProfile = '';
	private ?SelectiveUpdateData $selparData = null;

	public function __construct(
		Env $env, array $options = [], string $stageId = "",
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );

		$this->options = $options;
		$this->extApi = new ParsoidExtensionAPI( $env );
	}

	public function getTimeProfile(): string {
		return $this->timeProfile;
	}

	public function registerProcessors( array $processors ): void {
		foreach ( $processors as $p ) {
			if ( isset( $p['Processor'] ) ) {
				// Internal processor w/ ::run() method, class name given
				$p['proc'] = new $p['Processor']( $this );
			} else {
				$t = new DOMPPTraverser( $this, $p['tplInfo'] ?? false );
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

	public function doPostProcess( Node $node ): void {
		$env = $this->env;

		$hasDumpFlags = $env->hasDumpFlags();

		// FIXME: This works right now, but may not always be the right place to dump
		// if custom DOM pipelines start getting more specialized and we enter this
		// pipeline immediate after tree building.
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
			// This is an optimization for the 'AddAnnotationIds' handler
			// which is embedded in a DOMTraverser where we cannot check this flag.
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
	}

	/**
	 * @inheritDoc
	 */
	public function process( $node, array $opts ) {
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
	public function processChunkily( $input, array $options ): Generator {
		if ( $this->prevStage ) {
			// The previous stage will yield a DOM.
			// FIXME: Should we change the signature of that to return a DOM
			// If we do so, a pipeline stage returns either a generator or
			// concrete output (in this case, a DOM).
			$node = $this->prevStage->processChunkily( $input, $options )->current();
		} else {
			$node = $input;
		}
		$this->process( $node, $options );
		yield $node;
	}
}
