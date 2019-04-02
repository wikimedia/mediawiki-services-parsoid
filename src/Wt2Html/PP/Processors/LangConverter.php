<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$LanguageConverter = require '../../../language/LanguageConverter'::LanguageConverter;

/**
 * @class
 */
class LangConverter {
	public function run( $rootNode, $env, $options ) {
		LanguageConverter::maybeConvert(
			$env, $rootNode->ownerDocument,
			$env->htmlVariantLanguage, $env->wtVariantLanguage
		);
	}
}

$module->exports->LangConverter = $LangConverter;
