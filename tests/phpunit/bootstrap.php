<?php
declare( strict_types = 1 );
/**
 * Bootstrapping for Parsoid PHPUnit tests
 */
require_once __DIR__ . '/../../vendor/autoload.php';
define( 'MW_PHPUNIT_TEST', true );
error_reporting( E_ALL );
