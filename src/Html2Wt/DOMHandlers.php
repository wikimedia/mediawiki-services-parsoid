<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\JSUtils as JSUtils;

use Parsoid\AHandler as AHandler;
use Parsoid\BodyHandler as BodyHandler;
use Parsoid\BRHandler as BRHandler;
use Parsoid\CaptionHandler as CaptionHandler;
use Parsoid\DDHandler as DDHandler;
use Parsoid\DTHandler as DTHandler;
use Parsoid\FigureHandler as FigureHandler;
use Parsoid\HeadingHandler as HeadingHandler;
use Parsoid\HRHandler as HRHandler;
use Parsoid\HTMLPreHandler as HTMLPreHandler;
use Parsoid\ImgHandler as ImgHandler;
use Parsoid\JustChildrenHandler as JustChildrenHandler;
use Parsoid\LIHandler as LIHandler;
use Parsoid\LinkHandler as LinkHandler;
use Parsoid\ListHandler as ListHandler;
use Parsoid\MediaHandler as MediaHandler;
use Parsoid\MetaHandler as MetaHandler;
use Parsoid\PHandler as PHandler;
use Parsoid\PreHandler as PreHandler;
use Parsoid\SpanHandler as SpanHandler;
use Parsoid\TableHandler as TableHandler;
use Parsoid\TDHandler as TDHandler;
use Parsoid\THHandler as THHandler;
use Parsoid\TRHandler as TRHandler;
use Parsoid\QuoteHandler as QuoteHandler;

/**
 * A map of `domHandler`s keyed on nodeNames.
 *
 * Includes specialized keys of the form: `nodeName + '_' + dp.stx`
 * @namespace
 */
$tagHandlers = JSUtils::mapObject( [
		// '#text': new Text(),  // Insert the text handler here too?
		'a' => new AHandler(),
		'audio' => new MediaHandler(),
		'b' => new QuoteHandler( "'''" ),
		'body' => new BodyHandler(),
		'br' => new BRHandler(),
		'caption' => new CaptionHandler(),
		'dd' => new DDHandler(), // multi-line dt/dd
		'dd_row' => new DDHandler( 'row' ), // single-line dt/dd
		'dl' => new ListHandler( [ 'DT' => 1, 'DD' => 1 ] ),
		'dt' => new DTHandler(),
		'figure' => new FigureHandler(),
		'figure-inline' => new MediaHandler(),
		'hr' => new HRHandler(),
		'h1' => new HeadingHandler( '=' ),
		'h2' => new HeadingHandler( '==' ),
		'h3' => new HeadingHandler( '===' ),
		'h4' => new HeadingHandler( '====' ),
		'h5' => new HeadingHandler( '=====' ),
		'h6' => new HeadingHandler( '======' ),
		'i' => new QuoteHandler( "''" ),
		'img' => new ImgHandler(),
		'li' => new LIHandler(),
		'link' => new LinkHandler(),
		'meta' => new MetaHandler(),
		'ol' => new ListHandler( [ 'LI' => 1 ] ),
		'p' => new PHandler(),
		'pre' => new PreHandler(), // Wikitext indent pre generated with leading space
		'pre_html' => new HTMLPreHandler(), // HTML pre
		'span' => new SpanHandler(),
		'table' => new TableHandler(),
		'tbody' => new JustChildrenHandler(),
		'td' => new TDHandler(),
		'tfoot' => new JustChildrenHandler(),
		'th' => new THHandler(),
		'thead' => new JustChildrenHandler(),
		'tr' => new TRHandler(),
		'ul' => new ListHandler( [ 'LI' => 1 ] ),
		'video' => new MediaHandler()
	]
);

if ( gettype( $module ) === 'object' ) {
	$module->exports->tagHandlers = $tagHandlers;
}
