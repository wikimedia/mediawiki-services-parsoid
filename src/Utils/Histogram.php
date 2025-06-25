<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use InvalidArgumentException;
use Wikimedia\Parsoid\Config\SiteConfig;

/**
 * Histogram class is a helper class that creates appropriate histogram buckets
 * for various metrics collected by Parsoid.
 *
 * New histogram metrics can be configured in the constructor.
 */
class Histogram {
	/** @var array */
	private array $parseSizeMetricsMeanSkip;

	private SiteConfig $siteConfig;

	public function __construct( SiteConfig $siteConfig ) {
		$this->siteConfig = $siteConfig;
		$this->parseSizeMetricsMeanSkip = [
			'wt2html_size_input_bytes' => [
				"mean" => 5000,
				"skip" => 4
			],
			'wt2html_size_output_bytes' => [
				"mean" => 50000,
				"skip" => 4
			],
			'wt2html_msPerKB' => [
				"mean" => 0.02,
				"skip" => 4
			],
			'html2wt_size_input_bytes' => [
				"mean" => 17000,
				"skip" => 4
			],
			'html2wt_size_output_bytes' => [
				"mean" => 3500,
				"skip" => 4
			],
			'html2wt_msPerKB' => [
				"mean" => 0.007,
				"skip" => 4
			]
		];
	}

	public function observe( string $name, float $value, array $labels = [] ): void {
		if ( !array_key_exists( $name, $this->parseSizeMetricsMeanSkip ) ) {
			throw new InvalidArgumentException( 'Unsupported metric: ' . $name );
		}
		$mean = $this->parseSizeMetricsMeanSkip[$name]["mean"];
		$skip = $this->parseSizeMetricsMeanSkip[$name]["skip"];
		$buckets = $this->siteConfig->getHistogramBuckets( $mean, $skip );
		$this->siteConfig->observeHistogram( $name, $value, $buckets, $labels );
	}
}
