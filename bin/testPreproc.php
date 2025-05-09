<?php
declare( strict_types = 1 );
require_once __DIR__ . '/../tools/Maintenance.php';

use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Tokens\PreprocTk;
use Wikimedia\Parsoid\Tools\ExtendedOptsProcessor;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.WrongCase
class TestPreproc extends \Wikimedia\Parsoid\Tools\Maintenance {
	use ExtendedOptsProcessor;

	public function __construct() {
		parent::__construct();
		parent::addDefaultParams();
		$this->addOption( 'trace', 'Show peg trace' );
		$this->addOption( 'tokens', 'Show tokens' );
		$this->addDescription( "Test script for preprocessor refactor" );
		$this->setAllowUnregisteredOptions( false );
	}

	public function execute() {
		$env = new MockEnv(
			$this->hasOption( 'trace' ) ?
				[ 'traceFlags' => [ 'grammar' => true ] ] :
				[]
		);
		# $env->setLogger( SiteConfig::createLogger() );
		$pt = new PegTokenizer( $env );
		$exception = null;
		$r = $pt->tokenizeSync(
			# "{{{{foo}}bar}}",
			#"{{foo}bar}} {{{1}}} [[foo -{-{foo}bar}-}}- [foo [[bar]]] [[[foo]bar]]",
			#"{{foo}bar}}",
			#"{{{{x}}}} [[[foo]]]",
			#"{{#foo:bar|bat|baz=barmy|=rah}}",
			# "[[Foo|bar]]",
			#"[http://cscott.net caption]",
			#"<pre>foo</pre>",
			#"[[foo -{-{foo}bar}-}}- [foo [[bar]]] [[[foo]bar]]",
			# "foo -{-{foo}bar}-}}- [foo [[bar]]] [[[foo]bar]]",
			#'{{1x|{{{!}}{{!}}-}}',
			'{{1x|{{{!}}x}}',
			[
				'startRule' => "preproc_pieces",
				'sol' => true,
				'pipelineOffset' => 0,
			], $exception );
		if ( $exception !== null ) {
			throw $exception;
		}
		$r = PreprocTk::newContentsKV( $r, null );
		$result = PreprocTk::printContents( $r );
		echo( "$result\n" );
	}
}

$maintClass = TestPreproc::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
