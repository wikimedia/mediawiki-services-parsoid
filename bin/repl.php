<?php
declare( strict_types = 1 );

require_once __DIR__ . '/../tools/Maintenance.php';

use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\Tools\ParseUtils;
use Wikimedia\Parsoid\Utils\ScriptUtils;

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.WrongCase
class Repl extends ParseUtils {
	private const SUCCESS = 0;
	private const ERROR = -1;

	private array $parsoidOpts = [];
	private array $configOpts = [];
	private string $prompt = "";

	private ?array $lines = null;

	private ?string $latestInput = null;

	private string $mode = "wt2html";

	public function __construct() {
		parent::__construct();
		$this->initParsoid();
	}

	public function initParsoid(): array {
		$this->parsoidOpts = [
			"body_only" => true,
			"wrapSections" => false,
			"logLinterData" => false,
			"pageBundle" => false,
			"nativeTemplateExpansion" => false,
		];
		$this->configOpts = [
			"standalone" => !$this->hasOption( 'integrated' ),
			"apiEndpoint" => "https://en.wikipedia.org/w/api.php",
			"addHTMLTemplateParameters" => false,
			"linting" => false,
			"mock" => false,
			"ensureAccessibleContent" => false,
		];
		$this->setupConfig( $this->configOpts );
		$this->prompt = "parsoid> ";
		$this->lines = null;
		$this->latestInput = null;
		$this->mode = "wt2html";
		return [ self::SUCCESS, null ];
	}

	public function execute() {
		while ( true ) {
			$input = readline( $this->prompt );

			if ( $input === false ) {
				echo PHP_EOL;
				return;
			}

			readline_add_history( $input );

			$status = match ( true ) {
				$input === 'stop multi' => $this->stopMulti(),
				$this->lines !== null => $this->processLine( $input ),
				$input === 'help' => $this->printHelp(),
				$input === 'reset' => $this->initParsoid(),
				$input === 'start multi' => $this->startMulti(),
				$input === 'show input' => $this->showInput(),
				$input === 'exec' => $this->parse(),
				str_starts_with( $input, 'mode=' ) => $this->mode( $input ),
				str_starts_with( $input, 'trace=' ) => $this->trace( $input ),
				str_starts_with( $input, 'debug=' ) => $this->debug( $input ),
				str_starts_with( $input, 'dump=' ) => $this->dump( $input ),
				str_starts_with( $input, 'file=' ) => $this->file( $input ),
				default => $this->processLine( $input )
			};
			if ( $status[1] !== null ) {
				echo $status[1] . PHP_EOL;
			}
		}
	}

	public function printHelp(): array {
		$help = <<<EOD
help -- display this help
reset -- reset all settings to their initial state
show input -- show latest input
start multi -- start multiline input
stop multi -- stop multiline input and parse it
arbitrary string -- run the parser on that string with the active settings
exec -- run the parser on the latest input
trace= -- add tracing options
debug= -- add debugging options
dump= -- add dumping options 
(add "help" to the 3 options above to see the available options)
file=<file> uses the provided file as input; use exec to parse the file in question
EOD;
		return [ self::SUCCESS, $help ];
	}

	public function startMulti(): array {
		$this->lines = [];
		$this->prompt = '~ ';
		return [ self::SUCCESS, null ];
	}

	public function stopMulti(): array {
		$this->latestInput = implode( "\n", $this->lines );
		$res = $this->parse();
		$this->prompt = "parsoid> ";
		$this->lines = null;
		return $res;
	}

	public function processLine( string $input ): array {
		if ( $this->lines !== null ) {
			$this->lines[] = $input;
			return [ self::SUCCESS, null ];
		}
		$this->latestInput = $input;
		return $this->parse();
	}

	public function parse(): array {
		if ( $this->latestInput === null ) {
			return [ self::ERROR, 'No input provided' ];
		}
		switch ( $this->mode ) {
			case "wt2html":
				$this->configOpts["pageContent"] = $this->latestInput;
				$this->setupConfig( $this->configOpts );

				$res = $this->parsoid->wikitext2html( $this->pageConfig, $this->parsoidOpts );

				if ( $res instanceof HtmlPageBundle ) {
					$res = $res->toSingleDocumentHtml( [] );
				}
				return [ self::SUCCESS, $res ];
			case "html2wt":
				$this->setupConfig( $this->configOpts );
				$res = $this->parsoid->html2wikitext( $this->pageConfig, $this->latestInput, $this->parsoidOpts );
				return [ self::SUCCESS, $res ];
			case "wt2wt":
				$this->mode = "wt2html";
				$input = $this->latestInput;
				$this->latestInput = $this->parse()[1];
				$this->mode = "html2wt";
				$res = $this->parse()[1];
				$this->latestInput = $input;
				$this->mode = "wt2wt";
				return [ self::SUCCESS, $res ];
			default:
				return [ self::ERROR, "Unknown mode $this->mode" ];
		}
	}

	public function trace( string $input ): array {
		$input = substr( $input, strlen( 'trace=' ) );
		$res = null;
		if ( $input === "help" ) {
			$res = ScriptUtils::traceUsageHelp();
		} elseif ( $input === '' ) {
			unset( $this->parsoidOpts['traceFlags'] );
		} else {
			ScriptUtils::setDebuggingFlags( $this->parsoidOpts, [ "trace" => $input ] );
		}
		return [ self::SUCCESS, $res ];
	}

	public function debug( string $input ): array {
		$input = substr( $input, strlen( 'debug=' ) );
		$res = null;
		if ( $input === "help" ) {
			$res = ScriptUtils::debugUsageHelp();
		} elseif ( $input === '' ) {
			unset( $this->parsoidOpts['debugFlags'] );
		} else {
			ScriptUtils::setDebuggingFlags( $this->parsoidOpts, [ "debug" => $input ] );
		}
		return [ self::SUCCESS, $res ];
	}

	public function dump( string $input ): array {
		$input = substr( $input, strlen( 'dump=' ) );
		$res = null;
		if ( $input === "help" ) {
			$res = ScriptUtils::dumpUsageHelp();
		} elseif ( $input === '' ) {
			unset( $this->parsoidOpts['dumpFlags'] );
		} else {
			ScriptUtils::setDebuggingFlags( $this->parsoidOpts, [ "dump" => $input ] );
		}
		return [ self::SUCCESS, $res ];
	}

	public function showInput(): array {
		if ( $this->latestInput !== null ) {
			return [ self::SUCCESS, $this->latestInput ];
		}
		return [ self::ERROR, 'No input found' ];
	}

	public function mode( string $input ): array {
		$input = substr( $input, strlen( 'mode=' ) );
		if ( $input === $this->mode ) {
			return( [ self::SUCCESS, null ] );
		}
		// todo we need more subtle stuff than that as soon as we add more options. but let's keep it simple for now.
		$this->initParsoid();
		switch ( $input ) {
			case "wt2html":
			case "html2wt":
			case "wt2wt":
				$this->mode = $input;
				return [ self::SUCCESS, null ];
			default:
				return [ self::ERROR, "Mode $input not implemented" ];
		}
	}

	public function file( string $input ): array {
		$input = substr( $input, strlen( 'file=' ) );
		$file = file_get_contents( $input );
		if ( $file ) {
			$this > $this->latestInput = $file;
			return [ self::SUCCESS, $file ];
		}
		return [ self::ERROR, "Could not open file $file" ];
	}
}

$maintClass = Repl::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
