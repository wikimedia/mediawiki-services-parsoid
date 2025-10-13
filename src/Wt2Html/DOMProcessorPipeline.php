<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\DOMPPTraverser;

/**
 * Perform post-processing steps on an already-built HTML DOM.
 */
class DOMProcessorPipeline extends PipelineStage {
	private array $options;
	/** @var array[] */
	private array $processors = [];
	private ParsoidExtensionAPI $extApi; // Provides post-processing support to extensions
	private string $timeProfile = '';
	private ?SelectiveUpdateData $selparData = null;
	private ?stdClass $tplInfo = null;

	public function __construct( Env $env, array $options = [], string $stageId = "" ) {
		parent::__construct( $env );
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

	/**
	 * @inheritDoc
	 */
	public function setSrcOffsets( SourceRange $srcOffsets ): void {
		$this->options['srcOffsets'] = $srcOffsets;
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
				$ppStart = hrtime( true );
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
					// For linting embedded docs
					'tplInfo' => $this->tplInfo,
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
				$ppElapsed = hrtime( true ) - $ppStart;
				if ( $this->atTopLevel ) {
					$this->timeProfile .= str_pad( $prefix . '; ' . $ppName, 65 ) .
						' time = ' .
						str_pad( number_format( $ppElapsed / 1000000, 2 ), 10, ' ', STR_PAD_LEFT ) . "\n";
				}
				$profile->bumpTimeUse( $resourceCategory, $ppElapsed, 'DOM' );
			}
		}
	}

	/**
	 * @inheritDoc
	 */
	public function process(
		string|array|DocumentFragment|Element $input,
		array $options
	): array|Element|DocumentFragment {
		if ( isset( $options['selparData'] ) ) {
			$this->selparData = $options['selparData'];
		}
		'@phan-var Node $input'; // @var Node $input
		$this->doPostProcess( $input );
		// @phan-suppress-next-line PhanTypeMismatchReturnSuperType
		return $input;
	}

	/**
	 * @inheritDoc
	 */
	public function processChunkily(
		string|array|DocumentFragment|Element $input,
		array $options
	): Generator {
		if ( $input !== [] ) {
			$this->process( $input, $options );
			yield $input;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $options ): void {
		parent::resetState( $options );
		$this->tplInfo = $options['tplInfo'] ?? null;
	}

	/**
	 * @inheritDoc
	 */
	public function finalize(): Generator {
		yield [];
	}
}
