<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;

class DOMProcessorPipelineFilter {
	public static function hasTemplates( Env $env, Element|DocumentFragment $root ): bool {
		return $env->getPagePerfFlag( Env::HAS_ENCAPSULATED_TEMPLATES );
	}

	public static function hasAnnotations( Env $env, Element|DocumentFragment $root ): bool {
		return $env->getPagePerfFlag( Env::HAS_ANNOTATIONS );
	}

	public static function hasLinks( Env $env, Element|DocumentFragment $root ): bool {
		// TODO: Implement - defaults to conservative value now
		return true;
	}

	public static function hasLists( Env $env, Element|DocumentFragment $root ): bool {
		// TODO: Implement - defaults to conservative value now
		return true;
	}

	public static function hasHeadings( Env $env, Element|DocumentFragment $root ): bool {
		// TODO: Implement - defaults to conservative value now
		return true;
	}

	public static function hasDOMFragments( Env $env, Element|DocumentFragment $root ): bool {
		// TODO: Implement - defaults to conservative value now
		return true;
	}
}
