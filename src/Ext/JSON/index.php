<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This is a demonstration of content model handling in extensions for
 * Parsoid.  It implements the "json" content model, to allow editing
 * JSON data structures using Visual Editor.  It represents the JSON
 * structure as a nested table.
 * @module ext/JSON
 */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 =

$ParsoidExtApi;
$DOMDataUtils = $temp0::DOMDataUtils; $DOMUtils = $temp0::
DOMUtils; $Promise = $temp0::
Promise; $addMetaData = $temp0->
addMetaData;

/**
 * Native Parsoid implementation of the "json" contentmodel.
 * @class
 */
$JSONExt = function () {
	/** @type {Object} */
	$this->config = [
		'contentmodels' => [
			'json' => $this
		]
	];
};

$PARSE_ERROR_HTML =
'<!DOCTYPE html><html>'
.	'<body>'
.	"<table data-mw='{\"errors\":[{\"key\":\"bad-json\"}]}' typeof=\"mw:Error\">"
.	'</body>';

/**
 * JSON to HTML.
 * Implementation matches that from includes/content/JsonContent.php in
 * mediawiki core, except that we add some additional classes to distinguish
 * value types.
 * @param {MWParserEnvironment} env
 * @return {Document}
 * @method
 */
JSONExt::prototype::toHTML = Promise::method( function ( $env ) use ( &$PARSE_ERROR_HTML, &$DOMDataUtils, &$addMetaData ) {
		$document = $env->createDocument( '<!DOCTYPE html><html><body>' );
		$rootValueTable = null;
		$objectTable = null;
		$objectRow = null;
		$arrayTable = null;
		$valueCell = null;
		$primitiveValue = null;
		$src = null;

		$rootValueTable = function ( $parent, $val ) use ( &$arrayTable, &$objectTable, &$primitiveValue ) {
			if ( is_array( $val ) ) {
				// Wrap arrays in another array so they're visually boxed in a
				// container.  Otherwise they are visually indistinguishable from
				// a single value.
				return $arrayTable( $parent, [ $val ] );
			}
			if ( $val && gettype( $val ) === 'object' ) {
				return $objectTable( $parent, $val );
			}
			$parent->innerHTML =
			'<table class="mw-json mw-json-single-value"><tbody><tr><td>';
			return $primitiveValue( $parent->querySelector( 'td' ), $val );
		};
		$objectTable = function ( $parent, $val ) use ( &$objectRow ) {
			$parent->innerHTML = '<table class="mw-json mw-json-object"><tbody>';
			$tbody = $parent->firstElementChild->firstElementChild;
			$keys = Object::keys( $val );
			if ( count( $keys ) ) {
				$keys->forEach( function ( $k ) use ( &$objectRow, &$tbody, &$val ) {
						$objectRow( $tbody, $k, $val[$k] );
				}
				);
			} else {
				$tbody->innerHTML =
				'<tr><td class="mw-json-empty">';
			}
		};
		$objectRow = function ( $parent, $key, $val ) use ( &$document, &$valueCell ) {
			$tr = $document->createElement( 'tr' );
			if ( $key !== null ) {
				$th = $document->createElement( 'th' );
				$th->textContent = $key;
				$tr->appendChild( $th );
			}
			$valueCell( $tr, $val );
			$parent->appendChild( $tr );
		};
		$arrayTable = function ( $parent, $val ) use ( &$objectRow ) {
			$parent->innerHTML = '<table class="mw-json mw-json-array"><tbody>';
			$tbody = $parent->firstElementChild->firstElementChild;
			if ( count( $val ) ) {
				for ( $i = 0;  $i < count( $val );  $i++ ) {
					$objectRow( $tbody, null, $val[$i] );
				}
			} else {
				$tbody->innerHTML =
				'<tr><td class="mw-json-empty">';
			}
		};
		$valueCell = function ( $parent, $val ) use ( &$document, &$arrayTable, &$objectTable, &$primitiveValue ) {
			$td = $document->createElement( 'td' );
			if ( is_array( $val ) ) {
				$arrayTable( $td, $val );
			} elseif ( $val && gettype( $val ) === 'object' ) {
				$objectTable( $td, $val );
			} else {
				$td->classList->add( 'value' );
				$primitiveValue( $td, $val );
			}
			$parent->appendChild( $td );
		};
		$primitiveValue = function ( $parent, $val ) {
			if ( $val === null ) {
				$parent->classList->add( 'mw-json-null' );
			} elseif ( $val === true || $val === false ) {
				$parent->classList->add( 'mw-json-boolean' );
			} elseif ( gettype( $val ) === 'number' ) {
				$parent->classList->add( 'mw-json-number' );
			} elseif ( gettype( $val ) === 'string' ) {
				$parent->classList->add( 'mw-json-string' );
			}
			$parent->textContent = '' . $val;
		};

		try {
			$src = json_decode( $env->page->src );
			$rootValueTable( $document->body, $src );
		} catch ( Exception $e ) {
			$document = $env->createDocument( $PARSE_ERROR_HTML );
		}
		// We're responsible for running the standard DOMPostProcessor on our
		// resulting document.
		if ( $env->pageBundle ) {
			DOMDataUtils::visitAndStoreDataAttribs( $document->body, [
					'storeInPageBundle' => $env->pageBundle,
					'env' => $env
				]
			);
		}
		$addMetaData( $env, $document );
		return $document;
}
);

/**
 * HTML to JSON.
 * @param {MWParserEnvironment} env
 * @param {Node} body
 * @param {boolean} useSelser
 * @return {string}
 * @method
 */
JSONExt::prototype::fromHTML = Promise::method( function ( $env, $body, $useSelser ) use ( &$DOMUtils ) {
		$rootValueTable = null;
		$objectTable = null;
		$objectRow = null;
		$arrayTable = null;
		$valueCell = null;
		$primitiveValue = null;

		Assert::invariant( DOMUtils::isBody( $body ), 'Expected a body node.' );

		$rootValueTable = function ( $el ) use ( &$primitiveValue, &$arrayTable, &$objectTable ) {
			if ( $el->classList->contains( 'mw-json-single-value' ) ) {
				return $primitiveValue( $el->querySelector( 'tr > td' ) );
			} elseif ( $el->classList->contains( 'mw-json-array' ) ) {
				return $arrayTable( $el )[0];
			} else {
				return $objectTable( $el );
			}
		};
		$objectTable = function ( $el ) use ( &$objectRow ) {
			Assert::invariant( $el->classList->contains( 'mw-json-object' ) );
			$tbody = $el;
			if (
				$tbody->firstElementChild
&& $tbody->firstElementChild->tagName === 'TBODY'
			) {
				$tbody = $tbody->firstElementChild;
			}
			$rows = $tbody->children;
			$obj = [];
			$empty = count( $rows ) === 0
|| $rows[0]->firstElementChild
&& $rows[0]->firstElementChild->classList->contains( 'mw-json-empty' );
			if ( !$empty ) {
				for ( $i = 0;  $i < count( $rows );  $i++ ) {
					$objectRow( $rows[$i], $obj, null );
				}
			}
			return $obj;
		};
		$objectRow = function ( $tr, $obj, $key ) use ( &$valueCell ) {
			$td = $tr->firstElementChild;
			if ( $key === null ) {
				$key = $td->textContent;
				$td = $td->nextElementSibling;
			}
			$obj[$key] = $valueCell( $td );
		};
		$arrayTable = function ( $el ) use ( &$objectRow ) {
			Assert::invariant( $el->classList->contains( 'mw-json-array' ) );
			$tbody = $el;
			if (
				$tbody->firstElementChild
&& $tbody->firstElementChild->tagName === 'TBODY'
			) {
				$tbody = $tbody->firstElementChild;
			}
			$rows = $tbody->children;
			$arr = [];
			$empty = count( $rows ) === 0
|| $rows[0]->firstElementChild
&& $rows[0]->firstElementChild->classList->contains( 'mw-json-empty' );
			if ( !$empty ) {
				for ( $i = 0;  $i < count( $rows );  $i++ ) {
					$objectRow( $rows[$i], $arr, $i );
				}
			}
			return $arr;
		};
		$valueCell = function ( $el ) use ( &$arrayTable, &$objectTable, &$primitiveValue ) {
			Assert::invariant( $el->tagName === 'TD' );
			$table = $el->firstElementChild;
			if ( $table && $table->classList->contains( 'mw-json-array' ) ) {
				return $arrayTable( $table );
			} elseif ( $table && $table->classList->contains( 'mw-json-object' ) ) {
				return $objectTable( $table );
			} else {
				return $primitiveValue( $el );
			}
		};
		$primitiveValue = function ( $el ) {
			if ( $el->classList->contains( 'mw-json-null' ) ) {
				return null;
			} elseif ( $el->classList->contains( 'mw-json-boolean' ) ) {
				return preg_match( '/true/', $el->textContent );
			} elseif ( $el->classList->contains( 'mw-json-number' ) ) {
				return +$el->textContent;
			} elseif ( $el->classList->contains( 'mw-json-string' ) ) {
				return '' . $el->textContent;
			} else {
				return null; // shouldn't happen.
			}
		};
		$t = $body->firstElementChild;
		Assert::invariant( $t && $t->tagName === 'TABLE' );
		return json_encode( rootValueTable( $t ), null, 4 );
}
);

if ( gettype( $module ) === 'object' ) {
	$module->exports = $JSONExt;
}
