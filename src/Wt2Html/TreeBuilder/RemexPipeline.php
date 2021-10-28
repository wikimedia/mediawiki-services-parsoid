<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TreeBuilder;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\InternalException;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\RemexHtml\Tokenizer\PlainAttributes;
use Wikimedia\RemexHtml\Tokenizer\Tokenizer;
use Wikimedia\RemexHtml\TreeBuilder\Dispatcher;
use Wikimedia\RemexHtml\TreeBuilder\TreeBuilder;
use Wikimedia\RemexHtml\TreeBuilder\TreeMutationTracer;

class RemexPipeline {
	/** @var Dispatcher */
	public $dispatcher;

	/** @var TreeBuilder */
	public $treeBuilder;

	/** @var DOMBuilder */
	public $domBuilder;

	/** @var Document */
	public $doc;

	/**
	 * Create a RemexHtml pipeline
	 *
	 * Since we do our own tokenizing, the Dispatcher is called directly to push
	 * data into the pipeline. A RemexHtml Tokenizer is only needed to provide
	 * stub handling for certain TreeBuilder callbacks. Those callbacks are
	 * required by the HTML 5  spec -- we get away with ignoring them because
	 * we are not actually parsing HTML.
	 *
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		$this->domBuilder = new DOMBuilder;
		if ( $env->hasTraceFlag( 'remex' ) ) {
			$tracer = new TreeMutationTracer(
				$this->domBuilder,
				static function ( $msg ) use ( $env ) {
					$env->log( 'trace/remex', $msg );
				}
			);
		} else {
			$tracer = $this->domBuilder;
		}
		$this->dispatcher = new Dispatcher( new TreeBuilder( $tracer ) );

		// Create dummy Tokenizer
		$tokenizer = new Tokenizer( $this->dispatcher, '', [ 'ignoreErrors' => true ] );

		$this->dispatcher->startDocument( $tokenizer, null, null );
		$this->dispatcher->doctype( 'html', '', '', false, 0, 0 );
		$this->dispatcher->startTag( 'body', new PlainAttributes(), false, 0, 0 );

		$doc = $this->domBuilder->getFragment();
		if ( $doc instanceof Document ) {
			$this->doc = $doc;
		} else {
			throw new InternalException( 'Invalid document type' );
		}
	}

	/**
	 * Create an object of a Parsoid-specific subclass of Remex's Attributes,
	 * with special handling for clone events.
	 *
	 * @param array $attrs
	 * @return Attributes
	 */
	public function createAttributes( $attrs ) {
		return new Attributes( $this->doc, $attrs );
	}

	/**
	 * Dispatch a meta tag in such a way that it won't be fostered even if the
	 * currently open element is a table. This replaces the old comment hack.
	 *
	 * @param array $attribs
	 */
	public function insertUnfosteredMeta( array $attribs ) {
		$this->dispatcher->flushTableText();
		$this->dispatcher->inHead->startTag(
			'meta',
			$this->createAttributes( $attribs ),
			false, 0, 0
		);
	}

}
