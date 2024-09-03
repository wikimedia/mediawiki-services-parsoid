<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\DOMProcessor as ExtDOMProcessor;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 * A wrapper to call extension-specific DOM processors
 */
class RunExtensionProcessors implements Wt2HtmlDOMProcessor {
	private ?array $extProcessors = null;

	private function initialize( Env $env ): array {
		$extProcessors = [];
		foreach ( $env->getSiteConfig()->getExtDOMProcessors() as $extName => $domProcs ) {
			foreach ( $domProcs as $i => $classNameOrSpec ) {
				// Extension post processor, object factory spec given
				$objectFactory = $env->getSiteConfig()->getObjectFactory();
				$extProcessors[] = $objectFactory->createObject( $classNameOrSpec, [
					'allowClassName' => true,
					'assertClass' => ExtDOMProcessor::class,
				] );
			}
		}

		return $extProcessors;
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$this->extProcessors ??= $this->initialize( $env );
		foreach ( $this->extProcessors as $ep ) {
			$ep->wtPostprocess( $options['extApi'], $root, $options );
		}
	}
}
