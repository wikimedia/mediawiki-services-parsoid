<?php

namespace Parsoid\Tests\Porting;

use Parsoid\Tests\MockEnv;

class TokenizerMockEnv extends MockEnv {
	/**
	 * Peg this to true to keep things simple in testing the tokenizer.
	 * This should match the mock in dump_tokens.js.
	 */
	public function langConverterEnabled(): bool {
		return true;
	}

	/**
	 * Peg this to -1 to keep things simple in testing the tokenizer
	 * This should match the mock in dump_tokens.js.
	 */
	public function newAboutId(): int {
		return -1;
	}
}
