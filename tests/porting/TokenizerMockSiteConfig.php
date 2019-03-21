<?php

namespace Parsoid\Tests\Porting;

use Parsoid\Tests\MockSiteConfig;

class TokenizerMockSiteConfig extends MockSiteConfig {
	public function getMagicPatternMatcher( array $words ): callable {
		return function () {
			return false;
		};
	}

	public function isMagicWord( string $word ): bool {
		return false;
	}

	public function hasValidProtocol( string $potentialLink ): bool {
		return preg_match( '/^http/', $potentialLink );
	}
}
